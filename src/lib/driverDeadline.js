/**
 * A driver's standing "need to be done by" time — e.g. always before a
 * school-morning routine. Distinct from the per-route deadlineTime in
 * App.jsx (which is reset every route): this is the *default* that gets
 * pre-filled into DeadlinePrompt so a recurring daily constraint doesn't
 * have to be retyped every single block. Device-local like
 * batterySaverMode, not account data.
 */

const STORAGE_KEY = 'flexStandingDeadline';

export function getStandingDeadline() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && /^\d{1,2}:\d{2}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function setStandingDeadline(timeStr) {
  try {
    if (!timeStr) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    localStorage.setItem(STORAGE_KEY, timeStr);
    return timeStr;
  } catch {
    return timeStr;
  }
}
