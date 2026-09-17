import { supabase } from './supabaseClient';

/**
 * Persists a new route and its stops to Supabase, and later records
 * completion. This closes a real gap that existed until now: nothing
 * anywhere wrote to `routes` or `route_stops`, which meant the
 * `update_location_intelligence` trigger (AFTER UPDATE ON route_stops)
 * could never fire — so the "known slow stop" / avg-duration learning the
 * project's domain reasoning model describes was schema-only, never
 * actually fed by real driver activity.
 *
 * Every function here is best-effort and never throws: a failed write
 * degrades to "this session's history isn't saved" rather than blocking
 * the driver mid-route. Returns null (not an exception) on failure so
 * callers can check and move on.
 */

export async function createRoute({ driverId, totalStops, totalPackages, strategyUsed, estDurationSeconds, blockPayCents }) {
  if (!supabase || !driverId) return null;

  try {
    const { data, error } = await supabase
      .from('routes')
      .insert({
        driver_id: driverId,
        import_method: 'ocr',
        total_stops: totalStops,
        total_packages: totalPackages,
        strategy_used: strategyUsed,
        est_duration_seconds: estDurationSeconds ?? null,
        block_pay_cents: typeof blockPayCents === 'number' && blockPayCents >= 0 ? Math.round(blockPayCents) : null,
        started_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (error) throw error;
    return data.id;
  } catch (err) {
    console.error('createRoute failed (non-fatal — route history will not persist for this session):', err);
    return null;
  }
}

/**
 * Inserts one route_stops row per stop (status: 'pending') and returns a
 * map of stop.id -> route_stops.id so the caller can attach the real DB id
 * onto each in-memory stop for later completion updates. Uses
 * sequence_order (not insertion order) to match results back to inputs,
 * since a batch insert's returned row order isn't guaranteed to mirror the
 * input array order.
 */
export async function createRouteStops(routeId, stops) {
  if (!supabase || !routeId || !Array.isArray(stops) || stops.length === 0) {
    return {};
  }

  try {
    const rows = stops.map((stop, idx) => ({
      route_id: routeId,
      location_id: stop.locationId || null,
      sequence_order: idx,
      package_count: stop.packageCount || 1,
      vehicle_zone: stop.vehicleZone || null,
      delivery_window_end: stop.deliveryWindowEnd || null,
      status: 'pending'
    }));

    const { data, error } = await supabase
      .from('route_stops')
      .insert(rows)
      .select('id, sequence_order');

    if (error) throw error;

    const byOrder = new Map(data.map((row) => [row.sequence_order, row.id]));
    const result = {};
    stops.forEach((stop, idx) => {
      const routeStopId = byOrder.get(idx);
      if (routeStopId) result[stop.id] = routeStopId;
    });
    return result;
  } catch (err) {
    console.error('createRouteStops failed (non-fatal — this route\'s telemetry will not persist):', err);
    return {};
  }
}

/**
 * Marks a single route_stops row completed or skipped. A 'completed'
 * update with a total_stop_seconds value is what actually fires the
 * update_location_intelligence trigger — this is the one write in the
 * whole app that feeds the learning loop.
 */
/**
 * Sets/updates which part of the vehicle a stop's package(s) were loaded
 * into. Manual-only (see schema.sql comment) — never inferred, since
 * nothing in the OCR/geocoding pipeline has a source for this data.
 */
export async function updateVehicleZone(routeStopId, zone) {
  if (!supabase || !routeStopId) return false;
  const validZones = ['front_seat', 'driver_rear', 'passenger_rear', 'trunk_left', 'trunk_right', 'trunk_center'];
  if (zone !== null && !validZones.includes(zone)) return false;

  try {
    const { error } = await supabase.from('route_stops').update({ vehicle_zone: zone }).eq('id', routeStopId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('updateVehicleZone failed (non-fatal):', err);
    return false;
  }
}

/**
 * Sets/updates a route's block pay after creation — covers the case where
 * a driver skips entering it up front but adds it mid-block via the
 * PayRateBanner's "+ Add pay" prompt.
 */
export async function updateBlockPay(routeId, blockPayCents) {
  if (!supabase || !routeId) return false;
  if (typeof blockPayCents !== 'number' || blockPayCents < 0) return false;

  try {
    const { error } = await supabase.from('routes').update({ block_pay_cents: Math.round(blockPayCents) }).eq('id', routeId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('updateBlockPay failed (non-fatal):', err);
    return false;
  }
}

export async function finalizeRouteStop(routeStopId, { status, totalStopSeconds }) {
  if (!supabase || !routeStopId) return false;
  if (!['completed', 'skipped', 'failed'].includes(status)) return false;

  try {
    const payload = { status };
    if (status === 'completed') {
      payload.total_stop_seconds = Math.max(0, Math.round(totalStopSeconds || 0));
      payload.delivery_time = new Date().toISOString();
    }

    const { error } = await supabase.from('route_stops').update(payload).eq('id', routeStopId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('finalizeRouteStop failed (non-fatal):', err);
    return false;
  }
}

// A route finishing faster than estimated driving time is impossible/noise
// (stop time is never negative), so cap the ratio at 100 either direction —
// this is a simple, transparent heuristic, not a precise metric: the
// project's docs specify only that efficiency_score is "0 to 100" with no
// stated formula, so this compares actual wall-clock time against the
// optimizer's own pure-driving-time estimate rather than inventing
// unstated precision.
function computeEfficiencyScore(estDurationSeconds, actualDurationSeconds) {
  if (!estDurationSeconds || !actualDurationSeconds || actualDurationSeconds <= 0) return null;
  const ratio = (estDurationSeconds / actualDurationSeconds) * 100;
  return Math.max(0, Math.min(100, Math.round(ratio)));
}

export async function finalizeRoute(routeId, { estDurationSeconds, actualDurationSeconds, actualDistanceMiles }) {
  if (!supabase || !routeId) return false;

  try {
    const efficiencyScore = computeEfficiencyScore(estDurationSeconds, actualDurationSeconds);
    const { error } = await supabase
      .from('routes')
      .update({
        completed_at: new Date().toISOString(),
        actual_duration_seconds: actualDurationSeconds ? Math.round(actualDurationSeconds) : null,
        actual_distance_miles: actualDistanceMiles ?? null,
        efficiency_score: efficiencyScore
      })
      .eq('id', routeId);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('finalizeRoute failed (non-fatal):', err);
    return false;
  }
}
