/**
 * Suggests a vehicle zone for each stop based on its position in the
 * optimized route — early stops go in easy-reach zones (front seat, then
 * the rears), later stops go progressively deeper into the trunk. This is
 * a deterministic heuristic, not something read off the OCR screenshot:
 * Amazon Flex itineraries have no visual data about where a package sits
 * in the vehicle, so there is nothing for OCR to extract here. A rule
 * based on delivery order is both more reliable and instant/free compared
 * to asking a vision or language model to guess at physical packing with
 * no image of the actual vehicle or packages to go on.
 *
 * These are suggestions only — every stop's zone is still driver-editable
 * via the zone chips on ActiveStopCard, and this never overwrites a zone
 * the driver has already set manually (see applySuggestedZones below).
 */

const ZONE_ORDER = [
  'front_seat',
  'driver_rear',
  'passenger_rear',
  'trunk_left',
  'trunk_right',
  'trunk_center'
];

/**
 * Returns a Map of stop.id -> suggested zone for an ordered list of stops.
 * Splits the route into ZONE_ORDER.length roughly-equal bands by position,
 * so a 30-stop route puts stops 1-5 in front_seat, 6-10 in driver_rear,
 * etc. — proportional to route length rather than a fixed stop count, so
 * short and long routes both get a sensible spread across all zones
 * instead of a 6-stop route only ever using the first zone.
 */
export function suggestVehicleZones(orderedStops) {
  const suggestions = new Map();
  if (!Array.isArray(orderedStops) || orderedStops.length === 0) return suggestions;

  const n = orderedStops.length;
  const bandSize = Math.max(1, Math.ceil(n / ZONE_ORDER.length));

  orderedStops.forEach((stop, idx) => {
    const bandIdx = Math.min(ZONE_ORDER.length - 1, Math.floor(idx / bandSize));
    suggestions.set(stop.id, ZONE_ORDER[bandIdx]);
  });

  return suggestions;
}

/**
 * Applies suggested zones to a stops array, but only for stops that don't
 * already have a vehicleZone set — never overwrites a driver's manual
 * choice (e.g. after a reoptimize reorders stops, previously-tagged zones
 * for still-present stops should be left alone).
 */
export function applySuggestedZones(stops) {
  const suggestions = suggestVehicleZones(stops);
  return stops.map((stop) =>
    stop.vehicleZone ? stop : { ...stop, vehicleZone: suggestions.get(stop.id) || null, vehicleZoneSuggested: true }
  );
}
