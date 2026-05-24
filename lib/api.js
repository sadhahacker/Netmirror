const axios = require('axios');
const cheerio = require('cheerio');
const { getCookie } = require('./auth');
const { HttpsProxyAgent } = require('https-proxy-agent');

const proxyUrl = process.env.NET52_PROXY || '';
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : null;

const BASE_URL = 'https://net52.cc';
const IMG_CDN = 'https://imgcdn.kim';

const IMG_PATHS = {
  netflix: 'poster/v',
  prime: 'pv/v',
  hotstar: 'hs/v',
  disney: 'hs/v',
  marvel: 'hs/v',
  starwars: 'hs/v',
  pixar: 'hs/v',
};

function getImgUrl(providerId, contentId) {
  const path = IMG_PATHS[providerId] || 'poster/v';
  return `${IMG_CDN}/${path}/${contentId}.jpg`;
}

function fullStreamUrl(file) {
  if (!file) return null;
  if (file.startsWith('http')) return file;
  if (file.startsWith('//')) return `https:${file}`;
  return `${BASE_URL}${file}`;
}

async function makeRequest(path, providerConfig, customTimeout = 20000) {
  const cookieObj = await getCookie();
  const tHash = (cookieObj && typeof cookieObj === 'object') ? cookieObj.value : cookieObj;

  const cookieParts = [
    `t_hash_t=${tHash}`,
    `t_hash_p=${tHash}`,
    `t_hash_h=${tHash}`,
    'hd=on',
  ];
  if (providerConfig.ott)    cookieParts.push(`ott=${providerConfig.ott}`);
  if (providerConfig.studio) cookieParts.push(`studio=${providerConfig.studio}`);

  if (cookieObj && typeof cookieObj === 'object') {
    if (cookieObj.cf_clearance) cookieParts.push(`cf_clearance=${cookieObj.cf_clearance}`);
    if (cookieObj.ext_name)     cookieParts.push(`ext_name=${cookieObj.ext_name}`);
  }

  const res = await axios.get(`${BASE_URL}${path}`, {
    headers: {
      Cookie: cookieParts.join('; '),
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 5 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/144.0.7559.132 Safari/537.36 /OS.Gatu v3.0',
      Referer: `${BASE_URL}/home`,
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: customTimeout,
    ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {}),
  });

  let data = res.data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed.includes('{')) {
      const firstBrace = trimmed.indexOf('{');
      const lastBrace = trimmed.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try {
          data = JSON.parse(trimmed.substring(firstBrace, lastBrace + 1));
        } catch (err) {
          // Fall back to original data if JSON parsing fails
        }
      }
    }
  }

  return data;
}

// Home page returns HTML — parse with cheerio using same selectors as Kotlin extension
async function getHomePage(providerConfig, timeout) {
  const html = await makeRequest('/mobile/home?app=1', providerConfig, timeout);

  const $ = cheerio.load(html);
  const items = [];

  $('.tray-container, #top10').each((_, tray) => {
    $(tray).find('article, .top10-post').each((_, el) => {
      const id = $(el).find('a').first().attr('data-post') || $(el).attr('data-post');
      const title = $(el).find('.card-title, .post-title, h3, h4, .title').first().text().trim();
      if (id) items.push({ id, title: title || '' });
    });
  });

  return items;
}

// Search returns JSON: { searchResult: [{id, t}, ...] }
async function searchContent(query, providerConfig, timeout) {
  const cleanQuery = String(query || '').replace(/['’]/g, ' ').replace(/\s+/g, ' ').trim();
  const prefix = providerConfig.pathPrefix;
  const basePath = prefix === '' ? '' : '/mobile';
  const ts = Math.floor(Date.now() / 1000);
  return makeRequest(
    `${basePath}/${prefix}search.php?s=${encodeURIComponent(cleanQuery)}&t=${ts}`,
    providerConfig,
    timeout
  );
}

async function getPost(contentId, providerConfig) {
  const prefix = providerConfig.pathPrefix;
  const basePath = prefix === '' ? '' : '/mobile';
  const ts = Math.floor(Date.now() / 1000);
  return makeRequest(
    `${basePath}/${prefix}post.php?id=${contentId}&t=${ts}`,
    providerConfig
  );
}

async function getEpisodes(seasonId, seriesId, page, providerConfig) {
  const prefix = providerConfig.pathPrefix;
  const basePath = prefix === '' ? '' : '/mobile';
  const ts = Math.floor(Date.now() / 1000);
  return makeRequest(
    `${basePath}/${prefix}episodes.php?s=${seasonId}&series=${seriesId}&t=${ts}&page=${page}`,
    providerConfig
  );
}

// Playlist returns array of items with relative file paths — use fullStreamUrl()
async function getPlaylist(id, title, providerConfig) {
  const prefix = providerConfig.pathPrefix;
  const basePath = prefix === '' ? '' : '/mobile';
  const ts = Math.floor(Date.now() / 1000);
  return makeRequest(
    `${basePath}/${prefix}playlist.php?id=${id}&t=${encodeURIComponent(title || '')}&tm=${ts}`,
    providerConfig
  );
}

module.exports = { getHomePage, searchContent, getPost, getEpisodes, getPlaylist, getImgUrl, fullStreamUrl };
