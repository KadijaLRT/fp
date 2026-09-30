import { checkRateLimit, sendRateLimitResponse } from './_rateLimit.js';

// Real, confirmed bug: geocoding.geo.census.gov sends no
// Access-Control-Allow-Origin header, so a browser fetch() straight to it
// from the client is blocked by CORS before the request even leaves the
// browser — every single address fails identically regardless of how
// well-formed it is, which is exactly the "None of the 34 address(es)
// could be located" symptom a real driver hit. This endpoint exists
// solely to route around that: a same-origin serverless function calls
// the Census Geocoder server-side (no CORS involved between two servers)
// and the client calls this instead of the Census API directly.
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Census geocoder request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rateLimit = await checkRateLimit(req, 'geocode');
  if (!rateLimit.allowed) {
    return sendRateLimitResponse(res, rateLimit);
  }

  const address = typeof req.query?.address === 'string' ? req.query.address.trim() : '';
  if (!address) {
    return res.status(400).json({ error: 'Missing or empty "address" query parameter.' });
  }

  const params = new URLSearchParams({
    address,
    benchmark: 'Public_AR_Current',
    format: 'json'
  });
  const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${params.toString()}`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const upstream = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
      if (!upstream.ok) {
        const retryable = upstream.status === 429 || upstream.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) {
          return res.status(502).json({ error: `Census geocoder returned ${upstream.status}` });
        }
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        continue;
      }

      const data = await upstream.json();
      return res.status(200).json(data);
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
    }
  }

  console.error('Census geocoder proxy failed:', lastError);
  return res.status(502).json({ error: lastError?.message || 'Failed to reach the Census geocoder.' });
}
