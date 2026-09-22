/**
 * A real gap found by a driver actually running out of Mapbox API calls:
 * every route import re-geocoded every address from scratch, with zero
 * caching anywhere — even a stop delivered to yesterday got a brand new
 * Mapbox request today. For a driver running regular routes with any
 * address overlap (very common — apartment complexes, a recurring
 * residential area), that's needless, repeated quota burn for addresses
 * whose coordinates were already known.
 *
 * localStorage-backed rather than a new Supabase table: no schema
 * migration needed, works immediately, and the thing this actually needs
 * to match against — the SAME driver's device producing similar OCR text
 * for the SAME physical stop across different days — is exactly the case
 * a per-device cache handles well. Keyed on a normalized (trimmed,
 * lowercased, whitespace-collapsed) form of the raw address text, since
 * OCR output for a genuinely-recurring stop tends to be consistent even
 * if not always byte-identical.
 *
 * Purely an optimization, never a correctness risk: a cache miss falls
 * straight through to Mapbox exactly as before. Nothing here can produce
 * a wrong result it wouldn't already have produced — it can only skip a
 * network call for an address it's already confident about.
 */

const STORAGE_KEY = 'flexGeocodeCache';
const MAX_ENTRIES = 500;
// Re-verify with Mapbox periodically rather than trusting a cached
// coordinate forever — addresses do occasionally get corrected/renamed,
// and this bounds how stale a cached entry can get.
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

function normalizeKey(rawAddress) {
  return (rawAddress || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function loadCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function saveCache(cache) {
  try {
    const entries = Object.entries(cache);
    // Simple cap: if over the limit, keep only the most recently-used
    // entries rather than growing unbounded or hitting localStorage's
    // size limit unexpectedly.
    const trimmed =
      entries.length > MAX_ENTRIES
        ? Object.fromEntries(entries.sort((a, b) => b[1].cachedAt - a[1].cachedAt).slice(0, MAX_ENTRIES))
        : cache;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage full or unavailable — degrade to "no caching this time,"
    // never throw. The whole point of this cache is to save API calls,
    // not to become a new failure mode.
  }
}

/**
 * Returns a cached geocode result for this address, or null on a miss
 * (not found, or the entry is past MAX_AGE_MS). Never throws.
 */
export function getCachedGeocode(rawAddress) {
  const key = normalizeKey(rawAddress);
  if (!key) return null;

  try {
    const cache = loadCache();
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > MAX_AGE_MS) return null;
    return {
      address: entry.address,
      lat: entry.lat,
      lng: entry.lng,
      confidence: entry.confidence,
      needsReview: entry.needsReview
    };
  } catch {
    return null;
  }
}

/**
 * Stores a successful geocode result for future lookups. Only call this
 * for results that actually resolved (never cache a failure — a
 * transient Mapbox hiccup shouldn't get permanently remembered as "this
 * address doesn't exist").
 */
export function setCachedGeocode(rawAddress, result) {
  const key = normalizeKey(rawAddress);
  if (!key || typeof result?.lat !== 'number' || typeof result?.lng !== 'number') return;

  try {
    const cache = loadCache();
    cache[key] = {
      address: result.address,
      lat: result.lat,
      lng: result.lng,
      confidence: result.confidence,
      needsReview: result.needsReview,
      cachedAt: Date.now()
    };
    saveCache(cache);
  } catch {
    // Non-fatal — see saveCache.
  }
}
