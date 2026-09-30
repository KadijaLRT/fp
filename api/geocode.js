import { checkRateLimit, sendRateLimitResponse } from './_rateLimit.js';

// Provider history, so the reasoning isn't lost: this started on Mapbox
// (paid, ran out of quota mid-route for a real driver), moved to the
// free US Census Bureau Geocoder (no key, but geocoding.geo.census.gov
// sends no Access-Control-Allow-Origin header, so a direct browser fetch
// was blocked by CORS before it ever left the browser — fixed with a
// same-origin proxy, this file's earlier version). Even proxied
// server-to-server, Census turned out to be the wrong dependency: it has
// no published SLA and is independently documented as unreliable under
// real load (frequent downtime, hangs, and inconsistent results —
// confirmed via https://www.geocod.io/census-bureau-api-down-alternative
// and the Census Bureau's own FAQ acknowledging "inconsistent results"
// under "processing load"). A real driver hit exactly this: every
// address in a route failing identically, which is the signature of the
// upstream service being down/unreachable, not bad address data.
//
// Now on OpenCage (https://opencagedata.com) — free tier (2,500
// requests/day), needs a free API key (OPENCAGE_API_KEY), and publishes
// an actual uptime status page rather than offering no SLA at all. Kept
// behind this same proxy regardless of provider, since a server-to-server
// call sidesteps any future CORS surprise from whichever service is
// behind it, and a future provider swap only touches this one file plus
// the response-shape mapping in geocoder.js — the client never talks to
// a geocoding provider directly.
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('OpenCage request timed out')), ms);
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

  const apiKey = process.env.OPENCAGE_API_KEY;
  if (!apiKey) {
    console.error('geocode: OPENCAGE_API_KEY is not configured on the server.');
    return res.status(500).json({ error: 'Geocoding service is not configured on the server.' });
  }

  const address = typeof req.query?.address === 'string' ? req.query.address.trim() : '';
  if (!address) {
    return res.status(400).json({ error: 'Missing or empty "address" query parameter.' });
  }

  // Optional bbox passthrough from the client (minLng,minLat,maxLng,maxLat)
  // so the operating-territory filter lives in one config value rather
  // than being duplicated between client and server. OpenCage's `bounds`
  // param is min_lon,min_lat,max_lon,max_lat — same field order as this
  // app's existing VITE_GEOCODING_BBOX, so no reordering needed.
  const bounds = typeof req.query?.bounds === 'string' ? req.query.bounds.trim() : '';

  const params = new URLSearchParams({
    q: address,
    key: apiKey,
    limit: '1',
    no_annotations: '1' // this app only needs lat/lng/formatted/confidence, not OpenCage's extra metadata
  });
  if (bounds) {
    params.set('bounds', bounds);
  }
  const url = `https://api.opencagedata.com/geocode/v1/json?${params.toString()}`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const upstream = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);

      // OpenCage's documented status codes: 401 (bad key) and 402 (quota
      // exceeded) are configuration/billing problems, not transient
      // network issues — retrying won't help and would just waste the
      // retry budget, so these fail fast with a clear message instead of
      // silently retrying into the same wall three times.
      if (upstream.status === 401) {
        console.error('geocode: OpenCage rejected the configured API key (401).');
        return res.status(500).json({ error: 'Geocoding service is misconfigured (invalid API key).' });
      }
      if (upstream.status === 402) {
        console.error('geocode: OpenCage daily quota exceeded (402).');
        return res.status(502).json({ error: 'Geocoding service has reached its daily quota. Try again later.' });
      }

      if (!upstream.ok) {
        const retryable = upstream.status === 429 || upstream.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) {
          return res.status(502).json({ error: `Geocoding provider returned ${upstream.status}` });
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

  console.error('OpenCage geocoding proxy failed:', lastError);
  return res.status(502).json({ error: lastError?.message || 'Failed to reach the geocoding service.' });
}
