import { checkRateLimit, sendRateLimitResponse } from './_rateLimit.js';

// No external routing API. Earlier versions called Mapbox, then
// OpenRouteService, for real driving times; both caused failures (keys,
// daily quotas, outages) that broke route building mid-shift. Driving
// time between stops is now estimated locally from coordinates, so
// optimization has no network dependency, no key, and no quota.
//
// Estimate: straight-line (haversine) distance, scaled by a road-
// circuity factor (real roads are longer than the crow flies; ~1.3-1.4 is
// the usual figure for suburban street grids), divided by an average
// delivery-driving speed that already bakes in turns and stop signs.
const ROAD_CIRCUITY_FACTOR = 1.35;
const AVG_SPEED_METERS_PER_SEC = 9; // ~32 km/h / 20 mph residential driving
// Hard ceiling so a pathological request can't blow the function's budget.
const MAX_TOTAL_STOPS = 100;

function isValidCoord(stop) {
  return (
    stop &&
    typeof stop.lat === 'number' &&
    typeof stop.lng === 'number' &&
    Number.isFinite(stop.lat) &&
    Number.isFinite(stop.lng) &&
    stop.lat >= -90 &&
    stop.lat <= 90 &&
    stop.lng >= -180 &&
    stop.lng <= 180
  );
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Full N x N estimated driving-time matrix in seconds (0 on the diagonal). */
function buildFullDurationMatrix(stops) {
  const n = stops.length;
  const full = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const seconds = (haversineMeters(stops[i], stops[j]) * ROAD_CIRCUITY_FACTOR) / AVG_SPEED_METERS_PER_SEC;
      full[i][j] = seconds;
      full[j][i] = seconds;
    }
  }
  return full;
}

/**
 * Converts a stop's delivery window into an "urgency multiplier" applied to
 * travel cost — stops with a tighter/closer deadline get a lower effective
 * cost so the solver is pulled toward them, without ever going negative
 * (the previous flat "-300 seconds" hack could make cost negative and
 * scramble the whole ordering regardless of actual distance).
 */
function urgencyMultiplier(stop, nowMs) {
  if (!stop.deliveryWindowEnd) return 1;
  const deadline = new Date(stop.deliveryWindowEnd).getTime();
  if (!Number.isFinite(deadline)) return 1;

  const minutesUntilDeadline = (deadline - nowMs) / 60000;
  if (minutesUntilDeadline <= 15) return 0.5; // urgent — halve effective cost
  if (minutesUntilDeadline <= 45) return 0.75;
  if (minutesUntilDeadline <= 90) return 0.9;
  return 1;
}

/**
 * Cost of the directed edge "arrive at `toIdx` having just left `fromIdx`".
 * Shared by both the nearest-neighbor construction and the 2-opt refinement
 * pass below so the two stages can't silently disagree about what "cost"
 * means. Deliberately asymmetric (durations[a][b] != durations[b][a] in
 * real driving times, and urgency/stop-duration modifiers are properties of
 * the destination stop, not the pair) — see the note on twoOptImprove.
 */
function computeEdgeCost(fromIdx, toIdx, stops, durations, strategy, nowMs) {
  const candidate = stops[toIdx];
  const rawDuration = durations?.[fromIdx]?.[toIdx];
  // A missing/non-numeric duration is treated as heavily penalized
  // rather than crashing on NaN math or silently treating it as "free"
  // (0/undefined).
  let cost = typeof rawDuration === 'number' ? rawDuration : 6 * 3600; // 6hr penalty

  if (strategy === 'simplest' && candidate.stopType === 'apartment') {
    cost *= 1.3;
  }

  cost *= urgencyMultiplier(candidate, nowMs);

  // Personalized stop-duration modifier (per the project's domain reasoning
  // model: total completion time = driving + parking + walking + delivery +
  // access delays). A location this driver (or the crowd) has historically
  // found slow should weigh into the ordering, not just raw drive time.
  if (typeof candidate.avgTotalStopSeconds === 'number' && candidate.avgTotalStopSeconds > 0) {
    cost += candidate.avgTotalStopSeconds * 0.5;
  }

  return cost;
}

function totalRouteCost(orderIdxs, stops, durations, strategy, nowMs) {
  let sum = 0;
  for (let i = 0; i < orderIdxs.length - 1; i++) {
    sum += computeEdgeCost(orderIdxs[i], orderIdxs[i + 1], stops, durations, strategy, nowMs);
  }
  return sum;
}

/**
 * Nearest-neighbor construction: fast, but greedy, so it can lock in an
 * early "good-looking" move that forces an expensive zig-zag later (the
 * classic TSP failure mode). Produces the starting tour that 2-opt then
 * refines.
 */
function nearestNeighborOrder(stops, durations, strategy, nowMs) {
  const n = stops.length;
  const visited = new Array(n).fill(false);
  const order = [0];
  visited[0] = true;
  let current = 0;

  for (let step = 1; step < n; step++) {
    let bestIdx = -1;
    let lowestCost = Infinity;
    for (let candidate = 0; candidate < n; candidate++) {
      if (visited[candidate]) continue;
      const cost = computeEdgeCost(current, candidate, stops, durations, strategy, nowMs);
      if (cost < lowestCost) {
        lowestCost = cost;
        bestIdx = candidate;
      }
    }
    order.push(bestIdx);
    visited[bestIdx] = true;
    current = bestIdx;
  }

  return order;
}

// Safety nets so 2-opt can never blow a serverless function's time budget,
// even in a pathological worst case — bail out and return the best tour
// found so far rather than timing out with nothing.
const TWO_OPT_TIME_BUDGET_MS = 3000;
const TWO_OPT_MAX_EVALUATIONS = 400000;

