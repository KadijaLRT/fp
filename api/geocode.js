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

/**
 * Geocoding with a second opinion. OpenCage is asked for up to 5 candidates
 * (it used to return only the first, so a wrong-place first hit was final).
 * If the best candidate does not match the typed house number, or is not
 * rooftop-level accurate, Mapbox Geocoding (when MAPBOX_ACCESS_TOKEN is set)
 * is asked too, and the candidate that matches the house number best wins.
 * The response keeps OpenCage's shape so the client is unchanged.
 */
function typedHouseNumber(address) {
  const m = String(address || '').match(/^\s*(\d+[A-Za-z]?)\b/);
  return m ? m[1].toLowerCase() : null;
}

function scoreCandidate(c, houseNumber) {
  const got = String(c?.components?.house_number || '').toLowerCase();
  let score = (typeof c.confidence === 'number' ? c.confidence : 0) / 10;
  if (houseNumber) score += got === houseNumber ? 3 : got ? -1 : -2;
  return score;
}

async function fetchOpenCage(address, bounds, apiKey) {
  const params = new URLSearchParams({ q: address, key: apiKey, limit: '5', no_annotations: '1' });
  if (bounds) params.set('bounds', bounds);
  const url = `https://api.opencagedata.com/geocode/v1/json?${params.toString()}`;
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const upstream = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
      // 401 (bad key) and 402 (quota) are configuration/billing problems, not transient.
      if (upstream.status === 401) return { error: 'Geocoding service is misconfigured (invalid API key).', status: 500 };
      if (upstream.status === 402) return { error: 'Geocoding service has reached its daily quota. Try again later.', status: 502 };
      if (!upstream.ok) {
        const retryable = upstream.status === 429 || upstream.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) return { error: `Geocoding provider returned ${upstream.status}`, status: 502 };
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        continue;
      }
      const data = await upstream.json();
      return { candidates: Array.isArray(data?.results) ? data.results : [] };
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
    }
  }
  return { error: lastError?.message || 'Failed to reach the geocoding service.', status: 502 };
}

const MAPBOX_ACCURACY_CONFIDENCE = { rooftop: 10, parcel: 9, point: 9, interpolated: 7, approximate: 5, street: 5 };

async function fetchMapbox(address, bounds, token) {
  try {
    const params = new URLSearchParams({ q: address, country: 'us', limit: '5', types: 'address', access_token: token });
    if (bounds) params.set('bbox', bounds); // same field order: minLng,minLat,maxLng,maxLat
    const res = await withTimeout(fetch(`https://api.mapbox.com/search/geocode/v6/forward?${params.toString()}`), REQUEST_TIMEOUT_MS);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.features || [])
      .map((f) => {
        const [lng, lat] = f?.geometry?.coordinates || [];
        if (typeof lat !== 'number' || typeof lng !== 'number') return null;
        const accuracy = f?.properties?.coordinates?.accuracy || 'approximate';
        return {
          formatted: f?.properties?.full_address || f?.properties?.name || address,
          confidence: MAPBOX_ACCURACY_CONFIDENCE[accuracy] ?? 5,
          components: { house_number: f?.properties?.context?.address?.address_number || '', road: f?.properties?.context?.street?.name || '' },
          geometry: { lat, lng },
          provider: 'mapbox'
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('geocode: Mapbox lookup failed:', err?.message || err);
    return [];
  }
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
  const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN;
  if (!apiKey && !mapboxToken) {
    console.error('geocode: neither OPENCAGE_API_KEY nor MAPBOX_ACCESS_TOKEN is configured.');
    return res.status(500).json({ error: 'Geocoding service is not configured on the server.' });
  }

  const address = typeof req.query?.address === 'string' ? req.query.address.trim() : '';
  if (!address) {
    return res.status(400).json({ error: 'Missing or empty "address" query parameter.' });
  }
  // Optional territory box from the client (minLng,minLat,maxLng,maxLat).
  const bounds = typeof req.query?.bounds === 'string' ? req.query.bounds.trim() : '';
  const houseNumber = typedHouseNumber(address);

  let candidates = [];
  let firstError = null;
  if (apiKey) {
    const oc = await fetchOpenCage(address, bounds, apiKey);
    if (oc.error) firstError = oc;
    else candidates = oc.candidates;
  }

  const best = () => [...candidates].sort((a, b) => scoreCandidate(b, houseNumber) - scoreCandidate(a, houseNumber))[0];
  const top = best();
  const good = top && (!houseNumber || String(top.components?.house_number || '').toLowerCase() === houseNumber) && top.confidence >= 9;

  if (!good && mapboxToken) {
    const extra = await fetchMapbox(address, bounds, mapboxToken);
    candidates = [...candidates, ...extra];
  }

  if (candidates.length === 0) {
    if (firstError) return res.status(firstError.status).json({ error: firstError.error });
    return res.status(200).json({ results: [] });
  }

  // Winner first, then the other candidates (deduped by location, max 6) so the
  // client can pick the one that fits the rest of the route when a bare city
  // name is ambiguous (Hampden MA vs Hamden CT, Springfield in many states).
  const ranked = [...candidates].sort((a, b) => scoreCandidate(b, houseNumber) - scoreCandidate(a, houseNumber));
  const seen = new Set();
  const results = [];
  for (const c of ranked) {
    const lat = c?.geometry?.lat;
    const lng = c?.geometry?.lng;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ ...c, score: scoreCandidate(c, houseNumber) });
    if (results.length >= 6) break;
  }
  return res.status(200).json({ results });
}
