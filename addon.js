const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const PROVIDERS = require('./providers/config');
const { getHomePage, searchContent, getPost, getEpisodes, getPlaylist, getImgUrl, fullStreamUrl } = require('./lib/api');
const { getNewTvStream, resetApiUrl } = require('./lib/newtv');

const manifest = {
  id: 'community.netmirror.ott',
  version: '1.2.0',
  name: 'NetMirror',
  description: 'NetMirror catalogs, metadata, and streams directly in Stremio',
  resources: ['catalog', 'meta', 'stream'],
  types: ['movie', 'series', 'netflix', 'prime', 'hotstar', 'disney'],
  catalogs: [
    { id: 'netmirror_netflix', name: 'NetMirror', type: 'netflix', extra: [{ name: 'search', isRequired: false }] },
    { id: 'netmirror_prime', name: 'NetMirror', type: 'prime', extra: [{ name: 'search', isRequired: false }] },
    { id: 'netmirror_hotstar', name: 'NetMirror', type: 'hotstar', extra: [{ name: 'search', isRequired: false }] },
    { id: 'netmirror_disney', name: 'NetMirror', type: 'disney', extra: [{ name: 'search', isRequired: false }] },
  ],
  idPrefixes: ['tt', 'netmirror:'],
  behaviorHints: {
    adult: false,
    p2p: false,
    proxyHeaders: {
      request: {
        'Cookie': 'hd=on',
        'Referer': 'https://net52.cc/',
        'Origin': 'https://net52.cc'
      }
    }
  },
};

const builder = new addonBuilder(manifest);
const PROVIDER_IDS = Object.keys(PROVIDERS).filter(pid => !['marvel', 'starwars', 'pixar'].includes(pid));

function parseId(id) {
  const parts = id.split(':');
  if (parts[0] !== 'netmirror' || parts.length < 3) return null;
  const provider = parts[1];
  if (parts[2] === 'ep') return { provider, isEpisode: true,  targetId: parts[3] };
  return                        { provider, isEpisode: false, targetId: parts[2] };
}
function parseSeason(s)  { const m = String(s || '').match(/\d+/); return m ? parseInt(m[0]) : 1; }
function parseEp(ep)     { const m = String(ep || '').match(/\d+/); return m ? parseInt(m[0]) : 1; }

function parseStremioId(id) {
  const match = String(id || '').match(/^(tt\d+)(?::(\d+):(\d+))?$/);
  if (!match) return null;
  return {
    imdbId: match[1],
    season: match[2] ? parseInt(match[2], 10) : null,
    episode: match[3] ? parseInt(match[3], 10) : null,
  };
}

function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function pickSearchMatch(results, title, type) {
  const wanted = normalizeTitle(title);
  if (!wanted) return null;

  // Filter based on requested type to avoid movie/series mismatches
  const filtered = results.filter(r => {
    const isSeries = r.r === 'Series';
    if (type === 'series') return isSeries;
    if (type === 'movie') return !isSeries;
    return true;
  });

  const candidates = filtered.length > 0 ? filtered : results;

  return candidates.find(r => normalizeTitle(r.t) === wanted)
    || candidates.find(r => {
      const candidate = normalizeTitle(r.t);
      return candidate.includes(wanted) || wanted.includes(candidate);
    })
    || null;
}

const cinemetaCache = new Map();
const CINEMETA_TTL = 24 * 60 * 60 * 1000; // 24 hours

async function getTitleFromImdb(type, imdbId) {
  const cached = cinemetaCache.get(imdbId);
  if (cached && Date.now() - cached.ts < CINEMETA_TTL) {
    return cached.title;
  }

  try {
    const res = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 8000 }
    );
    const title = res.data?.meta?.name || null;
    if (title) {
      cinemetaCache.set(imdbId, { title, ts: Date.now() });
    }
    return title;
  } catch (e) {
    return null;
  }
}

function makeProxyUrl(streamUrl) {
  const serverUrl = process.env.SERVER_URL || 'http://127.0.0.1:7000';
  const isM3U8 = String(streamUrl).includes('.m3u8');
  const encoded = encodeURIComponent(streamUrl);
  return isM3U8
    ? `${serverUrl}/proxy/stream.m3u8?url=${encoded}`
    : `${serverUrl}/proxy/chunk.ts?url=${encoded}`;
}

