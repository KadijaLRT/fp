import { getCachedGeocode, setCachedGeocode } from './geocodeCache.js';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

// Bounding box used to reject matches outside the driver's operating
// territory (minLng,minLat,maxLng,maxLat). The Census Geocoder has no
// native bbox filter param, so this is applied client-side after a match
// comes back. Covers CT and MA with margin; a little overlap into
// NY/RI/NH/VT near the edges is fine and expected. Configurable via env
// var since an operating territory can change.
const DEFAULT_GEOCODING_BBOX = '-73.75,40.95,-69.90,42.90';

function getGeocodingBbox() {
  const raw = import.meta.env?.VITE_GEOCODING_BBOX || DEFAULT_GEOCODING_BBOX;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    const fallbackParts = DEFAULT_GEOCODING_BBOX.split(',').map(Number);
    return { minLng: fallbackParts[0], minLat: fallbackParts[1], maxLng: fallbackParts[2], maxLat: fallbackParts[3] };
  }
  const [minLng, minLat, maxLng, maxLat] = parts;
  return { minLng, minLat, maxLng, maxLat };
}

function isWithinBbox(lat, lng) {
  const { minLng, minLat, maxLng, maxLat } = getGeocodingBbox();
  return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Geocoding request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Geocodes a single address via /api/geocode, a same-origin serverless
 * proxy in front of the US Census Bureau's free public geocoder (no API
 * key, no billing, no quota for normal driver-scale volume). Never
 * throws — always resolves to a result object so a batch of
 * Promise.all() calls (see App.jsx) can't be taken down by one bad
 * address.
 *
 * Bug fix: this used to call geocoding.geo.census.gov directly from the
 * browser. That endpoint sends no Access-Control-Allow-Origin header, so
 * every request was silently blocked by CORS before it ever reached the
 * network — a real driver hit this as "None of the 34 address(es) could
 * be located," every single address failing identically regardless of
 * how well-formed it was, which is the signature of a CORS failure, not
 * bad data. Routed through /api/geocode (a server-to-server call has no
 * CORS involved) instead of hitting Census straight from client code.
 *
 * Note: the Census Geocoder only covers US addresses. That's a non-issue
 * for a CT/MA Flex route, but if this app is ever used outside the US,
 * this function needs a different provider (see README for alternatives).
 *
 * @param {string} rawAddress
 * @param {string} [_unusedToken] - kept as a positional param for
 *   backward compatibility with existing call sites; the Census Geocoder
 *   needs no token, so this is accepted and ignored rather than forcing
 *   every caller to be updated in lockstep.
 * @param {{ proximity?: { lat: number, lng: number } }} [options] - proximity
 *   is accepted for API compatibility but the Census Geocoder has no
 *   proximity-ranking param, so it currently has no effect on results.
 */
export async function geocodeAddress(rawAddress, _unusedToken, options = {}) {
  const fallback = {
    address: rawAddress || '',
    lat: null,
    lng: null,
    confidence: 0,
    needsReview: true,
    error: null
  };

  if (!rawAddress || typeof rawAddress !== 'string' || !rawAddress.trim()) {
    return { ...fallback, error: 'Empty address' };
  }

  const trimmedAddress = rawAddress.trim();

  // Cache check first — this is what actually keeps a driver from ever
  // exhausting a geocoding quota again: a recurring address (same
  // apartment complex, same regular stop) previously geocoded
  // successfully skips the network entirely instead of re-requesting a
  // result we already have. A cache miss falls straight through to the
  // Census Geocoder exactly as before, so this can only reduce calls,
  // never change what a fresh lookup would have returned.
  const cached = getCachedGeocode(trimmedAddress);
  if (cached) {
    return { ...cached, error: null };
  }

  const params = new URLSearchParams({ address: trimmedAddress });
  const url = `/api/geocode?${params.toString()}`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) {
          return { ...fallback, error: `Geocoding request failed (${res.status})` };
        }
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        continue;
      }

      const data = await res.json();
      const matches = data?.result?.addressMatches;

      if (!Array.isArray(matches) || matches.length === 0) {
        return { ...fallback, error: 'No match found for this address' };
      }

      const match = matches[0];
      const coords = match.coordinates;
      if (!coords || typeof coords.x !== 'number' || typeof coords.y !== 'number') {
        return { ...fallback, error: 'Malformed geocode response' };
      }

      const lng = coords.x;
      const lat = coords.y;

      if (!isWithinBbox(lat, lng)) {
        // Bug-fix note: this mirrors the old Mapbox bbox behavior —
        // "no match" here can legitimately mean "this address is outside
        // the configured territory" rather than "couldn't be read",
        // surfaced distinctly so a driver who genuinely gets a rare
        // out-of-area stop isn't told the same generic error as a
        // garbled OCR result.
        return { ...fallback, error: 'Match found outside the configured service area (CT/MA)' };
      }

      // The Census Geocoder doesn't return a confidence/relevance score
      // like Mapbox did. It returns exactly one best match or none, so a
      // successful match is treated as high-confidence; "tigerLine.side"
      // presence indicates the match was matched to a real street
      // segment rather than a rough interpolation, which is used as a
      // (rough) confidence proxy.
      const hasStreetMatch = !!match.tigerLine;
      const confidence = hasStreetMatch ? 90 : 65;

      const result = {
        address: match.matchedAddress || trimmedAddress,
        lat,
        lng,
        confidence,
        needsReview: confidence < 80,
        error: null
      };
      setCachedGeocode(trimmedAddress, result);
      return result;
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
    }
  }

  console.error('Geocoding failed for:', trimmedAddress, lastError);
  return { ...fallback, error: lastError?.message || 'Geocoding failed' };
}

/**
 * Geocodes a batch of addresses with limited concurrency. The Census
 * Geocoder has no documented hard rate limit for the free onelineaddress
 * endpoint, but this keeps behavior identical to before (and stays a
 * good citizen of a shared free government API) by not firing a 30-stop
 * route's worth of requests all at once.
 */
export async function geocodeAddressBatch(addresses, _unusedToken, concurrency = 5, options = {}) {
  const results = new Array(addresses.length);
  let cursor = 0;

  async function worker() {
    while (cursor < addresses.length) {
      const idx = cursor++;
      results[idx] = await geocodeAddress(addresses[idx], _unusedToken, options);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, addresses.length) }, worker);
  await Promise.all(workers);
  return results;
}
