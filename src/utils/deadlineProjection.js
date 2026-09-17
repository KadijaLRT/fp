/**
 * Projects when the current route will finish, and compares it against a
 * driver-set hard deadline (e.g. "need to be home and ready before an
 * 8:30am school drop-off"). This is a heuristic, not a guarantee — it
 * linearly extrapolates from pace-so-far, which is the same honest
 * limitation every ETA estimate has (early stops are rarely representative
 * of the whole route, apartment complexes cluster unpredictably, etc).
 * The value is directional ("you're fine" / "you're cutting it close" /
 * "you're going to be late"), not a precise promise.
 */

/**
 * @param {number} routeStartedAtMs - when the route began
 * @param {number} nowMs - current time
 * @param {number} completedStopCount - stops finished so far
 * @param {number} totalStopCount - total stops on the route
 * @param {number|null} estDurationSeconds - the optimizer's initial pure-driving-time estimate, used as a fallback before any stops are completed (no pace data yet to extrapolate from)
 * @returns {{ projectedFinishMs: number, source: 'pace'|'estimate'|null }}
 */
export function projectRouteFinish(routeStartedAtMs, nowMs, completedStopCount, totalStopCount, estDurationSeconds) {
  if (!routeStartedAtMs || !totalStopCount || totalStopCount <= 0) {
    return { projectedFinishMs: null, source: null };
  }

  if (completedStopCount > 0) {
    // Extrapolate from actual pace: (elapsed / stops done) * total stops.
    const elapsedMs = nowMs - routeStartedAtMs;
    const msPerStop = elapsedMs / completedStopCount;
    return { projectedFinishMs: routeStartedAtMs + msPerStop * totalStopCount, source: 'pace' };
  }

  if (typeof estDurationSeconds === 'number' && estDurationSeconds > 0) {
    // No stops completed yet — fall back to the optimizer's original
    // driving-time-only estimate as a rough starting guess. This
    // understates real time (no stop-service time included), so it should
    // read as optimistic, not authoritative.
    return { projectedFinishMs: routeStartedAtMs + estDurationSeconds * 1000, source: 'estimate' };
  }

  return { projectedFinishMs: null, source: null };
}

/**
 * Parses a "HH:MM" 24-hour time string into a timestamp for the same
 * calendar day as `referenceMs`. Returns null for anything unparseable
 * rather than guessing — a wrong deadline is worse than no deadline.
 */
export function parseDeadlineToday(timeStr, referenceMs = Date.now()) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hour = parseInt(match[1], 10);
  const minute = parseInt(match[2], 10);
  if (hour > 23 || minute > 59) return null;

  const d = new Date(referenceMs);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/**
 * How the projected finish compares to the deadline, bucketed for display.
 * 'comfortable' = 20+ min of buffer, 'tight' = 0-20 min of buffer,
 * 'late' = projected to finish after the deadline.
 */
export function assessDeadlineStatus(projectedFinishMs, deadlineMs) {
  if (projectedFinishMs === null || deadlineMs === null) return null;
  const bufferMs = deadlineMs - projectedFinishMs;
  if (bufferMs < 0) return 'late';
  if (bufferMs < 20 * 60 * 1000) return 'tight';
  return 'comfortable';
}
