import { supabase } from './supabaseClient';

/**
 * Upserts a geocoded address into the shared `locations` table and returns
 * its UUID. This is what apartment intel, delivery-time learning, and the
 * "is this a known slow stop" flag all key off of — without a real
 * locations.id, ApartmentIntelEditor has nothing durable to attach to.
 *
 * Keyed on formatted_address (unique constraint in schema.sql) so the same
 * building geocoded on a future route resolves to the same row instead of
 * duplicating.
 *
 * Never throws — on any failure (no Supabase configured, network error,
 * conflict), resolves to { locationId: null, error }. Callers should treat
 * a null locationId as "apartment intel unavailable for this stop" rather
 * than blocking route import on it.
 */
export async function upsertLocation({ formattedAddress, lat, lng, locationType = 'house' }) {
  if (!supabase) {
    return { locationId: null, error: 'Supabase not configured' };
  }
  if (!formattedAddress || typeof lat !== 'number' || typeof lng !== 'number') {
    return { locationId: null, error: 'Missing address or coordinates' };
  }

  try {
    // upsert() with onConflict on formatted_address relies on the UNIQUE
    // constraint from schema.sql. We only set lat/lng/type on conflict too,
    // in case a re-geocode nudges the coordinates slightly — but we
    // deliberately don't touch the learned aggregate columns
    // (avg_total_stop_seconds etc.) here; those are only ever written by
    // the update_location_intelligence trigger on route_stops completion.
    const { data, error } = await supabase
      .from('locations')
      .upsert(
        {
          formatted_address: formattedAddress,
          latitude: lat,
          longitude: lng,
          location_type: locationType,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'formatted_address', ignoreDuplicates: false }
      )
      .select('id')
      .single();

    if (error) throw error;
    return { locationId: data.id, error: null };
  } catch (err) {
    console.error('upsertLocation failed for', formattedAddress, err);
    return { locationId: null, error: err.message || 'Failed to save location' };
  }
}

/**
 * Batch version with limited concurrency, mirroring geocodeAddressBatch.
 * Returns results in the same order as the input array.
 */
export async function upsertLocationBatch(locationInputs, concurrency = 5) {
  const results = new Array(locationInputs.length);
  let cursor = 0;

  async function worker() {
    while (cursor < locationInputs.length) {
      const idx = cursor++;
      const input = locationInputs[idx];
      if (!input || input.lat === null || input.lng === null) {
        results[idx] = { locationId: null, error: 'No coordinates' };
        continue;
      }
      results[idx] = await upsertLocation(input);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, locationInputs.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Fetches the pre-computed "known slow stop" / avg duration intelligence
 * for a set of location ids, so the route solver can apply real learned
 * stop-duration modifiers (per the project's domain reasoning model)
 * instead of guessing.
 */
export async function fetchLocationIntelligence(locationIds) {
  if (!supabase || !Array.isArray(locationIds) || locationIds.length === 0) {
    return {};
  }
  try {
    const { data, error } = await supabase
      .from('locations')
      .select('id, avg_total_stop_seconds, is_known_slow_stop, total_deliveries_count')
      .in('id', locationIds);

    if (error) throw error;

    return Object.fromEntries((data || []).map((row) => [row.id, row]));
  } catch (err) {
    console.error('fetchLocationIntelligence failed:', err);
    return {};
  }
}

/**
 * Fetches a lightweight preview of crowd-sourced apartment intel (whether a
 * gate code exists, and how stale it is) for a set of location ids, so
 * ActiveStopCard can show a "gate code available" badge without the driver
 * having to open the full editor to find out. Freshness matters here more
 * than for most cached data — a gate code from 8 months ago carries real
 * risk of being wrong (complexes change codes), so this surfaces age
 * rather than just presence/absence, letting the driver judge trust for
 * themselves instead of the app silently treating all ages as equally
 * reliable.
 */
export async function fetchApartmentIntelPreview(locationIds) {
  if (!supabase || !Array.isArray(locationIds) || locationIds.length === 0) {
    return {};
  }
  try {
    const { data, error } = await supabase
      .from('apartment_profiles')
      .select('location_id, gate_code, updated_at')
      .in('location_id', locationIds);

    if (error) throw error;

    return Object.fromEntries(
      (data || [])
        .filter((row) => row.gate_code)
        .map((row) => [row.location_id, { updatedAt: row.updated_at }])
    );
  } catch (err) {
    console.error('fetchApartmentIntelPreview failed:', err);
    return {};
  }
}
