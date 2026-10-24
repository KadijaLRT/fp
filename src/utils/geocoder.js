import { getCachedGeocode, setCachedGeocode } from './geocodeCache.js';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

// Bounding box used to constrain matches to the driver's operating
// territory (minLng,minLat,maxLng,maxLat). OpenCage's `bounds` param takes
// this natively as a server-side filter (unlike the Census Geocoder,
// which had no such param and needed this applied client-side after the
// fact) — passed straight through to /api/geocode as a query param.
// Covers CT and MA with margin; a little overlap into NY/RI/NH/VT near
// the edges is fine and expected. Configurable via env var since an
// operating territory can change.
const DEFAULT_GEOCODING_BBOX = '-73.75,40.95,-69.90,42.90';

function getGeocodingBboxString() {
  const raw = import.meta.env?.VITE_GEOCODING_BBOX || DEFAULT_GEOCODING_BBOX;
  const parts = raw.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return DEFAULT_GEOCODING_BBOX;
  }
  return raw;
}

// Real, confirmed root cause of "could not be located" persisting even
// after moving off the Census Geocoder onto OpenCage: `bounds` is
// documented as a POST-match filter, not a pre-search hint — it narrows
// an already-found candidate list, it doesn't help the underlying search
// engine resolve an ambiguous query in the first place. Amazon Flex
// itinerary screenshots show just a bare street address (e.g. "123 Main
// St"), never a city/state, since the whole route is implicitly in one
// metro area on the driver's screen — Groq's OCR prompt extracts
// literally what's on screen, so that's exactly what reaches the
// geocoder. A string like "123 Main St" with zero city/state context is
// so globally ambiguous (that street name exists in thousands of towns)
// that most geocoders — this one included — fail to produce ANY
// confident match before `bounds` ever gets a chance to filter anything,
// which is indistinguishable from "this address doesn't exist" from the
// caller's side: a clean 200 response with an empty results array, not an
// error. This is why the bbox fix alone didn't resolve it: the box can
// only narrow a result set that already has candidates in it.
//
// Fixed by appending a default city/state/zip region hint to any address
// that doesn't already look like it has one, before sending it to the
// geocoder — giving the search engine's own text matching enough context
// to resolve a bare "123 Main St" the way a human reading the driver's
// screen already implicitly knows which town it's in. Configurable since
// a driver's operating territory can change; defaults to this app's
// existing CT/MA center point.
const DEFAULT_REGION_HINT = 'Hartford, CT';

// Loose check for "this address string already specifies a state" — a
// trailing two-letter state abbreviation (optionally followed by a zip).
// Deliberately permissive (a false positive just means a hint doesn't get
// appended to an address that didn't need one, which is harmless) rather
// than trying to exhaustively validate real US geography here.
// Real US state/DC abbreviations only. A generic "any two capitals" test
// treated the street suffix "ST" in all-caps Flex addresses ("232 MAIN ST")
// as a state, so the region hint was never added to exactly the bare
// addresses that needed it.
const US_STATES = new Set(
  'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ')
);
function hasStateAtEnd(address) {
  const m = address.match(/\b([A-Za-z]{2})\b\s*(?:\d{5}(?:-\d{4})?)?\s*$/);
  return !!m && US_STATES.has(m[1].toUpperCase()) && (m[1] === m[1].toUpperCase() || /,\s*[A-Za-z]{2}\s*(?:\d{5})?\s*$/.test(address));
}

