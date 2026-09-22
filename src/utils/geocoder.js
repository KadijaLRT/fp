import { getCachedGeocode, setCachedGeocode } from './geocodeCache.js';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

// Constrains geocoding results to a bounding box (minLng,minLat,maxLng,maxLat)
// rather than just ranking within it — Mapbox's bbox param is a hard
// filter, not a soft preference, so a short/ambiguous OCR'd address (very
// common — city/state/zip often gets dropped or garbled) can't resolve to
// a same-named street in a completely different state. Covers CT and MA
// with margin (a bbox doesn't need to precisely trace state borders, it's
// just a filter rectangle — a little overlap into NY/RI/NH/VT near the
// edges is fine and expected). Configurable via env var since an
// operating territory can change; without VITE_GEOCODING_BBOX set, this
// default applies.
const DEFAULT_GEOCODING_BBOX = '-73.75,40.95,-69.90,42.90';

function getGeocodingBbox() {
  return import.meta.env?.VITE_GEOCODING_BBOX || DEFAULT_GEOCODING_BBOX;
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Geocoding request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

/**
 * Geocodes a single address via the Mapbox Geocoding API. Never throws —
 * always resolves to a result object so a batch of Promise.all() calls
 * (see App.jsx) can't be taken down by one bad address.
 *
 * @param {string} rawAddress
 * @param {string} mapboxToken
 * @param {{ proximity?: { lat: number, lng: number } }} [options] - proximity
 *   biases *ranking* toward a point (e.g. the driver's live GPS position)
 *   without excluding anything, complementing the hard bbox filter below.
 */
export async function geocodeAddress(rawAddress, mapboxToken, options = {}) {
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
  if (!mapboxToken) {
    return { ...fallback, error: 'Missing Mapbox token' };
  }

  // Cache check first — this is the actual fix for a driver running out
  // of Mapbox API calls: a recurring address (same apartment complex,
  // same regular stop) previously geocoded successfully skips the
  // network entirely instead of burning quota on a result we already
  // have. A cache miss falls straight through to Mapbox exactly as
  // before, so this can only reduce calls, never change what a fresh
  // lookup would have returned.
  const cached = getCachedGeocode(rawAddress);
  if (cached) {
    return { ...cached, error: null };
  }

  const encoded = encodeURIComponent(rawAddress.trim());
  const params = new URLSearchParams({
    access_token: mapboxToken,
    limit: '1',
    bbox: getGeocodingBbox()
  });
  if (options.proximity && typeof options.proximity.lng === 'number' && typeof options.proximity.lat === 'number') {
    params.set('proximity', `${options.proximity.lng},${options.proximity.lat}`);
  }
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?${params.toString()}`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) {
          return { ...fallback, error: `Mapbox returned ${res.status}` };
        }
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        continue;
      }

      const data = await res.json();

      if (!data.features || data.features.length === 0) {
        // Bug-fix note: with the bbox filter now in place, "no match" can
        // legitimately mean "this address is outside the configured
        // territory" rather than "couldn't be read" — surfaced distinctly
        // so a driver who genuinely gets a rare out-of-area stop isn't
        // told the same generic error as a garbled OCR result.
        return { ...fallback, error: 'No match found within the configured service area (CT/MA)' };
      }

      const feature = data.features[0];
      const center = feature.center;
      if (!Array.isArray(center) || center.length !== 2) {
        return { ...fallback, error: 'Malformed geocode response' };
      }

      const [lng, lat] = center;
      const relevance = typeof feature.relevance === 'number' ? feature.relevance : 0;

      const result = {
        address: feature.place_name || rawAddress,
        lat,
        lng,
        confidence: Math.round(relevance * 100),
        needsReview: relevance < 0.8,
        error: null
      };
      setCachedGeocode(rawAddress, result);
      return result;
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
    }
  }

  console.error('Geocoding failed for:', rawAddress, lastError);
  return { ...fallback, error: lastError?.message || 'Geocoding failed' };
}

/**
 * Geocodes a batch of addresses with limited concurrency so we don't blow
 * through Mapbox rate limits on a 30-stop route all firing at once.
 */
export async function geocodeAddressBatch(addresses, mapboxToken, concurrency = 5, options = {}) {
  const results = new Array(addresses.length);
  let cursor = 0;

  async function worker() {
    while (cursor < addresses.length) {
      const idx = cursor++;
      results[idx] = await geocodeAddress(addresses[idx], mapboxToken, options);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, addresses.length) }, worker);
  await Promise.all(workers);
  return results;
}
