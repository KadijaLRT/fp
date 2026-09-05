const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

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
 */
export async function geocodeAddress(rawAddress, mapboxToken) {
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

  const encoded = encodeURIComponent(rawAddress.trim());
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${mapboxToken}&limit=1`;

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
        return { ...fallback, error: 'No match found' };
      }

      const feature = data.features[0];
      const center = feature.center;
      if (!Array.isArray(center) || center.length !== 2) {
        return { ...fallback, error: 'Malformed geocode response' };
      }

      const [lng, lat] = center;
      const relevance = typeof feature.relevance === 'number' ? feature.relevance : 0;

      return {
        address: feature.place_name || rawAddress,
        lat,
        lng,
        confidence: Math.round(relevance * 100),
        needsReview: relevance < 0.8,
        error: null
      };
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
export async function geocodeAddressBatch(addresses, mapboxToken, concurrency = 5) {
  const results = new Array(addresses.length);
  let cursor = 0;

  async function worker() {
    while (cursor < addresses.length) {
      const idx = cursor++;
      results[idx] = await geocodeAddress(addresses[idx], mapboxToken);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, addresses.length) }, worker);
  await Promise.all(workers);
  return results;
}
