/**
 * NewTV API client — mirrors the new approach from CNCVerse GitHub (2026-05-22).
 *
 * Flow:
 *  1. Hit one of the mobidetect.* domains at /checknewtv.php
 *  2. Decode the base64 `token_hash` to get the real API base URL (e.g. https://tv.imgcdn.kim)
 *  3. Call `{apiBase}/newtv/player.php?id={id}` with `Ott: nf` header
 *  4. Returns { status, video_link, referer } — direct, stable Cloudflare-backed HLS URL
 *  5. Fetch the master M3U8 to extract quality variants and subtitle VTT URLs
 */

const axios = require('axios');

// Base64-encoded discovery domains (same list as Utils.kt newTvDomains)
const DISCOVERY_DOMAINS_B64 = [
  'aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==',
  'aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5hcnQ=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5jYw==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbmZv',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbms=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5saXZl',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5wcm8=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy5zdG9yZQ==',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy50b3A=',
  'aHR0cHM6Ly9tb2JpZGV0ZWN0cy54eXo=',
];

const NEW_TV_HEADERS = {
  'Cache-Control': 'no-cache, no-store, must-revalidate',
  'Pragma': 'no-cache',
  'Expires': '0',
  'X-Requested-With': 'NetmirrorNewTV v1.0',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0',
  'Accept': 'application/json, text/plain, */*',
};

function decodeB64(s) {
  return Buffer.from(s, 'base64').toString('utf8');
}

// Cached resolved API base URL (valid until process restart or explicit refresh)
let resolvedApiUrl = '';
let resolvePromise = null;

async function resolveApiUrl() {
  if (resolvedApiUrl) return resolvedApiUrl;
  if (resolvePromise) return resolvePromise;

  resolvePromise = (async () => {
    for (const encoded of DISCOVERY_DOMAINS_B64) {
      const base = decodeB64(encoded).replace(/\/+$/, '');
      try {
        const res = await axios.get(`${base}/checknewtv.php`, {
          headers: NEW_TV_HEADERS,
          timeout: 6000,
        });
        const tokenHash = res.data?.token_hash;
        if (tokenHash) {
          const apiBase = decodeB64(tokenHash).replace(/\/+$/, '');
          console.log(`[newtv] Resolved API base: ${apiBase}`);
          resolvedApiUrl = apiBase;
          resolvePromise = null;
          return apiBase;
        }
      } catch (_) {
        // Try next domain
      }
    }
    resolvePromise = null;
    throw new Error('[newtv] Failed to resolve NewTV API base URL from any discovery domain');
  })();

  return resolvePromise;
}

/**
 * Parse a master HLS playlist and extract:
 *  - variants: [{ url, resolution, bandwidth, label }]
 *  - subtitles: [{ url, lang, name }]  ← VTT URLs resolved from subtitle M3U8s
 */
