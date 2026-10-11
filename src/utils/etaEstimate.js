import { distanceMeters } from './geolocation.js';

// Same locally-estimated driving model as api/optimize.js: straight-line
// distance x road-circuity factor / average residential speed.
export const ROAD_CIRCUITY_FACTOR = 1.35;
export const AVG_SPEED_METERS_PER_SEC = 9;

// Service time per stop (parking, walking, handoff) used only when there
// is no better data. Houses are quick; apartments take longer.
const DEFAULT_STOP_SECONDS = 150;
const DEFAULT_APARTMENT_STOP_SECONDS = 240;
// Fallback drive time for a leg where either end lacks coordinates.
const UNKNOWN_LEG_SECONDS = 120;
// Completed stops needed before the driver's own average replaces defaults.
const MIN_STOPS_FOR_CALIBRATION = 2;

export function legSeconds(a, b) {
  if (!a || !b) return UNKNOWN_LEG_SECONDS;
  const meters = distanceMeters(a.lat, a.lng, b.lat, b.lng);
  if (meters === null) return UNKNOWN_LEG_SECONDS;
  return (meters * ROAD_CIRCUITY_FACTOR) / AVG_SPEED_METERS_PER_SEC;
}

/**
 * Estimates the time left on a route: driving between the remaining stops
 * (starting from the driver's live position when known) plus service time
 * at each stop.
 *
 * Service time per stop, in priority order: the app's learned average for
 * that exact location, the driver's own average over stops already
 * completed on this route (once enough exist), then generic defaults.
 * Estimate only; traffic, parking and gate codes are not modeled.
 *
 * @param {Array<{lat:?number,lng:?number,avgTotalStopSeconds?:?number,stopType?:string}>} stops
 * @param {number} currentIndex
 * @param {{lat:number,lng:number}|null} driverPosition
 * @param {Array<{durationSeconds:number}>} completedStops
 * @returns {{ remainingSeconds: number, driveSeconds: number, serviceSeconds: number, calibrated: boolean } | null}
 */
export function estimateRemaining(stops, currentIndex, driverPosition, completedStops) {
  if (!Array.isArray(stops) || currentIndex < 0 || currentIndex >= stops.length) return null;
  const remaining = stops.slice(currentIndex);

  const done = (completedStops || [])
    .map((c) => c?.durationSeconds)
    .filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 3600);
  const calibrated = done.length >= MIN_STOPS_FOR_CALIBRATION;
  const driverAvg = calibrated ? done.reduce((a, b) => a + b, 0) / done.length : null;

  const hasCoords = (s) => s && typeof s.lat === 'number' && typeof s.lng === 'number';

  let driveSeconds = 0;
  let serviceSeconds = 0;
  let prev = hasCoords(driverPosition) ? driverPosition : null;

  remaining.forEach((stop, i) => {
    const here = hasCoords(stop) ? stop : null;
    // First leg only counts when the driver's position is known; otherwise
    // there is no meaningful "from" point for it.
    if (i > 0 || prev) driveSeconds += legSeconds(prev, here);
    prev = here || prev;

    const learned = typeof stop.avgTotalStopSeconds === 'number' && stop.avgTotalStopSeconds > 0 ? stop.avgTotalStopSeconds : null;
    const generic = stop.stopType === 'apartment' ? DEFAULT_APARTMENT_STOP_SECONDS : DEFAULT_STOP_SECONDS;
    serviceSeconds += learned ?? driverAvg ?? generic;
  });

  return {
    remainingSeconds: Math.round(driveSeconds + serviceSeconds),
    driveSeconds: Math.round(driveSeconds),
    serviceSeconds: Math.round(serviceSeconds),
    calibrated
  };
}

export function formatDuration(totalSeconds) {
  const mins = Math.max(0, Math.round(totalSeconds / 60));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

function driveSecondsForOrder(list) {
  let total = 0;
  for (let i = 1; i < list.length; i++) total += legSeconds(list[i - 1], list[i]);
  return total;
}

/**
 * Compares estimated driving time for the route in Amazon's own listed
 * order (ascending stopNumber from the screenshots) against the current
 * order, across the WHOLE route so the figure stays stable as stops get
 * completed. Both use the same estimate, and service time is identical
 * either way, so the difference is purely driving. Returns null when it
 * can't be computed fairly (fewer than 2 located stops, or stop numbers
 * missing).
 *
 * @returns {{ savedSeconds: number, amazonDriveSeconds: number, currentDriveSeconds: number } | null}
 */
export function compareToAmazonOrder(stops) {
  if (!Array.isArray(stops)) return null;
  const located = stops.filter((s) => s && typeof s.lat === 'number' && typeof s.lng === 'number');
  if (located.length < 2) return null;
  if (!located.every((s) => Number.isFinite(s.stopNumber))) return null;

  const amazonOrder = [...located].sort((a, b) => a.stopNumber - b.stopNumber);
  const amazonDriveSeconds = driveSecondsForOrder(amazonOrder);
  const currentDriveSeconds = driveSecondsForOrder(located);
  return {
    savedSeconds: Math.round(amazonDriveSeconds - currentDriveSeconds),
    amazonDriveSeconds: Math.round(amazonDriveSeconds),
    currentDriveSeconds: Math.round(currentDriveSeconds)
  };
}