const SUBTITLE_LANGS = {
  english: 'eng',
  hindi: 'hin',
  tamil: 'tam',
  telugu: 'tel',
  malayalam: 'mal',
  kannada: 'kan',
  bengali: 'ben',
  marathi: 'mar',
  gujarati: 'guj',
  punjabi: 'pan',
  urdu: 'urd',
};

function subtitleLang(label) {
  const normalized = String(label || '').toLowerCase().replace(/[^a-z]/g, '');
  return SUBTITLE_LANGS[normalized] || label || 'und';
}

function buildStreams(items, cfgName) {
  const streams = [];

  for (const item of items) {
    const subtitles = (item.tracks || [])
      .filter(t => t.kind === 'captions' || t.kind === 'subtitles')
      .map(t => {
        const fullSubUrl = fullStreamUrl(t.file);
        return {
          url: fullSubUrl ? makeProxyUrl(fullSubUrl) : t.file,
          lang: subtitleLang(t.label),
          id: `sub_${t.label}`
        };
      });

    const sources = item.sources || [];
    if (sources.length === 0) continue;

    // Find the master playlist (usually labeled 'Auto')
    const masterSrc = sources.find(src => String(src.label || '').toLowerCase() === 'auto') || sources[0];

    const rawUrl = fullStreamUrl(masterSrc.file);
    if (!rawUrl) continue;

    const streamLabel = cfgName;
    streams.push({
      url: makeProxyUrl(rawUrl),
      title: streamLabel,
      subtitles,
    });
  }

  return streams;
}

/**
 * Build Stremio stream entries via the new NewTV API.
 *
 * Strategy: route the master M3U8 through our proxy as a SINGLE stream.
 * rewriteM3U8 handles two cases automatically:
 *  - Muxed HLS (freecdn1.top / Mersal): no TYPE=AUDIO → variant URLs proxied
 *    normally, .jpg/.js segments served as video/mp2t with correct audio intact.
 *  - Demuxed HLS (nm-cdn7.top / The Boys): TYPE=AUDIO present → hasDemuxedAudio=true,
 *    video variants rewritten to /muxed/playlist.m3u8 so ffmpeg muxes audio in.
 *
 * Returning per-variant URLs (the old approach) broke demuxed audio because Stremio
 * received a variant-level playlist without the master's EXT-X-MEDIA audio group
 * definitions, so the player had no audio track to select.
 */
async function buildNewTvStream(contentId, ott, cfgName) {
  try {
    const { variants, subtitles, videoLink, title, epTitle } = await getNewTvStream(contentId, ott);
    console.log(`[newtv] ${variants.length} variants, ${subtitles.length} subtitles for ${contentId}`);

    // Map subtitle VTT URLs through our proxy so CORS is not an issue
    const serverUrl = process.env.SERVER_URL || 'http://127.0.0.1:7000';
    const stremioSubtitles = subtitles.map(s => ({
      url:  `${serverUrl}/proxy/subtitle.vtt?url=${encodeURIComponent(s.url)}`,
      lang: s.lang,
      id:   `sub_${s.lang}_${s.name}`,
    }));

    const contentTitle = epTitle ? `${title} - ${epTitle}` : (title || '');

    const streams = [];
    for (const v of variants) {
      const proxyUrl = `${serverUrl}/proxy/stream.m3u8?url=${encodeURIComponent(videoLink)}&q=${encodeURIComponent(v.label)}${contentTitle ? `&title=${encodeURIComponent(contentTitle)}` : ''}`;
      streams.push({
        url:       proxyUrl,
        title:     `${cfgName} (${v.label})`,
        subtitles: stremioSubtitles,
        behaviorHints: { notWebReady: false },
      });
    }

    if (streams.length === 0 && videoLink) {
      streams.push({
        url:       `${serverUrl}/proxy/stream.m3u8?url=${encodeURIComponent(videoLink)}${contentTitle ? `&title=${encodeURIComponent(contentTitle)}` : ''}`,
        title:     cfgName,
        subtitles: stremioSubtitles,
        behaviorHints: { notWebReady: false },
      });
    }

    return streams.length > 0 ? streams : null;
  } catch (e) {
    console.warn(`[newtv] Failed for ${contentId}: ${e.message}`);
    if (e.message && e.message.includes('status=')) resetApiUrl();
    return null;
  }
}

