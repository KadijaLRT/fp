import { distanceMeters } from './geolocation.js';

/**
 * Fallback route solver used only when the network is unreachable and
 * /api/optimize can't be called. Uses straight-line (haversine) distance
 * instead of real driving times, since there's no way to hit the Mapbox
 * Matrix API offline — this is explicitly a rougher approximation than the
 * server-side solver, not a full replacement for it. The moment
 * connectivity returns, the app should go back to calling /api/optimize
 * for anything new; this exists so a driver isn't stuck with an
 * unoptimized list during a dead zone, not as a permanent substitute.
 *
 * Reuses the same nearest-neighbor + 2-opt structure as api/optimize.js
 * for consistency, but is a separate, simpler implementation (no
 * time-window/stop-duration modifiers, no chunked-matrix concerns) since
 * it only ever runs against straight-line distance for a route already
 * loaded into memory.
 */

function buildHaversineMatrix(stops) {
  const n = stops.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const d = distanceMeters(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng);
      matrix[i][j] = d ?? Number.MAX_SAFE_INTEGER;
    }
  }
  return matrix;
}

function nearestNeighborOrder(matrix, n) {
  const visited = new Array(n).fill(false);
  const order = [0];
  visited[0] = true;
  let current = 0;

  for (let step = 1; step < n; step++) {
    let best = -1;
    let bestDist = Infinity;
    for (let c = 0; c < n; c++) {
      if (visited[c]) continue;
      if (matrix[current][c] < bestDist) {
        bestDist = matrix[current][c];
        best = c;
      }
    }
    order.push(best);
    visited[best] = true;
    current = best;
  }
  return order;
}

function routeCost(order, matrix) {
  let sum = 0;
  for (let i = 0; i < order.length - 1; i++) {
    sum += matrix[order[i]][order[i + 1]];
  }
  return sum;
}

const TWO_OPT_TIME_BUDGET_MS = 1500; // tighter than the server solver — this runs on a phone, not a serverless function

function twoOptImprove(initialOrder, matrix) {
  let route = initialOrder.slice();
  const startTime = Date.now();
  let improved = true;

  while (improved) {
    improved = false;
    outer: for (let i = 1; i < route.length - 1; i++) {
      for (let j = i + 1; j < route.length; j++) {
        if (Date.now() - startTime > TWO_OPT_TIME_BUDGET_MS) break outer;

        const before =
          matrix[route[i - 1]][route[i]] +
          routeCost(route.slice(i, j + 1), matrix) +
          (j + 1 < route.length ? matrix[route[j]][route[j + 1]] : 0);

        const reversed = route.slice(i, j + 1).reverse();
        const after =
          matrix[route[i - 1]][reversed[0]] +
          routeCost(reversed, matrix) +
          (j + 1 < route.length ? matrix[reversed[reversed.length - 1]][route[j + 1]] : 0);

        if (after < before - 0.01) {
          route = [...route.slice(0, i), ...reversed, ...route.slice(j + 1)];
          improved = true;
        }
      }
    }
  }

  return route;
}

/**
 * Solves a route locally using straight-line distance. `stops` must
 * already have valid lat/lng — filter those out before calling, same as
 * the server path. Returns the reordered stops array.
 */
export function solveRouteOffline(stops) {
  if (!Array.isArray(stops) || stops.length < 2) return stops;

  const matrix = buildHaversineMatrix(stops);
  const initialOrder = nearestNeighborOrder(matrix, stops.length);
  const refinedOrder = twoOptImprove(initialOrder, matrix);
  return refinedOrder.map((idx) => stops[idx]);
}
