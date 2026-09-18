import React, { useState, useEffect } from 'react';
import { getRateColorClass, formatRate } from '../utils/payRate';

const MIN_ELAPSED_SECONDS_FOR_RATE = 60;

/**
 * Shows a live pay-per-hour pace during an active route. Runs its own 1s
 * interval so a live-updating dollar figure doesn't force the entire App
 * tree (with all its route/stop state) to re-render every second — this
 * component is the only thing that ticks.
 *
 * Deliberately withholds the rate for the first minute of a block: dividing
 * a fixed block pay by a few seconds of elapsed time produces a wildly
 * inflated, meaningless number ($1,200/hr for the first 10 seconds) that
 * would be actively misleading rather than useful.
 */
export default function PayRateBanner({ blockPayCents, routeStartedAtMs, onSetBlockPay }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!routeStartedAtMs) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [routeStartedAtMs]);

  if (!routeStartedAtMs) return null;

  if (typeof blockPayCents !== 'number') {
    return (
      <button
        onClick={onSetBlockPay}
        className="w-full max-w-md mx-auto flex justify-center mb-3 text-xs text-neutral-500 underline py-1"
      >
        + Add this block's pay to see your $/hr pace
      </button>
    );
  }

  const elapsedSeconds = Math.max(0, (now - routeStartedAtMs) / 1000);
  const blockPayDollars = blockPayCents / 100;

  if (elapsedSeconds < MIN_ELAPSED_SECONDS_FOR_RATE) {
    return (
      <div className="max-w-md mx-auto mb-3 text-center">
        <span className="text-xs text-neutral-500">
          Calculating pace… (${blockPayDollars.toFixed(2)} block)
        </span>
      </div>
    );
  }

  const elapsedHours = elapsedSeconds / 3600;
  const currentRate = blockPayDollars / elapsedHours;
  const rateColor = getRateColorClass(currentRate);

  return (
    <div className="max-w-md mx-auto mb-3 text-center">
      <span className={`text-lg font-bold ${rateColor}`}>{formatRate(currentRate)}</span>
      <span className="text-xs text-neutral-500 ml-2">
        pace · ${blockPayDollars.toFixed(2)} block
      </span>
    </div>
  );
}