async function collectEpisodes(post, seriesId, cfg, targetSeason) {
  const videos = [];
  const seasons = post.season || [];

  if (seasons.length > 0) {
    // If a target season is specified, only fetch episodes for that season
    const targetSeasons = targetSeason
      ? seasons.filter(s => parseSeason(s.s) === targetSeason)
      : seasons;

    for (const season of targetSeasons) {
      let page = 1, hasMore = true;
      while (hasMore && page <= 20) {
        try {
          const epData = await getEpisodes(season.id, seriesId, page, cfg);
          const episodes = Array.isArray(epData) ? epData : (epData?.episodes || []);
          videos.push(...episodes);
          hasMore = !Array.isArray(epData) && epData?.nextPageShow === 1;
          page++;
        } catch (e) {
          break;
        }
      }
    }
  } else if (post.episodes && post.episodes.filter(Boolean).length > 0) {
    videos.push(...post.episodes.filter(Boolean));
  }

  return videos;
}

async function streamsForTitle(title, type, opts = {}) {
  const promises = PROVIDER_IDS.map(async (pid) => {
    try {
      const cfg = PROVIDERS[pid];
      const data = await searchContent(title, cfg);
      const results = data?.searchResult || [];
      const match = pickSearchMatch(results, title, type);

      if (!match) return [];

      let contentId = match.id;

      if (type === 'series' && opts.season && opts.episode) {
        const post = await getPost(match.id, cfg);
        const episodes = await collectEpisodes(post, match.id, cfg, opts.season);
        const episode = episodes.find(ep =>
          parseSeason(ep.s) === opts.season && parseEp(ep.ep) === opts.episode
        );

        if (!episode) return [];
        contentId = episode.id;
      }

      // 1. Try the new NewTV API first (stable Cloudflare CDN, no domain drift)
      const newTvStreams = await buildNewTvStream(contentId, cfg.ott, cfg.name);
      if (newTvStreams && newTvStreams.length > 0) return newTvStreams;

      // 2. Fall back to legacy playlist.php + proxy chain
      console.log(`[stream] NewTV unavailable for ${contentId}, falling back to playlist.php`);
      const pl = await getPlaylist(contentId, match.t || title, cfg);
      const items = Array.isArray(pl) ? pl : [pl];
      return buildStreams(items, cfg.name);
    } catch (e) {
      return [];
    }
  });

  const results = await Promise.all(promises);
  const streams = [];
  for (const list of results) {
    streams.push(...list);
  }

  return streams;
}

builder.defineCatalogHandler(async ({ type, id, extra }) => {
  console.log(`[catalog] id="${id}" type="${type}" extra=`, extra);

  const query = extra?.search || '';

  // Gracefully handle old catalog IDs from Stremio's cached manifest
  const isOldCatalog = id === 'netmirror_movies' || id === 'netmirror_series';
  
  // Extract provider ID
  let providerId = 'netflix';
  if (isOldCatalog) {
    providerId = 'netflix'; // fallback
  } else {
    const idParts = id.split('_');
    providerId = idParts[1] || 'netflix';
  }

  const cfg = PROVIDERS[providerId];
  if (!cfg) return { metas: [] };

  try {
    let items = [];
    if (query) {
      if (isOldCatalog) {
        // Old catalog search: query all providers in parallel to ensure backward compatibility
        console.log(`[catalog] Old catalog search: querying all providers for "${query}"...`);
        const searchProviders = ['netflix', 'prime', 'hotstar', 'disney'];
        const searchPromises = searchProviders.map(async (pid) => {
          try {
            const searchRes = await searchContent(query, PROVIDERS[pid], 3500);
            const results = searchRes?.searchResult || [];
            return results.map(r => ({ ...r, providerId: pid }));
          } catch (_) {
            return [];
          }
        });
        const allResults = await Promise.all(searchPromises);
        items = allResults.flat();
      } else {
        // Direct platform search
        console.log(`[catalog] Searching for "${query}" on provider "${providerId}"...`);
        const searchRes = await searchContent(query, cfg, 3500);
        const results = searchRes?.searchResult || [];
        items = results.map(r => ({ ...r, providerId }));
      }
    } else {
      // Home page browsing
      console.log(`[catalog] Loading home page for provider "${providerId}"...`);
      const homeItems = await getHomePage(cfg, 3500);
      items = homeItems.map(item => ({ ...item, providerId }));
    }

    const metas = items.map(item => {
      const pid = item.providerId || providerId;
      const itemTitle = item.t || item.title || '';
      
      const itemType = (item.r === 'Series') ? 'series' : 'movie';

      return {
        id: `netmirror:${pid}:${item.id}`,
        name: itemTitle,
        type: itemType,
        poster: getImgUrl(pid, item.id),
        posterShape: 'poster',
      };
    });

    console.log(`[catalog] Returning ${metas.length} items`);
    return { metas: metas };
  } catch (err) {
    console.error('[catalog] Error:', err.message);
    return { metas: [] };
  }
});