/**
 * Classic 2-opt local search adapted for an *open, directed* path (the
 * driver's current location is a fixed start; there's no return trip, and
 * edge cost is directional). Repeatedly tries reversing a sub-segment of
 * the route and keeps the reversal if it lowers total cost. Because costs
 * here are asymmetric (real driving times differ by direction, and
 * urgency/stop-duration modifiers depend on which stop is the destination),
 * a reversal changes the cost of every edge *inside* the reversed segment
 * too, not just its two endpoints — so unlike textbook symmetric 2-opt this
 * recomputes the affected segment's cost directly rather than using an O(1)
 * delta. That's O(n) per candidate swap, O(n^3) per full pass; trivial at
 * the sizes this app handles (≤100 stops) but bounded by an explicit time
 * and evaluation-count budget regardless.
 */
function twoOptImprove(initialOrder, stops, durations, strategy, nowMs) {
  let route = initialOrder.slice();
  const startTime = Date.now();
  let evaluations = 0;
  let improved = true;

  while (improved) {
    improved = false;

    outer: for (let i = 1; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        evaluations++;
        if (evaluations > TWO_OPT_MAX_EVALUATIONS || Date.now() - startTime > TWO_OPT_TIME_BUDGET_MS) {
          break outer;
        }

        // Only the edges touching the reversed segment [i, j] can change:
        // (i-1 -> i) and (j -> j+1) are replaced by (i-1 -> j) and (i -> j+1),
        // and every internal edge in the segment reverses direction.
        const before =
          computeEdgeCost(route[i - 1], route[i], stops, durations, strategy, nowMs) +
          totalRouteCost(route.slice(i, j + 1), stops, durations, strategy, nowMs) +
          (j + 1 < route.length
            ? computeEdgeCost(route[j], route[j + 1], stops, durations, strategy, nowMs)
            : 0);

        const reversedSegment = route.slice(i, j + 1).reverse();
        const after =
          computeEdgeCost(route[i - 1], reversedSegment[0], stops, durations, strategy, nowMs) +
          totalRouteCost(reversedSegment, stops, durations, strategy, nowMs) +
          (j + 1 < route.length
            ? computeEdgeCost(reversedSegment[reversedSegment.length - 1], route[j + 1], stops, durations, strategy, nowMs)
            : 0);

        if (after < before - 0.01) {
          route = [...route.slice(0, i), ...reversedSegment, ...route.slice(j + 1)];
          improved = true;
        }
      }
    }
  }

  return route;
}

/**
 * Nearest-neighbor construction followed by 2-opt refinement. Not a true
 * global TSP optimum (that's NP-hard), but meaningfully better than
 * nearest-neighbor alone — 2-opt specifically eliminates the "zig-zag"
 * crossings greedy construction is prone to leaving behind.
 */
function solveRoute(stops, durations, strategy) {
  const nowMs = Date.now();
  const initialOrder = nearestNeighborOrder(stops, durations, strategy, nowMs);
  const refinedOrder = twoOptImprove(initialOrder, stops, durations, strategy, nowMs);
  return refinedOrder;
}

/**
 * Pure driving-time sum for the final order — raw ORS durations only, no
 * urgency/stop-duration modifiers. This is what gets stored as
 * routes.est_duration_seconds so a later efficiency-score calculation
 * (actual wall-clock time vs. this estimate) is comparing against a real
 * driving-time figure rather than the modifier-weighted "cost" the solver
 * itself optimizes on.
 */
function estimateDrivingSeconds(orderIdxs, durations) {
  let sum = 0;
  for (let i = 0; i < orderIdxs.length - 1; i++) {
    const d = durations?.[orderIdxs[i]]?.[orderIdxs[i + 1]];
    if (typeof d === 'number') sum += d;
  }
  return Math.round(sum);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rateLimit = await checkRateLimit(req, 'optimize');
  if (!rateLimit.allowed) {
    return sendRateLimitResponse(res, rateLimit);
  }

  try {
    const { stops, strategy = 'fastest' } = req.body || {};

    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: 'At least 2 stops with coordinates are required.' });
    }
    if (!['fastest', 'least_driving', 'simplest'].includes(strategy)) {
      return res.status(400).json({ error: 'Invalid strategy.' });
    }
    if (stops.length > MAX_TOTAL_STOPS) {
      return res.status(400).json({
        error: `This route has ${stops.length} stops, which exceeds the ${MAX_TOTAL_STOPS}-stop limit for a single optimization request.`
      });
    }

    const invalidStops = stops.filter((s) => !isValidCoord(s));
    if (invalidStops.length > 0) {
      return res.status(422).json({
        error: `${invalidStops.length} stop(s) are missing valid coordinates. Fix or remove them before optimizing.`,
        invalidStopIds: invalidStops.map((s) => s.id).filter(Boolean)
      });
    }

    const durations = buildFullDurationMatrix(stops);

    const optimizedOrderIdxs = solveRoute(stops, durations, strategy);
    const optimizedStops = optimizedOrderIdxs.map((idx) => stops[idx]);
    const estimatedDrivingSeconds = estimateDrivingSeconds(optimizedOrderIdxs, durations);

    return res.status(200).json({
      success: true,
      strategy,
      optimizedStops,
      estimatedDrivingSeconds
    });
  } catch (error) {
    console.error('Unhandled optimize endpoint error:', error);
    return res.status(500).json({ error: 'Failed to optimize route.' });
  }
}
