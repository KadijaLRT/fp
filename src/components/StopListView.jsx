import React, { useState } from 'react';

/**
 * The card view (ActiveStopCard) deliberately shows only the current stop
 * — right for actually driving, useless for planning or double-checking
 * the whole manifest. This shows every stop at once with its status, as
 * an alternative view mode alongside the card, not a replacement for it.
 *
 * Tapping a row expands it in place rather than jumping the driver's
 * active stop there — the app's completion flow is sequential
 * (currentIndex-driven), and letting a list tap silently reorder "which
 * stop is active" would contradict that without the driver explicitly
 * choosing to skip/reoptimize. This is a manifest to review, not a
 * navigation control.
 */
export default function StopListView({ stops, currentIndex }) {
  const [expandedId, setExpandedId] = useState(null);

  return (
    <div className="max-w-md mx-auto px-4">
      <div className="space-y-1.5">
        {stops.map((stop, idx) => {
          const isCompleted = idx < currentIndex;
          const isCurrent = idx === currentIndex;
          const isExpanded = expandedId === stop.id;

          return (
            <button
              key={stop.id}
              onClick={() => setExpandedId(isExpanded ? null : stop.id)}
              className={`w-full text-left rounded-xl border px-3 py-2.5 transition-all ${
                isCurrent
                  ? 'bg-amber-950/40 border-amber-600'
                  : isCompleted
                    ? 'bg-neutral-900/50 border-neutral-800'
                    : 'bg-neutral-900 border-neutral-800'
              }`}
            >
              <div className="flex items-center gap-3">
                <span
                  className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
                    isCompleted
                      ? 'bg-emerald-950 text-emerald-400'
                      : isCurrent
                        ? 'bg-amber-500 text-neutral-950'
                        : 'bg-neutral-800 text-neutral-500'
                  }`}
                >
                  {isCompleted ? '✓' : stop.stopNumber}
                </span>
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm truncate ${
                      isCompleted ? 'text-neutral-500 line-through' : isCurrent ? 'text-amber-200 font-semibold' : 'text-neutral-200'
                    }`}
                  >
                    {stop.address}
                  </p>
                  {!isExpanded && (
                    <p className="text-[11px] text-neutral-600 mt-0.5">
                      {stop.packageCount || 1} pkg{(stop.packageCount || 1) === 1 ? '' : 's'}
                      {stop.deliveryWindow ? ` · ${stop.deliveryWindow}` : ''}
                      {stop.needsReview ? ' · ⚠️ low-confidence address' : ''}
                    </p>
                  )}
                </div>
                {!hasValidCoords(stop) && (
                  <span className="flex-shrink-0 text-red-400 text-xs" title="No valid location">⚠️</span>
                )}
              </div>

              {isExpanded && (
                <div className="mt-2 pt-2 border-t border-neutral-800 text-xs text-neutral-400 space-y-1">
                  <p>📦 {stop.packageCount || 1} package(s)</p>
                  {stop.deliveryWindow && <p>⏰ Window: {stop.deliveryWindow}</p>}
                  {stop.notes && <p>📝 {stop.notes}</p>}
                  {stop.vehicleZone && <p>🚗 {stop.vehicleZone.replace(/_/g, ' ')}</p>}
                  {!hasValidCoords(stop) && <p className="text-red-400">⚠️ Address couldn't be located</p>}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function hasValidCoords(stop) {
  return typeof stop.lat === 'number' && typeof stop.lng === 'number';
}