async function parseMasterM3U8(m3u8Url, referer) {
  const res = await axios.get(m3u8Url, {
    headers: { 'Referer': referer },
    timeout: 10000,
  });

  const text = typeof res.data === 'string' ? res.data : res.data.toString();
  const lines = text.replace(/\r/g, '').split('\n');
  const base = new URL(m3u8Url);

  const variants = [];
  const subtitleTracks = [];
  let audioUrl = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Extract subtitle tracks: #EXT-X-MEDIA:TYPE=SUBTITLES,...,URI="..."
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=SUBTITLES')) {
      const nameMatch  = line.match(/NAME="([^"]+)"/);
      const langMatch  = line.match(/LANGUAGE="([^"]+)"/);
      const uriMatch   = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const subM3u8Url = uriMatch[1].startsWith('http') ? uriMatch[1] : new URL(uriMatch[1], base).href;
        subtitleTracks.push({
          subM3u8Url,
          lang: langMatch?.[1] || 'und',
          name: nameMatch?.[1] || 'Unknown',
        });
      }
    }

    // Extract audio tracks if present (demuxed HLS)
    if (line.startsWith('#EXT-X-MEDIA') && line.includes('TYPE=AUDIO')) {
      const uriMatch = line.match(/URI="([^"]+)"/);
      if (uriMatch) {
        const aUrl = uriMatch[1].startsWith('http') ? uriMatch[1] : new URL(uriMatch[1], base).href;
        // Prefer DEFAULT=YES or take the first one
        if (!audioUrl || line.includes('DEFAULT=YES')) {
          audioUrl = aUrl;
        }
      }
    }

    // Extract quality variants: #EXT-X-STREAM-INF followed by URL
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const resMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      const bwMatch  = line.match(/BANDWIDTH=(\d+)/);
      const nextLine = lines[i + 1]?.trim();
      if (nextLine && !nextLine.startsWith('#')) {
        const varUrl = nextLine.startsWith('http') ? nextLine : new URL(nextLine, base).href;
        const resolution = resMatch?.[1] || '';
        const height = resolution ? parseInt(resolution.split('x')[1]) : 0;
        variants.push({
          url: varUrl,
          resolution,
          bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
          label: height ? `${height}p` : 'Auto',
        });
        i++; // skip next line (the URL)
      }
    }
  }

  // Derive VTT URL by replacing .m3u8 with .vtt — subscdn.top always follows this pattern,
  // so we avoid fetching each subtitle M3U8 individually (52 requests → 0).
  const subtitles = subtitleTracks.map(track => ({
    url:  track.subM3u8Url.replace(/\.m3u8(\?.*)?$/, '.vtt'),
    lang: track.lang,
    name: track.name,
  }));

  return { variants, subtitles, audioUrl };
}

/**
 * A subtitle "M3U8" from subscdn.top is really just a tiny playlist
 * with one segment pointing to a .vtt file. Resolve it to the actual VTT URL.
 */
async function resolveSubtitleVtt(subM3u8Url, referer) {
  const res = await axios.get(subM3u8Url, {
    headers: { 'Referer': referer },
    timeout: 8000,
  });
  const text = typeof res.data === 'string' ? res.data : res.data.toString();
  const base = new URL(subM3u8Url);

  for (const line of text.replace(/\r/g, '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // This is the actual segment URL (the .vtt file)
    return trimmed.startsWith('http') ? trimmed : new URL(trimmed, base).href;
  }
  return null;
}

/**
 * Get stream data for a content ID.
 * Returns:
 *  - variants:   quality variants sorted best→worst [{ url, label, resolution }]
 *  - subtitles:  VTT subtitle files [{ url, lang, name }]
 *  - referer:    referer header needed for CDN requests
 */
async function getNewTvStream(id, ott = 'nf') {
  const apiBase = await resolveApiUrl();
  const url = `${apiBase}/newtv/player.php?id=${id}`;
  const headers = { ...NEW_TV_HEADERS, 'Ott': ott, 'Usertoken': '' };

  const res = await axios.get(url, { headers, timeout: 10000 });
  const data = res.data;

  if (!data || data.status !== 'ok' || !data.video_link) {
    throw new Error(`[newtv] Player API returned status="${data?.status}" for id=${id}`);
  }

  const videoLink = data.video_link;
  const referer   = data.referer || apiBase;

  // Parse the master M3U8 to get quality variants + subtitles
  const { variants, subtitles, audioUrl } = await parseMasterM3U8(videoLink, referer);

  // Sort variants best quality first
  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  return {
    videoLink,
    referer,
    variants,
    subtitles,
    audioUrl,
    title:   data.title,
    epTitle: data.ep_title,
  };
}

/** Force re-resolve on next call (e.g. if video_link starts failing) */
function resetApiUrl() {
  resolvedApiUrl = '';
  resolvePromise = null;
}

module.exports = { getNewTvStream, resolveApiUrl, resetApiUrl };