builder.defineMetaHandler(async ({ type, id }) => {
  console.log(`[meta] id="${id}" type="${type}"`);

  if (!id.startsWith('netmirror:')) return { meta: null };

  const parsed = parseId(id);
  if (!parsed) return { meta: null };

  const cfg = PROVIDERS[parsed.provider];
  if (!cfg) return { meta: null };

  try {
    const post = await getPost(parsed.targetId, cfg);
    if (!post) return { meta: null };

    const title = post.title || 'Untitled';
    const isSeries = post.type === 't' || (post.season && post.season.length > 0) || type === 'series';
    const itemType = type; // strictly match requested type to prevent Stremio loading hangs!
    const imgUrl = getImgUrl(parsed.provider, parsed.targetId);

    const meta = {
      id: id,
      name: title,
      type: itemType,
      poster: imgUrl,
      background: imgUrl,
      posterShape: 'poster',
      description: post.desc || '',
      genres: post.genre ? post.genre.split(',').map(g => g.trim()) : [],
      releaseInfo: post.year || null,
      runtime: post.runtime || null,
      cast: post.cast ? post.cast.split(',').map(c => c.trim()) : [],
      director: post.director ? post.director.split(',').map(d => d.trim()) : [],
    };

    if (isSeries) {
      // Retrieve seasons and episodes
      const episodesList = [];
      const postEpisodes = await collectEpisodes(post, parsed.targetId, cfg);

      for (const ep of postEpisodes) {
        const sNum = parseSeason(ep.s);
        const eNum = parseEp(ep.ep);
        
        episodesList.push({
          id: `netmirror:${parsed.provider}:ep:${ep.id}`, // Unique ID for episode stream request
          title: ep.t || ep.title || `Season ${sNum} Episode ${eNum}`,
          season: sNum,
          episode: eNum,
          released: new Date().toISOString(),
        });
      }
      
      meta.videos = episodesList;
    }

    return { meta };
  } catch (err) {
    console.error('[meta] Error:', err.message);
    return { meta: null };
  }
});

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[stream] id="${id}" type="${type}"`);

  if (id.startsWith('netmirror:')) {
    const parsed = parseId(id);
    if (!parsed) return { streams: [] };

    const cfg = PROVIDERS[parsed.provider];
    if (!cfg) return { streams: [] };

    try {
      // 1. Try new NewTV API first
      const newTvStreams = await buildNewTvStream(parsed.targetId, cfg.ott, cfg.name);
      if (newTvStreams && newTvStreams.length > 0) {
        console.log(`[stream] ${newTvStreams.length} streams (NewTV) for "${id}"`);
        return { streams: newTvStreams };
      }
      // 2. Fall back to legacy playlist.php
      const playlistData = await getPlaylist(parsed.targetId, '', cfg);
      const items = Array.isArray(playlistData) ? playlistData : [playlistData];
      const streams = buildStreams(items, cfg.name);

      console.log(`[stream] ${streams.length} streams for "${id}"`);
      return { streams };
    } catch (err) {
      console.error(`[stream] ERROR for "${id}":`, err.message);
      return { streams: [] };
    }
  }

  const stremioId = parseStremioId(id);
  if (stremioId) {
    console.log(`[stream] IMDB id, looking up title...`);
    const title = await getTitleFromImdb(type, stremioId.imdbId);
    if (!title) { console.log(`[stream] no title for ${stremioId.imdbId}`); return { streams: [] }; }

    console.log(`[stream] searching for "${title}"...`);
    const streams = await streamsForTitle(title, type, {
      season: stremioId.season,
      episode: stremioId.episode,
    });
    console.log(`[stream] ${streams.length} streams for "${title}" (${id})`);
    return { streams };
  }

  return { streams: [] };
});

module.exports = builder.getInterface();
