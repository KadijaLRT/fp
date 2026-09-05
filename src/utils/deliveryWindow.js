/**
 * Amazon Flex itinerary screenshots show delivery windows as free-text —
 * "10:00 AM - 12:00 PM", "By 2:30 PM", "2:00-4:00 PM" — not structured
 * data. The route optimizer's urgency logic (api/optimize.js,
 * urgencyMultiplier) needs an actual timestamp to compare against "now",
 * not a string. This was a real gap: nothing anywhere ever converted the
 * OCR'd text into a parseable end time, so time-window urgency silently
 * had zero effect on route ordering despite being a documented feature.
 *
 * This is deliberately a best-effort parser for common same-day Flex
 * formats, not a general natural-language date parser. It fails closed
 * (returns null) on anything it isn't confident about, which preserves
 * today's existing "no urgency effect" behavior for unparseable text
 * rather than guessing wrong and mis-prioritizing a route.
 */

const TIME_PATTERN = /(\d{1,2}):(\d{2})\s*(AM|PM)?/gi;

/**
 * Extracts the *last* time mentioned in a delivery-window string as the
 * effective deadline — for a range ("10:00 AM - 12:00 PM") that's the end
 * of the window; for a single deadline ("By 2:30 PM") it's the only time
 * present.
 *
 * @param {string|null} windowText - raw OCR delivery window text
 * @param {Date} [referenceDate] - the day this window applies to (defaults
 *   to today; Flex blocks are same-day, so there's no "which day" ambiguity
 *   to resolve here — only which *time*).
 * @returns {string|null} ISO timestamp string, or null if unparseable
 */
export function parseDeliveryWindowEnd(windowText, referenceDate = new Date()) {
  if (!windowText || typeof windowText !== 'string') return null;

  const matches = [...windowText.matchAll(TIME_PATTERN)];
  if (matches.length === 0) return null;

  const last = matches[matches.length - 1];
  let hour = parseInt(last[1], 10);
  const minute = parseInt(last[2], 10);
  const meridiem = last[3]?.toUpperCase();

  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour > 23 || minute > 59) {
    return null;
  }

  if (meridiem === 'PM' && hour < 12) {
    hour += 12;
  } else if (meridiem === 'AM' && hour === 12) {
    hour = 0;
  } else if (!meridiem) {
    // No AM/PM given (OCR sometimes drops it, or the format is 24-hour).
    // Flex delivery windows run roughly 6am-11pm; a bare hour under 7 is
    // ambiguous between "7am" and "7pm" written without a suffix, but
    // Flex windows are virtually always afternoon/evening for bare
    // single-digit-looking hours in practice, and treating it as 24-hour
    // notation (hour already 0-23) is the safer default since it doesn't
    // silently shift a correctly-specified 24h time by 12 hours. Hours
    // 13-23 are unambiguous 24-hour notation already; only 1-12 without a
    // suffix are genuinely ambiguous, and we leave those as-is (AM/24h
    // interpretation) rather than guessing PM, since an incorrect
    // *earlier* guess is safer for urgency scoring than an incorrect
    // *later* one — worst case a stop looks less urgent than it is,
    // rather than the solver being misled into false urgency.
  }

  const result = new Date(referenceDate);
  result.setHours(hour, minute, 0, 0);

  if (Number.isNaN(result.getTime())) return null;

  return result.toISOString();
}
