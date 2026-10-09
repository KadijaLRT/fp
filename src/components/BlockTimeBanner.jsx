import React, { useState, useEffect } from 'react';
import { parseDeadlineToday } from '../utils/deadlineProjection';
import { compareToAmazonOrder, formatDuration } from '../utils/etaEstimate';

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatPerStop(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Shows the driver's block end time (entered by them, not predicted), how
 * much of the block is left, how many stops remain and the average time
 * available per remaining stop. All plain arithmetic on a time the driver
 * supplied; no forecast of when the route will finish. Also shows the
 * estimated driving saved vs Amazon's order. Re-evaluated every 15s from
 * absolute timestamps so it stays correct after the phone sleeps.
 */
export default function BlockTimeBanner({ stops, currentIndex, routeStartedAtMs, blockEndTime, onSetBlockEnd }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);

  const vsAmazon = compareToAmazonOrder(stops);
  const savedLine =
    vsAmazon && Math.abs(vsAmazon.savedSeconds) >= 60 ? (
      <p
        className={`text-xs font-semibold mt-2 pt-2 border-t border-neutral-800 ${
          vsAmazon.savedSeconds > 0 ? 'text-emerald-400' : 'text-amber-400'
        }`}
      >
        {vsAmazon.savedSeconds > 0
          ? `⚡ Saves ~${formatDuration(vsAmazon.savedSeconds)} of driving vs Amazon's order`
          : `~${formatDuration(-vsAmazon.savedSeconds)} more driving than Amazon's order`}
      </p>
    ) : null;

  if (!blockEndTime) {
    return (
      <div className="max-w-md mx-auto px-4 mb-3">
        <button
          type="button"
          onClick={onSetBlockEnd}
          className="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-3 min-h-[48px] text-sm font-semibold text-amber-400"
        >
          + Set your block end time
        </button>
        {savedLine && <div className="px-1">{savedLine}</div>}
      </div>
    );
  }

  let endMs = parseDeadlineToday(blockEndTime, routeStartedAtMs || now);
  if (endMs === null) return null;
  // A block that ends "earlier" than the route started runs past midnight.
  if (routeStartedAtMs && endMs <= routeStartedAtMs) endMs += 24 * 60 * 60 * 1000;

  const secondsLeft = Math.round((endMs - now) / 1000);
  const stopsLeft = Math.max(0, stops.length - currentIndex);
  const over = secondsLeft <= 0;

  return (
    <div className="max-w-md mx-auto px-4 mb-3">
      <div className="bg-neutral-900 border border-neutral-800 rounded-xl px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-neutral-500">Block ends</p>
            <button type="button" onClick={onSetBlockEnd} className="text-xl font-bold text-amber-400 leading-tight min-h-[32px]">
              {formatClock(endMs)} <span className="text-xs text-neutral-500 font-semibold">edit</span>
            </button>
          </div>
          <div className="text-right">
            <p className={`text-sm font-semibold ${over ? 'text-red-400' : 'text-neutral-200'}`}>
              {over ? 'Block time is up' : formatDuration(secondsLeft)}
              {!over && <span className="text-neutral-500 font-normal"> left</span>}
            </p>
            <p className="text-xs text-neutral-500">
              {stopsLeft} stop{stopsLeft === 1 ? '' : 's'} left
              {!over && stopsLeft > 0 ? ` · ${formatPerStop(secondsLeft / stopsLeft)} per stop` : ''}
            </p>
          </div>
        </div>
        {savedLine}
      </div>
    </div>
  );
}