// Floor/unit text ("3RD FLOOR", "APT 4", "#2B") confuses geocoders and
// never changes the building's location, so it is removed from the lookup
// only; the driver still sees the full address as printed.
function stripUnitInfo(address) {
  return address
    .replace(/\b\d+(?:st|nd|rd|th)\s+(?:floor|fl)\b/gi, '')
    .replace(/\b(?:floor|fl)\s*\d+\b/gi, '')
    .replace(/\b(?:apt|apartment|unit|ste|suite|rm|room)\.?\s*#?\s*[\w-]+/gi, '')
    .replace(/#\s*[\w-]+/g, '')
    // Abbreviations geocoders don't recognise (seen on real Flex screens).
    .replace(/\bxing\b/gi, 'Crossing')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/^[,\s]+|[,\s]+$/g, '');
}

// Separately: does the address already name SOME city, even without a
// state? ("78 Oak Ave, Windsor"). This matters because blindly appending
// "Hartford, CT" to that would produce "78 Oak Ave, Windsor, Hartford,
// CT" — a nonsensical compound of two different towns that's arguably
// worse for the geocoder than the bare address was, since it now
// actively asserts a contradiction instead of just omitting information.
// Detected as "there's a comma, and the text after the last comma isn't
// itself a street-address fragment (apartment/unit markers, mostly
// digits)" — loose on purpose, since the cost of a false positive here
// (skipping the state append for an address that still lacks one) is
// just falling back to relying on `bounds` alone for that one address,
// not a hard failure.
function hasLikelyCity(address) {
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const lastPart = parts[parts.length - 1];
  // Reject a trailing fragment that's clearly still part of the street
  // address, not a city (e.g. "123 Main St, Apt 4" or "123 Main St, #4").
  const looksLikeUnitFragment = /^(apt|unit|ste|suite|#|\d)/i.test(lastPart);
  return !looksLikeUnitFragment;
}

function getRegionHint() {
  return import.meta.env?.VITE_GEOCODING_REGION_HINT || DEFAULT_REGION_HINT;
}

function addRegionHintIfMissing(address) {
  if (hasStateAtEnd(address)) return address;
  // A city is already named: do NOT force a state onto it. The old code
  // appended "CT" here, which pushed every Massachusetts stop into
  // Connecticut. Ambiguous city names are resolved afterwards against the
  // rest of the route (resolveGeocodeCluster).
  if (hasLikelyCity(address)) return address;
  return `${address}, ${getRegionHint()}`;
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Geocoding request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}


// ---- candidates and route-level disambiguation ----

function toCandidate(r) {
  const rawConfidence = typeof r.confidence === 'number' ? r.confidence : 0;
  return {
    lat: r.geometry.lat,
    lng: r.geometry.lng,
    // OpenCage confidence is 0-10; the app uses 0-100.
    confidence: Math.round((rawConfidence / 10) * 100),
    score: typeof r.score === 'number' ? r.score : rawConfidence / 10,
    matchedAddress: r.formatted || null,
    houseMatch: Boolean(r.components && r.components.house_number)
  };
}

// Keeps the address exactly as typed (the provider's `formatted` string drops
// house numbers and units); the provider's version is reference only.
function buildResult(typedAddress, cand) {
  const typedHasHouseNumber = /^\s*\d+/.test(typedAddress);
  const streetLevelOnly = typedHasHouseNumber && !cand.houseMatch;
  // Say WHY a stop is flagged so the driver (and I) can see what went wrong.
  let reviewReason = null;
  if (cand.cityMatch === false) reviewReason = 'matched a different town than the one typed';
  else if (streetLevelOnly) reviewReason = 'house number not found, pin is on the street';
  else if (cand.confidence < 80) reviewReason = `low map accuracy (${cand.confidence}%)`;
  return {
    address: typedAddress,
    matchedAddress: cand.matchedAddress || null,
    lat: cand.lat,
    lng: cand.lng,
    confidence: cand.confidence,
    needsReview: Boolean(reviewReason),
    reviewReason,
    error: null
  };
}

function distKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// A Flex block stays inside one metro area. Candidates farther than this from
// the route's centre are treated as the wrong town of the same name.
const ROUTE_RADIUS_KM = 45;

/**
 * Bare city names are ambiguous (Hampden MA vs Hamden CT). Each stop has up to
 * a few candidates; the right ones all sit close together, the wrong ones
 * scatter. Finds the candidate that the most stops have a candidate near, uses
 * it as the route centre, and gives every stop its best-scoring candidate
 * within ROUTE_RADIUS_KM of that centre. Stops with nothing nearby keep their
 * top match but are flagged for review.
 *
 * @param {Array} results geocodeAddress results (with .candidates)
 * @returns {{ results: Array, center: {lat:number,lng:number}|null }}
 */
export function resolveGeocodeCluster(results) {
  const pts = [];
  results.forEach((r, idx) => {
    const list = Array.isArray(r?.candidates) && r.candidates.length ? r.candidates : Number.isFinite(r?.lat) ? [{ lat: r.lat, lng: r.lng, confidence: r.confidence, score: 0 }] : [];
    list.forEach((c) => pts.push({ idx, c }));
  });
  if (pts.length === 0) return { results, center: null };

  let best = null;
  for (const p of pts) {
    const stopsNear = new Set();
    let scoreSum = 0;
    for (const q of pts) {
      if (distKm(p.c.lat, p.c.lng, q.c.lat, q.c.lng) <= ROUTE_RADIUS_KM) {
        if (!stopsNear.has(q.idx)) scoreSum += q.c.score || 0;
        stopsNear.add(q.idx);
      }
    }
    if (!best || stopsNear.size > best.n || (stopsNear.size === best.n && scoreSum > best.s)) {
      best = { p, n: stopsNear.size, s: scoreSum };
    }
  }

  // Refine the centre: average of each stop's best candidate near the seed.
  const seed = best.p.c;
  const near = [];
  results.forEach((r, idx) => {
    const list = pts.filter((q) => q.idx === idx && distKm(seed.lat, seed.lng, q.c.lat, q.c.lng) <= ROUTE_RADIUS_KM);
    if (list.length) near.push(list.sort((a, b) => (b.c.score || 0) - (a.c.score || 0))[0].c);
  });
  const center = {
    lat: near.reduce((s, c) => s + c.lat, 0) / near.length,
    lng: near.reduce((s, c) => s + c.lng, 0) / near.length
  };

  const resolved = results.map((r) => {
    if (!r || !Array.isArray(r.candidates) || r.candidates.length === 0) {
      if (r && Number.isFinite(r.lat) && distKm(center.lat, center.lng, r.lat, r.lng) > ROUTE_RADIUS_KM) return { ...r, needsReview: true, farFromRoute: true, reviewReason: 'far from the rest of the route' };
      return r;
    }
    const within = r.candidates
      .filter((c) => distKm(center.lat, center.lng, c.lat, c.lng) <= ROUTE_RADIUS_KM)
      .sort((a, b) => (b.score || 0) - (a.score || 0));
    if (within.length === 0) return { ...r, needsReview: true, farFromRoute: true, reviewReason: 'far from the rest of the route' };
    const chosen = within[0];
    if (chosen.lat === r.lat && chosen.lng === r.lng) return r;
    return { ...r, ...buildResult(r.address, chosen), candidates: r.candidates };
  });
  return { results: resolved, center };
}

/**
 * For one added/edited stop: pick the candidate nearest a known point (the
 * route centre). Returns the result unchanged when there is nothing better.
 */
export function pickCandidateNear(result, center) {
  if (!result || !center || !Array.isArray(result.candidates) || result.candidates.length === 0) return result;
  const within = result.candidates
    .filter((c) => distKm(center.lat, center.lng, c.lat, c.lng) <= ROUTE_RADIUS_KM)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (within.length === 0) return { ...result, needsReview: true, farFromRoute: true, reviewReason: 'far from the rest of the route' };
  const chosen = within[0];
  if (chosen.lat === result.lat && chosen.lng === result.lng) return result;
  return { ...result, ...buildResult(result.address, chosen), candidates: result.candidates };
}

/**
 * Centre of a set of located stops (median, so one stray stop can't drag it).
 */
export function routeCenter(stops) {
  const pts = (stops || []).filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng));
  if (pts.length === 0) return null;
  const med = (arr) => {
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  return { lat: med(pts.map((p) => p.lat)), lng: med(pts.map((p) => p.lng)) };
}

/**
 * Geocodes a single address via /api/geocode, a same-origin serverless
 * proxy in front of OpenCage's geocoding API (free tier: 2,500
 * requests/day, needs OPENCAGE_API_KEY set server-side). Never throws —
 * always resolves to a result object so a batch of Promise.all() calls
 * (see App.jsx) can't be taken down by one bad address.
 *
 * Provider history: this started on Mapbox (paid, ran out of quota mid-
 * route for a real driver), briefly moved to the free US Census Bureau
 * Geocoder, then off it again — Census has no published SLA and is
 * independently documented as unreliable under real load (frequent
 * downtime, hangs, inconsistent results under "processing load," per the
 * Census Bureau's own FAQ and third-party reports). A real driver hit
 * this directly: every address in a route failing identically, which is
 * the signature of the upstream service being down, not bad address
 * data. Moved to OpenCage, which publishes an actual uptime status page.
 * Routed through a server-side proxy regardless of provider — not just
 * for the CORS issue Census specifically had, but so a future provider
 * swap only touches api/geocode.js and this file, never client call sites.
 *
 * @param {string} rawAddress
 * @param {string} [_unusedToken] - kept as a positional param for
 *   backward compatibility with existing call sites; the API key lives
 *   server-side only (never sent to or accepted from the client), so this
 *   is accepted and ignored rather than forcing every caller to be
 *   updated in lockstep.
 * @param {{ proximity?: { lat: number, lng: number } }} [options] -
 *   proximity is accepted for API compatibility but not currently sent to
 *   OpenCage (its bounds-based filtering already does the job this app
 *   needs — a hard territory constraint — better than proximity ranking
 *   would for a fixed CT/MA service area).
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
  // geocoding provider exactly as before, so this can only reduce calls,
  // never change what a fresh lookup would have returned.
  const cached = getCachedGeocode(trimmedAddress);
  if (cached) {
    // Older cache entries stored the provider's shortened address; always show the typed one.
    return { ...cached, address: trimmedAddress, error: null };
  }

  const queryAddress = addRegionHintIfMissing(stripUnitInfo(trimmedAddress) || trimmedAddress);
  const params = new URLSearchParams({ address: queryAddress, bounds: getGeocodingBboxString() });
  const url = `/api/geocode?${params.toString()}`;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS);
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt === MAX_RETRIES) {
          let errorDetail = `Geocoding request failed (${res.status})`;
          try {
            const errBody = await res.json();
            if (errBody?.error) errorDetail = errBody.error;
          } catch {
            // Response wasn't JSON — keep the generic status-based message.
          }
          return { ...fallback, error: errorDetail };
        }
        await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
        continue;
      }

      const data = await res.json();
      const results = data?.results;

      if (!Array.isArray(results) || results.length === 0) {
        // With `bounds` applied server-side, "no results" can legitimately
        // mean "this address is outside the configured territory" rather
        // than "couldn't be read" — OpenCage's bounds param excludes
        // out-of-area matches entirely rather than returning them for a
        // client-side check the way the old Census-backed code needed.
        return { ...fallback, error: 'No match found within the configured service area (CT/MA)' };
      }

      // The typed city (text after the last comma) should appear in the matched
      // place; a candidate in a different town scores lower.
      const typedCity = hasLikelyCity(trimmedAddress) ? trimmedAddress.split(',').pop().trim().toLowerCase() : '';
      const candidates = results
        .filter((r) => r?.geometry && typeof r.geometry.lat === 'number' && typeof r.geometry.lng === 'number')
        .slice(0, 6)
        .map(toCandidate)
        .map((c) => {
          if (!typedCity || typedCity.length < 3) return c;
          const inMatch = String(c.matchedAddress || '').toLowerCase().includes(typedCity);
          return { ...c, cityMatch: inMatch, score: c.score + (inMatch ? 1.5 : -1) };
        })
        .sort((a, b) => b.score - a.score);
      if (candidates.length === 0) return { ...fallback, error: 'Malformed geocode response' };
      const result = { ...buildResult(trimmedAddress, candidates[0]), candidates };
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
 * Geocodes a batch of addresses with limited concurrency, staying well
 * under OpenCage's free-tier daily quota (2,500/day) and per-second rate
 * limit for a single driver's realistic route sizes.
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
