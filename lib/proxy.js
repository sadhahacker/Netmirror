const axios = require('axios');
const rangeParser = require('range-parser');
const { spawn } = require('child_process');
const { getCookie } = require('./auth');

// Cache M3U8 responses for 10 minutes so variant URLs stay stable.
// Without this, every master re-fetch gives new in= tokens in variant URLs,
// causing the player to reset to segment 0 in an infinite loop.
const m3u8Cache = new Map();
const m3u8Inflight = new Map();
const segmentCache = new Map();
const segmentInflight = new Map();
const M3U8_TTL = 10 * 60 * 1000;
const M3U8_STALE_TTL = 60 * 60 * 1000;
const SEGMENT_TTL = 10 * 60 * 1000;
const SEGMENT_CACHE_LIMIT = 128;
const TRANSIENT_ERROR_CODES = new Set(['EAI_AGAIN', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT']);

function getCachedM3U8(key) {
  const entry = m3u8Cache.get(key);
  if (entry && Date.now() - entry.ts < M3U8_TTL) return entry.content;
  return null;
}

function getStaleCachedM3U8(key) {
  const entry = m3u8Cache.get(key);
  if (entry && Date.now() - entry.ts < M3U8_STALE_TTL) return entry.content;
  return null;
}

function setCachedM3U8(key, content) {
  m3u8Cache.set(key, { content, ts: Date.now() });
}

function setM3U8Headers(res) {
  res.set('Content-Type', 'application/x-mpegurl');
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
}

function getCachedSegment(key) {
  const entry = segmentCache.get(key);
  if (entry && Date.now() - entry.ts < SEGMENT_TTL) return entry;
  if (entry) segmentCache.delete(key);
  return null;
}

function setCachedSegment(key, buf, headers) {
  segmentCache.set(key, { buf, headers, ts: Date.now() });
  if (segmentCache.size > SEGMENT_CACHE_LIMIT) {
    const oldestKey = segmentCache.keys().next().value;
    if (oldestKey) segmentCache.delete(oldestKey);
  }
}

function sendBufferRange(req, res, buf) {
  const rangeHeader = req.headers.range || req.headers['Range'];
  if (!rangeHeader) return false;

  const ranges = rangeParser(buf.length, rangeHeader);
  if (ranges === -1) {
    res.status(416);
    res.set('Content-Range', `bytes */${buf.length}`);
    res.end();
    return true;
  }
  if (ranges === -2 || ranges.length === 0) return false;

  const { start, end } = ranges[0];
  const chunk = buf.slice(start, end + 1);

  res.status(206);
  res.set({
    'Content-Range': `bytes ${start}-${end}/${buf.length}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunk.length
  });
  res.send(chunk);
  return true;
}

function isTransientProxyError(err) {
  return TRANSIENT_ERROR_CODES.has(err.code) || /timeout|EAI_AGAIN/i.test(err.message || '');
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function axiosGetWithRetry(url, options, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isTransientProxyError(err)) break;
      await wait(250 * attempt);
    }
  }
  throw lastErr;
}

function providerCookieFromUrl(targetUrl) {
  if (targetUrl.includes('/mobile/pv/')) return 'pv';
  if (targetUrl.includes('/mobile/hs/')) return 'hs';
  return 'nf';
}

async function getNet52CookieHeader(targetUrl) {
  const tHash = await getCookie();
  return `t_hash_t=${tHash}; hd=on; ott=${providerCookieFromUrl(targetUrl)}`;
}

// Detect variant resolution from URL patterns (e.g. /1080p/, /720p/, /480p/)
const RESOLUTION_MAP = {
  '2160p': { bw: 8000000, res: '3840x2160' },
  '1080p': { bw: 5000000, res: '1920x1080' },
  '720p':  { bw: 2500000, res: '1280x720' },
  '480p':  { bw: 1200000, res: '854x480' },
  '360p':  { bw: 800000,  res: '640x360' },
  '240p':  { bw: 400000,  res: '426x240' },
};

function guessVariantInfo(url) {
  const lower = url.toLowerCase();
  for (const [key, info] of Object.entries(RESOLUTION_MAP)) {
    if (lower.includes(key)) return info;
  }
  return { bw: 2500000, res: '1280x720' };
}

function rewriteM3U8(content, baseUrl, proxyBase) {
  const base = new URL(baseUrl);

  function toProxy(url) {
    let fixedUrl = url;
    if (fixedUrl.startsWith('https:///')) {
      fixedUrl = fixedUrl.replace('https:///', 'https://net52.cc/');
    } else if (fixedUrl.startsWith('http:///')) {
      fixedUrl = fixedUrl.replace('http:///', 'http://net52.cc/');
    }
    const abs = fixedUrl.startsWith('http') ? fixedUrl : new URL(fixedUrl, base).href;
    if (abs.includes('.m3u8')) {
      return `${proxyBase}/stream.m3u8?url=${encodeURIComponent(abs)}`;
    }
    // &_=.ts ensures the URL ends with ".ts" so ffmpeg's av_match_ext (which uses strrchr)
    // picks the MPEG-TS demuxer instead of mjpeg/image2 for .jpg/.js segment files.
    return `${proxyBase}/chunk.ts?url=${encodeURIComponent(abs)}&_=.ts`;
  }

  // Strip \r characters — upstream CDN sometimes sends \r\r\n which corrupts playlists
  const stripped = content.replace(/\r/g, '');

  // Deduplicate: Some upstream servers mistakenly return the M3U8 content concatenated twice
  const secondHeaderIndex = stripped.indexOf('#EXTM3U', 1);
  const cleanContent = secondHeaderIndex !== -1 ? stripped.substring(0, secondHeaderIndex) : stripped;

  // Detect if this is a master playlist (has #EXT-X-MEDIA or multiple .m3u8 variant URLs)
  const lines = cleanContent.split('\n');
  const isMaster = lines.some(l => l.includes('#EXT-X-MEDIA')) ||
                   lines.filter(l => !l.startsWith('#') && l.includes('.m3u8')).length > 1;
  const isVariant = !isMaster && lines.some(l => l.startsWith('#EXTINF'));

  const output = [];
  let prevNonEmptyWasStreamInf = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { output.push(''); continue; }

    // For master playlists: keep every audio rendition so the player can expose
    // all available language tracks.
    if (isMaster && trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('TYPE=AUDIO')) {
      let rewritten = trimmed.replace(/URI="([^"]+)"/g, (_, u) => `URI="${toProxy(u)}"`);
      if (rewritten.includes('DEFAULT=YES') && !rewritten.includes('AUTOSELECT')) {
        rewritten = rewritten.replace('DEFAULT=YES', 'DEFAULT=YES,AUTOSELECT=YES');
      }
      output.push(rewritten);
      prevNonEmptyWasStreamInf = false;
      continue;
    }

    if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
      const rewritten = trimmed.replace(/URI="([^"]+)"/g, (_, u) => `URI="${toProxy(u)}"`);
      output.push(rewritten);
      prevNonEmptyWasStreamInf = false;
      continue;
    }

    // Remove invalid DEFAULT=YES from #EXT-X-STREAM-INF (it's only valid on #EXT-X-MEDIA)
    // Also inject CODECS attribute if missing — players need this to pick the right decoder
    if (trimmed.startsWith('#EXT-X-STREAM-INF')) {
      let cleaned = trimmed.replace(/,?DEFAULT=YES,?/g, ',').replace(/,,/g, ',').replace(/,$/, '');
      if (!cleaned.includes('CODECS=')) {
        cleaned += ',CODECS="avc1.640028,mp4a.40.2"';
      }
      output.push(cleaned);
      prevNonEmptyWasStreamInf = true;
      continue;
    }

    // Bare URL line in a master playlist — inject #EXT-X-STREAM-INF before it only if upstream didn't already provide one
    if (!trimmed.startsWith('#') && isMaster && trimmed.includes('.m3u8')) {
      if (!prevNonEmptyWasStreamInf) {
        const info = guessVariantInfo(trimmed);
        output.push(`#EXT-X-STREAM-INF:BANDWIDTH=${info.bw},RESOLUTION=${info.res},AUDIO="aac",CODECS="avc1.640028,mp4a.40.2"`);
      }
      output.push(toProxy(trimmed));
      prevNonEmptyWasStreamInf = false;
      continue;
    }

    if (!trimmed.startsWith('#')) {
      output.push(toProxy(trimmed));
      prevNonEmptyWasStreamInf = false;
      continue;
    }

    output.push(trimmed);
  }

  // For variant (media) playlists, ensure VOD markers are present
  // Without these, some players treat them as live streams and fail
  if (isVariant) {
    const hasEndList = output.some(l => l.includes('#EXT-X-ENDLIST'));
    const hasPlaylistType = output.some(l => l.includes('#EXT-X-PLAYLIST-TYPE'));
    if (!hasPlaylistType) {
      // Insert after #EXT-X-MEDIA-SEQUENCE or #EXT-X-TARGETDURATION
      const insertIdx = output.findIndex(l => l.startsWith('#EXT-X-MEDIA-SEQUENCE') || l.startsWith('#EXT-X-TARGETDURATION'));
      if (insertIdx !== -1) {
        output.splice(insertIdx + 1, 0, '#EXT-X-PLAYLIST-TYPE:VOD');
      }
    }
    if (!hasEndList) {
      output.push('#EXT-X-ENDLIST');
    }
  }

  return output.join('\n');
}

function setupProxy(app) {
  // Extension-bearing routes help Stremio and hls.js pick the right demuxer.
  app.get(['/proxy', '/proxy/stream.m3u8', '/proxy/chunk.ts', '/proxy/chunk.js', '/proxy/chunk.jpg'], async (req, res) => {
    const targetUrl = typeof req.query.url === 'string' ? req.query.url : null;
    if (!targetUrl) return res.status(400).send('Missing url param');

    console.log('[proxy]', targetUrl.slice(0, 100));

    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, HEAD',
      'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Range',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range'
    });

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }

    try {
      // Serve cached M3U8 immediately (keeps variant URLs stable)
      const cached = getCachedM3U8(targetUrl);
      if (cached) {
        setM3U8Headers(res);
        return res.send(cached);
      }

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 Chrome/144.0 Safari/537.36',
        'Referer': 'https://net52.cc/home',
        'Origin': 'https://net52.cc',
        'X-Requested-With': 'XMLHttpRequest',
      };

      if (targetUrl.includes('net52.cc') || targetUrl.includes('nm-cdn')) {
        headers['Cookie'] = await getNet52CookieHeader(targetUrl);
      }

      const isLikelyM3U8 = targetUrl.includes('.m3u8');

      if (isLikelyM3U8) {
        const proxyBase = `${process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`}/proxy`;

        let inflight = m3u8Inflight.get(targetUrl);
        if (!inflight) {
          inflight = (async () => {
            const upstream = await axiosGetWithRetry(targetUrl, {
              headers,
              responseType: 'arraybuffer',
              decompress: true,
              timeout: 20000,
              maxRedirects: 5,
            });

            const buf = Buffer.from(upstream.data);
            const body = buf.toString('utf8');
            
            const isHTML = body.trimStart().toLowerCase().startsWith('<!doctype') || body.trimStart().toLowerCase().startsWith('<html');
            if (isHTML) {
              console.error('[proxy:WARN] CDN returned HTML instead of M3U8:', targetUrl.slice(0, 100));
              return '#EXTM3U\n#EXT-X-ERROR:CDN returned error\n';
            }

            const rewritten = rewriteM3U8(body, targetUrl, proxyBase);

            setCachedM3U8(targetUrl, rewritten);
            return rewritten;
          })().finally(() => {
            m3u8Inflight.delete(targetUrl);
          });
          m3u8Inflight.set(targetUrl, inflight);
        }

        const rewritten = await inflight;
        setM3U8Headers(res);
        res.send(rewritten);
      } else {
        // For video segments, fetch as arraybuffer to ensure binary integrity 
        // and manually slice the buffer to fulfill Byte-Range requests for Stremio.
        headers['Accept-Encoding'] = 'identity'; // Prevent gzip which completely breaks Range requests

        const rangeHeader = req.headers.range || req.headers['Range'];
        const isCompressedJsSegment = /\.js(?:[?#]|$)/i.test(targetUrl);

        // The CDN serves audio TS bytes behind .js URLs with compressed transfer.
        // Byte ranges on those compressed .js responses decompress to an empty
        // buffer, so fetch the full decoded segment and satisfy Range locally.
        if (rangeHeader && !isCompressedJsSegment) {
          headers['Range'] = rangeHeader;
        }

        let cachedSegment = isCompressedJsSegment ? getCachedSegment(targetUrl) : null;
        let upstream;

        if (cachedSegment) {
          upstream = {
            status: 200,
            headers: cachedSegment.headers,
            data: cachedSegment.buf,
          };
        } else {
          let inflight = isCompressedJsSegment ? segmentInflight.get(targetUrl) : null;
          if (!inflight) {
            inflight = axiosGetWithRetry(targetUrl, {
              headers,
              responseType: 'arraybuffer',
              decompress: true,
              timeout: 20000,
              maxRedirects: 5,
              validateStatus: (s) => s < 400
            }).then(result => {
              const buf = Buffer.from(result.data);
              if (isCompressedJsSegment) {
                setCachedSegment(targetUrl, buf, result.headers);
              }
              return { ...result, data: buf };
            }).finally(() => {
              segmentInflight.delete(targetUrl);
            });

            if (isCompressedJsSegment) {
              segmentInflight.set(targetUrl, inflight);
            }
          }

          upstream = await inflight;
        }

        const buf = Buffer.from(upstream.data);

        // Force correct Content-Type for Stremio. hls.js requires video/mp2t for TS segments.
        const lowerTargetUrl = targetUrl.toLowerCase();
        let contentType = 'video/mp2t';
        
        if (lowerTargetUrl.includes('.srt')) {
          contentType = 'application/x-subrip';
        } else if (lowerTargetUrl.includes('.vtt')) {
          contentType = 'text/vtt';
        } else if (isCompressedJsSegment) {
          contentType = 'video/mp2t';
        } else if (lowerTargetUrl.includes('.jpg') || lowerTargetUrl.includes('.js')) {
          contentType = 'video/mp2t';
        }
        
        res.set('Content-Type', contentType);
        res.set('Accept-Ranges', 'bytes');

        // Cloudflare disables Range requests for dynamically decompressed (.js) files. 
        // If upstream ignored our Range request and returned the full file (200 OK), we must slice it manually.
        if (rangeHeader && (upstream.status === 200 || isCompressedJsSegment)) {
          if (sendBufferRange(req, res, buf)) return;
        }

        // For 206 responses, ensure Content-Range is always present and correct
        if (upstream.status === 206) {
          let contentRange = upstream.headers['content-range'];
          if (!contentRange && rangeHeader) {
            // Upstream returned 206 without Content-Range — calculate it
            const rangeMatch = rangeHeader.match(/bytes=(\d+)-(\d*)/);
            if (rangeMatch) {
              const start = parseInt(rangeMatch[1]);
              const end = rangeMatch[2] ? parseInt(rangeMatch[2]) : buf.length - 1;
              contentRange = `bytes ${start}-${end}/${buf.length}`;
            }
          }
          if (contentRange) res.set('Content-Range', contentRange);
        }

        res.status(upstream.status);
        res.send(buf);
      }
    } catch (err) {
      const stale = getStaleCachedM3U8(targetUrl);
      if (stale && String(targetUrl).includes('.m3u8')) {
        console.warn('[proxy] Serving stale M3U8 after upstream error:', targetUrl.slice(0, 80), '-', err.message);
        setM3U8Headers(res);
        return res.send(stale);
      }

      console.error('[proxy] Error:', targetUrl.slice(0, 80), '-', err.message);
      res.status(502).send('Proxy error: ' + err.message);
    }
  });

  console.log('[proxy] /proxy route registered');

  // Remux demuxed HLS (separate video+audio tracks) into a single MPEG-TS stream via ffmpeg.
  // We pre-fetch the master M3U8 in Node.js to extract just the best video variant + one
  // audio rendition, then feed those two URLs to ffmpeg as separate inputs.
  // Passing the full master directly to ffmpeg makes it probe all 9 streams (3 video
  // qualities × 6 audio language tracks), stalling output long enough for Stremio to time out.
  app.get('/remux', async (req, res) => {
    const masterUrl = req.query.url;
    if (!masterUrl) return res.status(400).send('Missing url');

    console.log('[remux]', masterUrl.slice(0, 80));

    try {
      // Fetch the original master M3U8 directly from net52.cc with auth.
      // CDN segment/playlist URLs don't need the cookie, so we give ffmpeg
      // those direct CDN URLs — no proxy hop per segment.
      const tHash = await getCookie();
      const { data: masterText } = await axios.get(masterUrl, {
        headers: {
          Cookie: `t_hash_t=${tHash}; hd=on`,
          'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 Chrome/144.0 Safari/537.36',
          Referer: 'https://net52.cc/home',
        },
        responseType: 'text',
        timeout: 15000,
        maxRedirects: 5,
      });

      let videoUrl = null;
      let audioUrl = null;
      let bestBw = 0;
      let pendingBw = 0;

      for (const rawLine of masterText.split('\n')) {
        const line = rawLine.trim();

        if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO') && line.includes('DEFAULT=YES') && !audioUrl) {
          const m = line.match(/URI="([^"]+)"/);
          if (m) audioUrl = m[1].startsWith('http') ? m[1] : new URL(m[1], masterUrl).href;
          continue;
        }

        if (line.startsWith('#EXT-X-STREAM-INF')) {
          const bwM = line.match(/BANDWIDTH=(\d+)/);
          pendingBw = bwM ? parseInt(bwM[1]) : 1;
          continue;
        }

        if (!line.startsWith('#') && pendingBw > 0) {
          if (pendingBw > bestBw) {
            bestBw = pendingBw;
            videoUrl = line.startsWith('http') ? line : new URL(line, masterUrl).href;
          }
          pendingBw = 0;
          continue;
        }

        if (line && !line.startsWith('#')) pendingBw = 0;
      }

      if (!audioUrl) {
        console.log('[remux] No audio track found, serving direct video via proxy');
        return res.status(400).send('No audio remux available - use proxy instead');
      }

      console.log('[remux] video:', videoUrl.slice(0, 80));
      if (audioUrl) console.log('[remux] audio:', audioUrl.slice(0, 80));

      res.set({ 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*' });

      const ffArgs = [
        '-loglevel', 'error',
        '-allowed_extensions', 'ALL',
        '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
        '-fflags', '+nobuffer+genpts',
        '-probesize', '32768',
        '-analyzeduration', '0',
      ];

      ffArgs.push('-i', videoUrl, '-i', audioUrl);
      ffArgs.push('-map', '0:v:0', '-map', '1:a:0');
      ffArgs.push(
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-muxdelay', '0',
        '-muxpreload', '0',
        '-flags', 'low_delay',
        '-f', 'mpegts',
        'pipe:1',
      );

      const ff = spawn('ffmpeg', ffArgs, {
        env: { ...process.env, DISPLAY: '', SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      ff.stdout.pipe(res);
      ff.stderr.on('data', d => console.error('[remux]', d.toString().trimEnd()));
      ff.on('error', err => {
        console.error('[remux] spawn err:', err.message);
        if (!res.headersSent) res.status(500).end();
      });
      req.on('close', () => ff.kill('SIGKILL'));

    } catch (err) {
      console.error('[remux] error:', err.message);
      if (!res.headersSent) res.status(500).end();
    }
  });

  console.log('[proxy] /remux route registered');

  // ─── Muxed HLS endpoint ───
  // Generates a single-track muxed HLS playlist.
  // Instead of serving demuxed HLS (separate video+audio streams that many players can't handle),
  // this fetches both the video and audio variant playlists, pairs up their segments,
  // and creates a new playlist where each segment URL points to /muxed/segment.ts
  // which muxes the video+audio segment pair on-the-fly via ffmpeg.
  const muxedPlaylistCache = new Map();
  const MUXED_TTL = 10 * 60 * 1000;

  app.get('/muxed/master.m3u8', async (req, res) => {
    const masterUrl = req.query.url;
    if (!masterUrl) return res.status(400).send('Missing url');

    const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
    const quality = req.query.q || 'best';

    console.log('[muxed] master request for', masterUrl.slice(0, 80));

    try {
      const tHash = await getCookie();
      const cookieHeader = `t_hash_t=${tHash}; hd=on`;
      const reqHeaders = {
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 Chrome/144.0 Safari/537.36',
        Referer: 'https://net52.cc/home',
      };

      const { data: masterText } = await axios.get(masterUrl, {
        headers: reqHeaders, responseType: 'text', timeout: 15000, maxRedirects: 5,
      });

      // Parse master playlist to find video variants and audio rendition
      let audioUrl = null;
      const variants = [];
      let pendingInf = null;

      for (const rawLine of masterText.split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO') && line.includes('DEFAULT=YES') && !audioUrl) {
          const m = line.match(/URI="([^"]+)"/);
          if (m) audioUrl = m[1].startsWith('http') ? m[1] : new URL(m[1], masterUrl).href;
          continue;
        }

        if (line.startsWith('#EXT-X-STREAM-INF')) {
          pendingInf = line;
          continue;
        }

        if (pendingInf && !line.startsWith('#')) {
          const url = line.startsWith('http') ? line : new URL(line, masterUrl).href;
          const bwM = pendingInf.match(/BANDWIDTH=(\d+)/);
          const resM = pendingInf.match(/RESOLUTION=(\S+)/);
          variants.push({
            url,
            bandwidth: bwM ? parseInt(bwM[1]) : 0,
            resolution: resM ? resM[1].replace(/,.*/, '') : '1280x720',
            inf: pendingInf,
          });
          pendingInf = null;
          continue;
        }
      }

      if (variants.length === 0) {
        return res.status(502).send('No video variants found in master playlist');
      }

      // If no separate audio, just redirect to the HLS proxy instead
      if (!audioUrl) {
        console.log('[muxed] No separate audio, redirecting to HLS proxy');
        const proxyUrl = `${serverUrl}/proxy/stream.m3u8?url=${encodeURIComponent(masterUrl)}`;
        return res.redirect(302, proxyUrl);
      }

      // Build a single-track master that points to our muxed playlist endpoint
      const output = ['#EXTM3U', '#EXT-X-VERSION:3'];

      for (const v of variants) {
        // Strip AUDIO= reference since we're muxing audio into the video segments
        let inf = v.inf
          .replace(/,?AUDIO="[^"]*"/g, '')
          .replace(/,?DEFAULT=YES/g, '');
        if (!inf.includes('CODECS=')) {
          inf += ',CODECS="avc1.640028,mp4a.40.2"';
        }
        output.push(inf);
        output.push(`${serverUrl}/muxed/playlist.m3u8?video=${encodeURIComponent(v.url)}&audio=${encodeURIComponent(audioUrl)}`);
      }

      setM3U8Headers(res);
      res.send(output.join('\n') + '\n');

    } catch (err) {
      console.error('[muxed] master error:', err.message);
      res.status(502).send('Failed to fetch master playlist');
    }
  });

  app.get('/muxed/playlist.m3u8', async (req, res) => {
    const videoPlaylistUrl = req.query.video;
    const audioPlaylistUrl = req.query.audio;
    if (!videoPlaylistUrl || !audioPlaylistUrl) return res.status(400).send('Missing video/audio param');

    const cacheKey = `${videoPlaylistUrl}|${audioPlaylistUrl}`;
    const cached = muxedPlaylistCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < MUXED_TTL) {
      setM3U8Headers(res);
      return res.send(cached.content);
    }

    const serverUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;

    console.log('[muxed] building playlist from', videoPlaylistUrl.slice(0, 60));

    try {
      // Fetch both video and audio variant playlists
      const [videoRes, audioRes] = await Promise.all([
        axiosGetWithRetry(videoPlaylistUrl, { responseType: 'text', timeout: 15000, decompress: true }),
        axiosGetWithRetry(audioPlaylistUrl, { responseType: 'text', timeout: 15000, decompress: true }),
      ]);

      const videoLines = videoRes.data.replace(/\r/g, '').split('\n');
      const audioLines = audioRes.data.replace(/\r/g, '').split('\n');

      // Parse video segments
      const videoSegments = [];
      let currentDuration = 0;
      for (const line of videoLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF:')) {
          const m = trimmed.match(/#EXTINF:([\d.]+)/);
          currentDuration = m ? parseFloat(m[1]) : 10;
        } else if (trimmed && !trimmed.startsWith('#')) {
          const url = trimmed.startsWith('http') ? trimmed : new URL(trimmed, videoPlaylistUrl).href;
          videoSegments.push({ url, duration: currentDuration });
          currentDuration = 0;
        }
      }

      // Parse audio segments
      const audioSegments = [];
      currentDuration = 0;
      for (const line of audioLines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#EXTINF:')) {
          const m = trimmed.match(/#EXTINF:([\d.]+)/);
          currentDuration = m ? parseFloat(m[1]) : 10;
        } else if (trimmed && !trimmed.startsWith('#')) {
          const url = trimmed.startsWith('http') ? trimmed : new URL(trimmed, audioPlaylistUrl).href;
          audioSegments.push({ url, duration: currentDuration });
          currentDuration = 0;
        }
      }

      // Extract target duration from video playlist
      const tdMatch = videoRes.data.match(/#EXT-X-TARGETDURATION:(\d+)/);
      const targetDuration = tdMatch ? parseInt(tdMatch[1]) : 20;

      console.log(`[muxed] ${videoSegments.length} video + ${audioSegments.length} audio segments`);

      // Build a muxed playlist — each segment URL is a /muxed/segment.ts call
      // that combines one video + one audio segment via ffmpeg
      const output = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        `#EXT-X-TARGETDURATION:${targetDuration}`,
        '#EXT-X-MEDIA-SEQUENCE:0',
        '#EXT-X-PLAYLIST-TYPE:VOD',
      ];

      // Map video segments to audio segments using time-based mapping
      // Video and audio segments often have different durations, so we map by index
      // (net52.cc always has 1:1 or close mapping)
      for (let i = 0; i < videoSegments.length; i++) {
        const vs = videoSegments[i];
        // Map to closest audio segment by index (audio segments are usually ~10s each)
        const audioIdx = Math.min(i, audioSegments.length - 1);
        const as = audioSegments[audioIdx];

        output.push(`#EXTINF:${vs.duration.toFixed(6)},`);
        output.push(
          `${serverUrl}/muxed/segment.ts?v=${encodeURIComponent(vs.url)}&a=${encodeURIComponent(as.url)}`
        );
      }

      output.push('#EXT-X-ENDLIST');

      const content = output.join('\n') + '\n';
      muxedPlaylistCache.set(cacheKey, { content, ts: Date.now() });

      setM3U8Headers(res);
      res.send(content);

    } catch (err) {
      console.error('[muxed] playlist error:', err.message);
      res.status(502).send('Failed to build muxed playlist');
    }
  });

  // Mux a single video + audio segment pair into one MPEG-TS segment via ffmpeg
  app.get('/muxed/segment.ts', async (req, res) => {
    const videoUrl = req.query.v;
    const audioUrl = req.query.a;
    if (!videoUrl || !audioUrl) return res.status(400).send('Missing v/a params');

    res.set({
      'Content-Type': 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
    });

    try {
      // Download both segments in parallel
      const [videoBuf, audioBuf] = await Promise.all([
        axiosGetWithRetry(videoUrl, { responseType: 'arraybuffer', timeout: 20000, decompress: true })
          .then(r => Buffer.from(r.data)),
        axiosGetWithRetry(audioUrl, { responseType: 'arraybuffer', timeout: 20000, decompress: true })
          .then(r => Buffer.from(r.data)),
      ]);

      // Use ffmpeg to mux: pipe both segments via concat demuxer, output muxed TS
      const { execSync } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');

      // Write segments to temp files for ffmpeg
      const tmpDir = path.join(os.tmpdir(), 'muxed-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
      fs.mkdirSync(tmpDir, { recursive: true });
      const vFile = path.join(tmpDir, 'video.ts');
      const aFile = path.join(tmpDir, 'audio.ts');
      fs.writeFileSync(vFile, videoBuf);
      fs.writeFileSync(aFile, audioBuf);

      try {
        const ffArgs = [
          'ffmpeg', '-y', '-loglevel', 'error',
          '-i', vFile, '-i', aFile,
          '-map', '0:v:0', '-map', '1:a:0',
          '-c', 'copy',
          '-f', 'mpegts',
          '-avoid_negative_ts', 'make_zero',
          'pipe:1',
        ];

        const muxed = execSync(ffArgs.join(' '), {
          maxBuffer: 50 * 1024 * 1024, // 50MB max per segment
          timeout: 30000,
          env: { ...process.env, DISPLAY: '' },
        });

        res.send(muxed);
      } finally {
        // Cleanup temp files
        try { fs.unlinkSync(vFile); } catch {}
        try { fs.unlinkSync(aFile); } catch {}
        try { fs.rmdirSync(tmpDir); } catch {}
      }
    } catch (err) {
      console.error('[muxed] segment error:', err.message);
      if (!res.headersSent) res.status(502).send('Segment mux failed');
    }
  });

  console.log('[proxy] /muxed routes registered');
}

module.exports = { setupProxy };
