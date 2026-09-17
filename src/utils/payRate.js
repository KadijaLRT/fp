/**
 * Shared between PayRateBanner (live pace during a route) and
 * OfferComparator (deciding between offers before accepting one) so both
 * agree on what counts as a "good" rate instead of two different magic
 * number sets drifting apart over time.
 */

// Rough Flex pay benchmarks — not official Amazon figures, just a
// reasonable default so a $/hr number is meaningful at a glance instead of
// a raw figure the driver has to mentally judge under time pressure.
const RATE_THRESHOLDS = { good: 25, ok: 15 };

export function getRateColorClass(ratePerHour) {
  if (!Number.isFinite(ratePerHour)) return 'text-slate-400';
  if (ratePerHour >= RATE_THRESHOLDS.good) return 'text-emerald-400';
  if (ratePerHour >= RATE_THRESHOLDS.ok) return 'text-amber-400';
  return 'text-red-400';
}

export function computeRatePerHour(payDollars, durationMinutes) {
  if (!Number.isFinite(payDollars) || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return null;
  }
  return payDollars / (durationMinutes / 60);
}

export function formatRate(ratePerHour) {
  if (!Number.isFinite(ratePerHour)) return '--';
  return `$${ratePerHour.toFixed(2)}/hr`;
}
