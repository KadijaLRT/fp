import React, { useState, useEffect, useMemo } from 'react';
import { parseDeadlineToday } from '../utils/deadlineProjection';
import { compareToAmazonOrder, formatDuration } from '../utils/etaEstimate';
import { getCalibration, estimateSavings, formatRangeMinutes } from '../utils/driveCalibration';

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
 * supplied; no forecast of when the route will finish. Re-evaluated every 15s from
 * absolute timestamps so it stays correct after the phone sleeps.
 */
export default function BlockTimeBanner({ stops, currentIndex, routeStartedAtMs, blockEndTime, onSetBlockEnd }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(interval);
  }, []);

  const savings = useMemo(() => {
    const vs = compareToAmazonOrder(stops);
    if (!vs || vs.savedSeconds <= 0) return null;
    const est = estimateSavings(vs.savedSeconds, getCalibration());
    const label = formatRangeMinutes(est.lowSeconds, est.highSeconds);
    return label ? { label, calibrated: est.calibrated, legsUsed: est.legsUsed } : null;
  }, [stops]);

  const savedLine = savings ? (
    <div className="mt-2 pt-2 border-t border-neutral-800">
      <p className="text-xs font-semibold text-emerald-400">
        ⚡ Likely saves about {savings.label} of driving vs Amazon's order
      </p>
      <p className="text-[10px] text-neutral-600 mt-0.5">
        {savings.calibrated
          ? `Estimate tuned to your pace (${savings.legsUsed} stops learned)`
          : 'Rough estimate; gets sharper as you complete routes'}
      </p>
    </div>
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
