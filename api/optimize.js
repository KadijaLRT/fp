import { checkRateLimit, sendRateLimitResponse } from './_rateLimit.js';

// Bug fix, found alongside the same class of bug in api/ocr.js: reduced
// from 15000 so the per-chunk worst case (3 attempts + backoff) fits more
// comfortably within a realistic client timeout budget — see
// computeOptimizeTimeoutMs in App.jsx, which now scales with route size
// instead of using one fixed constant for every route from 2 to 100 stops.
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;
// Mapbox Matrix API caps each individual request at 25 total coordinates
// (sources + destinations combined, deduplicated). For routes larger than
// that we build the full duration matrix out of smaller rectangular
// sub-matrix requests (see buildFullDurationMatrix) instead of rejecting
// the route outright — Flex blocks routinely run 30-40 stops.
const MAPBOX_MAX_COORDS_PER_REQUEST = 25;
const CHUNK_SIZE = 12; // keeps any two-chunk union comfortably under 25
const MATRIX_FETCH_CONCURRENCY = 4;
// Hard ceiling so a pathological request can't fan out into hundreds of
// Mapbox calls and blow the serverless function's time/cost budget.
const MAX_TOTAL_STOPS = 100;

function withTimeout(promise, ms, label = 'request') {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

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

async function fetchMatrixWithRetry(url) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await withTimeout(fetch(url), REQUEST_TIMEOUT_MS, 'Mapbox Matrix request');
      if (!res.ok) {
        const status = res.status;
        const retryable = status === 429 || status >= 500;
        if (!retryable || attempt === MAX_RETRIES) {
          const body = await res.text().catch(() => '');
          throw new Error(`Mapbox Matrix API returned ${status}: ${body.slice(0, 200)}`);
        }
      } else {
        return await res.json();
      }
    } catch (err) {
      lastError = err;
      if (attempt === MAX_RETRIES) break;
    }
    await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
  }
  throw lastError;
}

function chunkIndices(n, size) {
  const chunks = [];
  for (let i = 0; i < n; i += size) {
    chunks.push(Array.from({ length: Math.min(size, n - i) }, (_, k) => i + k));
  }
  return chunks;
}

/**
 * Fetches one rectangular block of the duration matrix: travel times from
 * every stop in `sourceIdxs` to every stop in `destIdxs`. When the two
 * chunks are the same block, sources and destinations are the same set
 * against a single coordinate list; otherwise the request concatenates
 * both chunks' coordinates and points sources/destinations at their
 * respective slices.
 */
async function fetchMatrixBlock(stops, sourceIdxs, destIdxs, mapboxToken) {
  const sameBlock = sourceIdxs === destIdxs;
  const combinedIdxs = sameBlock ? sourceIdxs : [...sourceIdxs, ...destIdxs];
  const coordinatesStr = combinedIdxs.map((idx) => `${stops[idx].lng},${stops[idx].lat}`).join(';');

  // Sources always occupy positions 0..sourceIdxs.length-1 in the combined
  // coordinate list, whether or not this is a same-block query — no need
  // to branch on sameBlock here (a previous version had a no-op ternary
  // computing the identical expression in both arms).
  const sourcesParam = sourceIdxs.map((_, i) => i).join(';');
  const destParam = sameBlock
    ? destIdxs.map((_, i) => i).join(';')
    : destIdxs.map((_, i) => sourceIdxs.length + i).join(';');

  const url =
    `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coordinatesStr}` +
    `?sources=${sourcesParam}&destinations=${destParam}&annotations=duration` +
    `&access_token=${encodeURIComponent(mapboxToken)}`;

  const data = await fetchMatrixWithRetry(url);

  if (data.code && data.code !== 'Ok') {
    throw new Error(data.message || `Mapbox Matrix block error: ${data.code}`);
  }
  if (!Array.isArray(data.durations)) {
    throw new Error('Mapbox response was missing duration data for a matrix block.');
  }

  return { sourceIdxs, destIdxs, durations: data.durations };
}

/**
 * Builds a full N x N duration matrix for an arbitrary number of stops by
 * tiling Mapbox Matrix API calls, each respecting the 25-coordinate cap.
 * Runs blocks with limited concurrency so a 40-stop route (~16 blocks)
 * doesn't fire everything at once and trip Mapbox's rate limit.
 */
async function buildFullDurationMatrix(stops, mapboxToken) {
  const n = stops.length;
  const full = Array.from({ length: n }, () => new Array(n).fill(null));

  if (n <= MAPBOX_MAX_COORDS_PER_REQUEST) {
    const allIdxs = stops.map((_, i) => i);
    const { durations } = await fetchMatrixBlock(stops, allIdxs, allIdxs, mapboxToken);
    return durations;
  }

  const chunks = chunkIndices(n, CHUNK_SIZE);
  const blockPairs = [];
  for (let i = 0; i < chunks.length; i++) {
    for (let j = 0; j < chunks.length; j++) {
      blockPairs.push([chunks[i], chunks[j]]);
    }
  }

  let cursor = 0;
  const errors = [];

  async function worker() {
    while (cursor < blockPairs.length) {
      const idx = cursor++;
      const [sourceIdxs, destIdxs] = blockPairs[idx];
      try {
        const block = await fetchMatrixBlock(
          stops,
          sourceIdxs,
          sourceIdxs === destIdxs ? sourceIdxs : destIdxs,
          mapboxToken
        );
        block.sourceIdxs.forEach((srcGlobal, srcLocal) => {
          block.destIdxs.forEach((destGlobal, destLocal) => {
            full[srcGlobal][destGlobal] = block.durations[srcLocal][destLocal];
          });
        });
      } catch (err) {
        errors.push(err);
      }
    }
  }

  const workers = Array.from({ length: Math.min(MATRIX_FETCH_CONCURRENCY, blockPairs.length) }, worker);
  await Promise.all(workers);

  if (errors.length > 0) {
    console.error(`buildFullDurationMatrix: ${errors.length}/${blockPairs.length} blocks failed`, errors[0]);
    // Partial failure is tolerable — solveRoute already treats a missing
    // (null) duration as a heavily-penalized-but-not-fatal edge. Only bail
    // out entirely if every block failed, since then the matrix is useless.
    if (errors.length === blockPairs.length) {
      throw errors[0];
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
  // Mapbox returns null for unreachable pairs (e.g. across water with no
  // bridge). Treat as heavily penalized rather than crashing on NaN math or
  // silently treating it as "free" (0/undefined).
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
 * Pure driving-time sum for the final order — raw Mapbox durations only, no
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
    const { stops, mapboxToken, strategy = 'fastest' } = req.body || {};

    if (!Array.isArray(stops) || stops.length < 2) {
      return res.status(400).json({ error: 'At least 2 stops with coordinates are required.' });
    }
    if (!mapboxToken || typeof mapboxToken !== 'string') {
      return res.status(400).json({ error: 'Missing Mapbox access token.' });
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

    let durations;
    try {
      durations = await buildFullDurationMatrix(stops, mapboxToken);
    } catch (err) {
      console.error('Failed to build duration matrix:', err);
      return res.status(502).json({ error: 'Failed to reach Mapbox routing service. Please try again.' });
    }

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
