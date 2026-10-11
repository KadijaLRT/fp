import { legSeconds } from './etaEstimate.js';

/**
 * Learns how the app's modeled driving time compares with how long the
 * driver's real legs take, so the "time saved vs Amazon's order" estimate
 * improves with use instead of trusting a fixed guess.
 *
 * What is measured: the time between consecutive "delivered" taps (one
 * leg = driving to the next stop + serving it) against the modeled drive
 * time between those two stops. Fitting  legSeconds = service + k * model
 * over many legs separates the per-stop service time from k, the factor by
 * which the model's drive time is off for this driver and area.
 *
 * What is NOT measurable: the route the driver did not take. The estimate
 * therefore stays a range, and a further caution factor is applied
 * (OPTIMIZER_CAUTION) because an optimizer's own score of its route is
 * always optimistic: it exploits straight-line shortcuts that real roads
 * may not have.
 */

const LEGS_KEY = 'flexpulse.driveLegs.v1';
const LOG_KEY = 'flexpulse.completionLog.v1';
const MAX_LEGS = 400;
const MIN_LEGS_TO_CALIBRATE = 20;

// Before any data: one real report (the model said ~71 min saved; the
// driver judged the real saving at roughly 20 to 30 min) implies ~0.35.
const PRIOR_K = 0.35;
const PRIOR_SPREAD = [0.6, 1.4];
const CALIBRATED_SPREAD = [0.75, 1.25];
const OPTIMIZER_CAUTION = 0.75;

function safeGet(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function safeSet(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota): learning just doesn't persist */
  }
}

// ---- pure math (no storage), exported for testing ----

function ols(points) {
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.d, 0) / n;
  const my = points.reduce((a, p) => a + p.L, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.d - mx) ** 2;
    sxy += (p.d - mx) * (p.L - my);
  }
  if (sxx < 1e-6) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

/**
 * @param {Array<{d:number,L:number}>} legs d = modeled drive seconds, L = real leg seconds
 * @returns {{ k:number, serviceSeconds:number, legsUsed:number } | null}
 */
export function fitCalibration(legs) {
  const clean = (legs || []).filter(
    (l) => Number.isFinite(l?.d) && Number.isFinite(l?.L) && l.d >= 0 && l.L >= 20 && l.L <= 1800
  );
  if (clean.length < MIN_LEGS_TO_CALIBRATE) return null;

  let fit = ols(clean);
  if (!fit) return null;
  // One robust pass: drop legs far from the line (breaks, gas, waiting at
  // a locked gate) and refit.
  const res = clean.map((p) => p.L - (fit.intercept + fit.slope * p.d));
  const sortedAbs = res.map(Math.abs).sort((a, b) => a - b);
  const mad = sortedAbs[Math.floor(sortedAbs.length / 2)] || 0;
  let kept = clean;
  if (mad > 0) {
    kept = clean.filter((_, i) => Math.abs(res[i]) <= 3 * 1.4826 * mad);
    if (kept.length >= MIN_LEGS_TO_CALIBRATE) {
      fit = ols(kept) || fit;
    } else {
      kept = clean;
    }
  }
  if (!(fit.slope > 0)) return null;
  return {
    k: Math.min(1.5, Math.max(0.3, fit.slope)),
    serviceSeconds: Math.min(600, Math.max(30, fit.intercept)),
    legsUsed: kept.length
  };
}

/**
 * Turns the model's saved-seconds figure into a range of real-world
 * seconds. Positive = optimized route drives less than Amazon's.
 *
 * @param {number} modelSavedSeconds
 * @param {{k:number,legsUsed:number}|null} calibration
 * @returns {{ lowSeconds:number, highSeconds:number, calibrated:boolean, legsUsed:number }}
 */
export function estimateSavings(modelSavedSeconds, calibration) {
  const calibrated = !!calibration;
  const k = calibrated ? calibration.k * OPTIMIZER_CAUTION : PRIOR_K;
  const [lo, hi] = calibrated ? CALIBRATED_SPREAD : PRIOR_SPREAD;
  const mid = modelSavedSeconds * k;
  const a = mid * lo;
  const b = mid * hi;
  return {
    lowSeconds: Math.min(a, b),
    highSeconds: Math.max(a, b),
    calibrated,
    legsUsed: calibrated ? calibration.legsUsed : 0
  };
}

/** "15 to 30 min" style label, rounded outward to 5 minutes; null if negligible. */
export function formatRangeMinutes(lowSeconds, highSeconds) {
  const lo = Math.floor(Math.abs(lowSeconds) / 60 / 5) * 5;
  const hi = Math.ceil(Math.abs(highSeconds) / 60 / 5) * 5;
  if (hi <= 5) return null;
  if (lo === hi) return `${hi} min`;
  return lo <= 0 ? `up to ${hi} min` : `${lo} to ${hi} min`;
}

// ---- storage-backed helpers ----

export function getCalibration() {
  return fitCalibration(safeGet(LEGS_KEY) || []);
}

/** Records one "delivered" tap. Entries are tied to a route by its start time. */
export function logCompletion(routeStartedAtMs, entry) {
  if (!routeStartedAtMs) return;
  const stored = safeGet(LOG_KEY);
  const entries = stored && stored.routeStartedAtMs === routeStartedAtMs ? stored.entries : [];
  safeSet(LOG_KEY, { routeStartedAtMs, entries: [...entries, entry] });
}

/**
 * Turns the route's completion log into legs, adds them to the learning
 * history and clears the log. Legs are skipped when either end was marked
 * from the list view (its tap time says nothing about when it was served),
 * and the first stop has no previous point to measure a leg from.
 */
export function commitRouteLegs(routeStartedAtMs) {
  const stored = safeGet(LOG_KEY);
  if (!stored || stored.routeStartedAtMs !== routeStartedAtMs) return 0;
  const entries = [...stored.entries].sort((a, b) => a.atMs - b.atMs);
  const legs = [];
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (prev.fromList || cur.fromList) continue;
    if (![prev.lat, prev.lng, cur.lat, cur.lng].every((v) => typeof v === 'number')) continue;
    const L = (cur.atMs - prev.atMs) / 1000;
    if (L < 20 || L > 1800) continue;
    legs.push({ d: legSeconds(prev, cur), L });
  }
  const history = safeGet(LEGS_KEY) || [];
  safeSet(LEGS_KEY, [...history, ...legs].slice(-MAX_LEGS));
  safeSet(LOG_KEY, null);
  return legs.length;
}
