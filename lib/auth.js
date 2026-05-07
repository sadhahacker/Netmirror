const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

const COOKIE_TTL = 54_000_000; // 15 hours (matches original extension exactly)

let cache = { value: null, ts: 0 };

async function getCookie() {
  if (cache.value && Date.now() - cache.ts < COOKIE_TTL) {
    return cache.value;
  }

  // Exact replica of the bypass() function in the original Utils.kt
  // Key: posts a random UUID as g-recaptcha-response with redirects disabled
  // The t_hash_t cookie is set on the redirect (302) response headers
  const res = await axios.post(
    'https://net52.cc/verify.php',
    `g-recaptcha-response=${uuidv4()}`,
    {
      headers: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'max-age=0',
        'Connection': 'keep-alive',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://net52.cc',
        'Referer': 'https://net52.cc/verify2',
        'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
      },
      maxRedirects: 0,          // Critical: cookie is on the redirect response
      validateStatus: (s) => s < 400,
      timeout: 15000,
    }
  );

  const setCookies = res.headers['set-cookie'] || [];
  let tHash = '';
  for (const c of setCookies) {
    const match = c.match(/t_hash_t=([^;]+)/);
    if (match) { tHash = match[1]; break; }
  }

  if (!tHash) throw new Error('bypass failed: t_hash_t cookie not found in response');

  cache = { value: tHash, ts: Date.now() };
  console.log('[auth] Cookie refreshed successfully');
  return tHash;
}

module.exports = { getCookie };
