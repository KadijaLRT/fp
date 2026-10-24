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
const AVG_SPEED_METERS_PER_SEC = 9; // ~20 mph residential driving
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
 * Real road driving times from the Mapbox Matrix API (profile "driving").
 * The API accepts at most 25 coordinates per request, so stops are split
 * into chunks of 12 and every ordered chunk pair is requested (sources =
 * first chunk, destinations = second chunk). Any request that fails or
 * times out leaves its cells to the local straight-line estimate, so a
 * Mapbox hiccup degrades accuracy but never breaks route building.
 *
 * @returns {Promise<{ durations:number[][], source:'road'|'mixed'|'estimate' }>}
 */
async function buildDurations(nodes) {
  const estimate = buildFullDurationMatrix(nodes);
  const token = process.env.MAPBOX_ACCESS_TOKEN;
  if (!token || nodes.length < 2) return { durations: estimate, source: 'estimate' };

  const n = nodes.length;
  const CHUNK = 12;
  const chunks = [];
  for (let i = 0; i < n; i += CHUNK) chunks.push(Array.from({ length: Math.min(CHUNK, n - i) }, (_, k) => i + k));

  const jobs = [];
  for (const I of chunks) for (const J of chunks) jobs.push({ I, J });

  const durations = estimate.map((row) => row.slice());
  let okCells = 0;
  const totalCells = n * n - n;
  const controller = new AbortController();
  const overall = setTimeout(() => controller.abort(), 6500); // stay inside the function's time budget

  async function run({ I, J }) {
    const same = I === J;
    const idx = same ? I : [...I, ...J];
    const coords = idx.map((k) => `${nodes[k].lng.toFixed(6)},${nodes[k].lat.toFixed(6)}`).join(';');
    const qs = new URLSearchParams({ annotations: 'duration', access_token: token });
    if (!same) {
      qs.set('sources', I.map((_, k) => k).join(';'));
      qs.set('destinations', J.map((_, k) => I.length + k).join(';'));
    }
    try {
      const res = await fetch(`https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coords}?${qs.toString()}`, { signal: controller.signal });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.code !== 'Ok' || !Array.isArray(data.durations)) return;
      I.forEach((a, r) => {
        J.forEach((b, c) => {
          const v = data.durations[r]?.[c];
          if (a !== b && typeof v === 'number' && Number.isFinite(v)) {
            durations[a][b] = v;
            okCells++;
          }
        });
      });
    } catch {
      /* aborted or network error: those cells keep the estimate */
    }
  }

  // Small pool: well under Mapbox's per-minute request limit.
  let cursor = 0;
  const workers = Array.from({ length: 4 }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      await run(job);
    }
  });
  await Promise.all(workers);
  clearTimeout(overall);

  const source = okCells === 0 ? 'estimate' : okCells >= totalCells ? 'road' : 'mixed';
  return { durations: source === 'estimate' ? estimate : durations, source };
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
function nearestNeighborOrder(stops, durations, strategy, nowMs, startIdx = 0) {
  const n = stops.length;
  const visited = new Array(n).fill(false);
  const order = [startIdx];
  visited[startIdx] = true;
  let current = startIdx;

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
 * Or-opt: move a block of 1-3 consecutive stops to a better position
 * (optionally reversed). 2-opt alone can't fix a single stop that sits on
 * the wrong "side" of the route, which is exactly what shows up as
 * backtracking (drive past a stop, come back for it later). `fixedStart`
 * keeps index 0 of the path in place (used when a real origin is given).
 */
function orOptImprove(initialOrder, stops, durations, strategy, nowMs, deadline, fixedStart) {
  let route = initialOrder.slice();
  const minPos = fixedStart ? 1 : 0;
  let improved = true;
  let best = totalRouteCost(route, stops, durations, strategy, nowMs);

  while (improved && Date.now() < deadline) {
    improved = false;
    for (let len = 1; len <= 3 && !improved; len++) {
      for (let i = minPos; i + len <= route.length && !improved; i++) {
        const segment = route.slice(i, i + len);
        const rest = [...route.slice(0, i), ...route.slice(i + len)];
        for (let k = minPos; k <= rest.length; k++) {
          if (k === i) continue;
          for (const seg of len > 1 ? [segment, [...segment].reverse()] : [segment]) {
            const candidate = [...rest.slice(0, k), ...seg, ...rest.slice(k)];
            const c = totalRouteCost(candidate, stops, durations, strategy, nowMs);
            if (c < best - 0.01) {
              best = c;
              route = candidate;
              improved = true;
              break;
            }
          }
          if (improved) break;
        }
      }
    }
  }
  return route;
}

/**
 * Builds nearest-neighbor tours from EVERY possible start (or only the
 * fixed origin), keeps the best few, then refines them with 2-opt and
 * Or-opt until neither finds an improvement, and returns the cheapest.
 * Starting from every stop matters: the old code always began at the first
 * stop in the list, which forced the whole route to be built around an
 * arbitrary starting point and created long backtracking legs.
 */
function solveRoute(stops, durations, strategy, fixedStart = false) {
  const nowMs = Date.now();
  const n = stops.length;
  const starts = fixedStart ? [0] : Array.from({ length: n }, (_, i) => i);

  const seeds = starts
    .map((st) => {
      const order = nearestNeighborOrder(stops, durations, strategy, nowMs, st);
      return { order, cost: totalRouteCost(order, stops, durations, strategy, nowMs) };
    })
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 4);

  const deadline = Date.now() + 4000;
  let bestOrder = seeds[0].order;
  let bestCost = seeds[0].cost;
  for (const seed of seeds) {
    if (Date.now() > deadline) break;
    let order = seed.order;
    // Alternate until neither move type improves (bounded by the deadline).
    for (let round = 0; round < 6 && Date.now() < deadline; round++) {
      const before = totalRouteCost(order, stops, durations, strategy, nowMs);
      order = twoOptImprove(order, stops, durations, strategy, nowMs);
      order = orOptImprove(order, stops, durations, strategy, nowMs, deadline, fixedStart);
      const after = totalRouteCost(order, stops, durations, strategy, nowMs);
      if (after >= before - 0.01) break;
    }
    const cost = totalRouteCost(order, stops, durations, strategy, nowMs);
    if (cost < bestCost) {
      bestCost = cost;
      bestOrder = order;
    }
  }
  return bestOrder;
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
    const { stops, strategy = 'fastest', origin = null } = req.body || {};

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

    // Optional real starting point (the driver's position): added as a
    // fixed virtual first node, then stripped from the result. Without one
    // the route may start at whichever stop makes the whole path shortest.
    const hasOrigin = isValidCoord(origin);
    const nodes = hasOrigin ? [{ id: '__origin__', lat: origin.lat, lng: origin.lng }, ...stops] : stops;
    const { durations, source: routingSource } = await buildDurations(nodes);

    let orderIdxs = solveRoute(nodes, durations, strategy, hasOrigin);
    const estimatedDrivingSeconds = estimateDrivingSeconds(orderIdxs, durations);
    if (hasOrigin) orderIdxs = orderIdxs.filter((i) => i !== 0).map((i) => i - 1);
    const optimizedStops = orderIdxs.map((idx) => stops[idx]);

    // Pairwise drive times for the real stops (origin row/column removed) so the
    // app can price ANY order (Amazon's, drag-and-drop edits) with the same
    // road times instead of straight-line guesses.
    const offset = hasOrigin ? 1 : 0;
    const matrix = {
      ids: stops.map((st) => st.id),
      seconds: stops.map((_, i) => stops.map((__, j) => Math.round(durations[i + offset][j + offset])))
    };

    return res.status(200).json({
      success: true,
      strategy,
      optimizedStops,
      estimatedDrivingSeconds,
      routingSource,
      matrix
    });
  } catch (error) {
    console.error('Unhandled optimize endpoint error:', error);
    return res.status(500).json({ error: 'Failed to optimize route.' });
  }
}
