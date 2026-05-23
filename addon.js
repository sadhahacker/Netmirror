const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const PROVIDERS = require('./providers/config');
const { searchContent, getPost, getEpisodes, getPlaylist, fullStreamUrl } = require('./lib/api');

const manifest = {
  id: 'community.netmirror.ott',
  version: '1.0.8',
  name: 'NetMirror',
  description: 'NetMirror streams for Stremio default catalogs',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
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

async function collectEpisodes(post, seriesId, cfg) {
  const videos = [];
  const seasons = post.season || [];

  if (seasons.length > 0) {
    for (const season of seasons) {
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

      let playlistId = match.id;
      let playlistTitle = match.t;

      if (type === 'series' && opts.season && opts.episode) {
        const post = await getPost(match.id, cfg);
        const episodes = await collectEpisodes(post, match.id, cfg);
        const episode = episodes.find(ep =>
          parseSeason(ep.s) === opts.season && parseEp(ep.ep) === opts.episode
        );

        if (!episode) return [];
        playlistId = episode.id;
        playlistTitle = episode.t || match.t;
      }

      const pl = await getPlaylist(playlistId, playlistTitle, cfg);
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

builder.defineStreamHandler(async ({ type, id }) => {
  console.log(`[stream] id="${id}" type="${type}"`);

  if (id.startsWith('netmirror:')) {
    const parsed = parseId(id);
    if (!parsed) return { streams: [] };

    const cfg = PROVIDERS[parsed.provider];
    if (!cfg) return { streams: [] };

    try {
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
