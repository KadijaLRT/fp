/**
 * Wraps the HTML5 Geolocation API's watchPosition with the defensive
 * handling a driving app needs: permission state surfaced explicitly (not
 * just "it failed"), stale/low-accuracy fixes filtered out rather than
 * trusted blindly, and a clean unsubscribe so components don't leak
 * watchers across re-renders.
 *
 * PWAs require HTTPS (or localhost) for geolocation — this will silently
 * fail to even prompt on an http:// deployment, which is worth knowing
 * before debugging "it just doesn't work on my phone."
 */

const WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 5000, // reuse a fix up to 5s old rather than forcing a fresh GPS read every callback
  timeout: 15000
};

// A fix reported with accuracy worse than this (meters) is too noisy to be
// useful for "have I arrived" geofencing and would cause false positives.
const MAX_USABLE_ACCURACY_METERS = 100;

export function isGeolocationSupported() {
  return typeof navigator !== 'undefined' && !!navigator.geolocation;
}

/**
 * Checks current permission state without triggering a prompt, where the
 * browser supports the Permissions API. Falls back to 'unknown' (Safari on
 * iOS notably doesn't support querying 'geolocation' via Permissions API in
 * all versions) — callers should treat 'unknown' the same as "prompt on
 * first watch call."
 */
export async function checkGeolocationPermission() {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return 'unknown';
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return 'unknown';
  }
}

/**
 * Starts watching the driver's live position. Returns an unsubscribe
 * function — always call it in a useEffect cleanup, since a leaked
 * watchPosition silently drains battery for the rest of the session.
 *
 * onUpdate receives { lat, lng, accuracy, heading, speed, timestamp }.
 * onError receives a normalized { code, message } — 'denied', 'unavailable',
 * 'timeout', or 'unsupported' — so the UI can show a specific, actionable
 * message instead of a generic failure.
 */
export function watchDriverPosition(onUpdate, onError) {
  if (!isGeolocationSupported()) {
    onError?.({ code: 'unsupported', message: 'This device or browser does not support location services.' });
    return () => {};
  }

  const watchId = navigator.geolocation.watchPosition(
    (position) => {
      const { latitude, longitude, accuracy, heading, speed } = position.coords;

      if (typeof accuracy === 'number' && accuracy > MAX_USABLE_ACCURACY_METERS) {
        // Not an error — just not accurate enough to act on. Callers can
        // choose to ignore this tick and wait for a better fix rather than
        // showing a jumpy, unreliable position.
        return;
      }

      onUpdate?.({
        lat: latitude,
        lng: longitude,
        accuracy,
        heading: typeof heading === 'number' ? heading : null,
        speed: typeof speed === 'number' ? speed : null,
        timestamp: position.timestamp
      });
    },
    (err) => {
      const codeMap = {
        1: 'denied', // PERMISSION_DENIED
        2: 'unavailable', // POSITION_UNAVAILABLE
        3: 'timeout' // TIMEOUT
      };
      const code = codeMap[err.code] || 'unknown';
      const messages = {
        denied: 'Location access was denied. Enable it in your browser/device settings to use live tracking.',
        unavailable: 'Could not determine your location right now.',
        timeout: 'Location request timed out. Trying again automatically.',
        unknown: 'Something went wrong getting your location.'
      };
      onError?.({ code, message: messages[code] });
    },
    WATCH_OPTIONS
  );

  return () => navigator.geolocation.clearWatch(watchId);
}

/**
 * Haversine great-circle distance in meters. Good enough for "how far is
 * the driver from this stop" at delivery-route scale — no need for a
 * routing-API round trip just to answer that.
 */
export function distanceMeters(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return null;
  }
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Within this radius of a stop's coordinates, consider the driver "arrived"
// for geofencing purposes (auto-highlighting the Delivered button, etc).
// Wide enough to tolerate GPS drift and imprecise geocoding, tight enough
// not to trigger from the street a block over.
export const GEOFENCE_ARRIVAL_RADIUS_METERS = 60;

export function isWithinGeofence(driverLat, driverLng, stopLat, stopLng, radiusMeters = GEOFENCE_ARRIVAL_RADIUS_METERS) {
  const d = distanceMeters(driverLat, driverLng, stopLat, stopLng);
  return d !== null && d <= radiusMeters;
}
