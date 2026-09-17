/**
 * A driver's preferred/regular stations — a device-local preference (like
 * batterySaverMode), not account data, so it lives in localStorage rather
 * than Supabase. Used to pre-fill quick-select chips in OfferComparator so
 * a driver who only ever works a handful of stations doesn't have to type
 * the same names every time under time pressure.
 */

const STORAGE_KEY = 'flexPreferredStations';

export function getPreferredStations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s.trim()) : [];
  } catch {
    return [];
  }
}

export function setPreferredStations(stations) {
  try {
    const cleaned = [...new Set((stations || []).map((s) => s.trim()).filter(Boolean))];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
    return cleaned;
  } catch {
    return stations || [];
  }
}

export function addPreferredStation(station) {
  const trimmed = (station || '').trim();
  if (!trimmed) return getPreferredStations();
  const current = getPreferredStations();
  if (current.includes(trimmed)) return current;
  return setPreferredStations([...current, trimmed]);
}

export function removePreferredStation(station) {
  const current = getPreferredStations();
  return setPreferredStations(current.filter((s) => s !== station));
}
