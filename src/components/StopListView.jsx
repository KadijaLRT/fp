import React, { useState, useEffect, useRef } from 'react';

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
 *
 * Address editing and manual reordering (via up/down, not drag handles —
 * see the note on handleReorderStop below for why) are both scoped to
 * NOT-YET-COMPLETED stops only. A completed stop's address and position
 * are historical record of what actually happened on this route, not an
 * editable plan — editing or moving one here would silently rewrite
 * history that completedStops (tracked separately in App.jsx) doesn't
 * know to reconcile with.
 */
export default function StopListView({
  stops,
  currentIndex,
  editingStopId,
  isGeocodingEdit,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onReorder
}) {
  const [expandedId, setExpandedId] = useState(null);
  const [draftAddress, setDraftAddress] = useState('');
  const inputRef = useRef(null);

  // Seed the draft text whenever a different stop starts being edited —
  // without this, editing stop B right after cancelling an edit on stop A
  // would show stop A's leftover draft text instead of stop B's actual
  // current address.
  useEffect(() => {
    if (editingStopId) {
      const stop = stops.find((s) => s.id === editingStopId);
      setDraftAddress(stop?.address || '');
      // Autofocus so tapping "Edit" drops the driver straight into typing
      // rather than requiring a second tap on the now-visible input.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [editingStopId, stops]);

  return (
    <div className="max-w-md mx-auto px-4">
      <div className="space-y-1.5">
        {stops.map((stop, idx) => {
          const isCompleted = idx < currentIndex;
          const isCurrent = idx === currentIndex;
          const isUpcoming = idx > currentIndex;
          const isExpanded = expandedId === stop.id;
          const isEditing = editingStopId === stop.id;
          // Editing is allowed on the current stop too (a driver mid-route
          // can fix a typo on the stop they're about to arrive at) — only
          // completed stops are locked from editing. Reordering is
          // further restricted to strictly-upcoming stops only (see
          // isUpcoming/canMoveUp/canMoveDown below and the matching note
          // in App.jsx's handleReorderStop): the current stop can't be
          // moved by a list reorder, only through the app's explicit
          // skip/complete flow.
          const isEditable = !isCompleted;
          // Moving "up" past the first upcoming stop (idx === currentIndex
          // + 1) would land on currentIndex itself — blocked in
          // App.jsx's handleReorderStop for the reasons noted there, so
          // disabled here too rather than leaving a button that's
          // clickable but silently does nothing.
          const canMoveUp = isUpcoming && idx > currentIndex + 1;
          const canMoveDown = isUpcoming && idx < stops.length - 1;

          return (
            <div
              key={stop.id}
              className={`w-full rounded-xl border px-3 py-2.5 transition-all ${
                isCurrent
                  ? 'bg-amber-950/40 border-amber-600'
                  : isCompleted
                    ? 'bg-neutral-900/50 border-neutral-800'
                    : 'bg-neutral-900 border-neutral-800'
              }`}
            >
              <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  if (isEditing) return; // don't collapse out from under an active edit
                  setExpandedId(isExpanded ? null : stop.id);
                }}
                className="flex-1 min-w-0 text-left"
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
                    {isEditing ? (
                      <p className="text-sm text-amber-200 font-semibold">Editing address…</p>
                    ) : (
                      <p
                        className={`text-sm truncate ${
                          isCompleted ? 'text-neutral-500 line-through' : isCurrent ? 'text-amber-200 font-semibold' : 'text-neutral-200'
                        }`}
                      >
                        {stop.address}
                      </p>
                    )}
                    {!isExpanded && !isEditing && (
                      <p className="text-[11px] text-neutral-600 mt-0.5">
                        {stop.packageCount || 1} pkg{(stop.packageCount || 1) === 1 ? '' : 's'}
                        {stop.deliveryWindow ? ` · ${stop.deliveryWindow}` : ''}
                        {stop.needsReview ? ' · ⚠️ low-confidence address' : ''}
                      </p>
                    )}
                  </div>
                  {!hasValidCoords(stop) && !isEditing && (
                    <span className="flex-shrink-0 text-red-400 text-xs" title="No valid location">⚠️</span>
                  )}
                </div>
              </button>
              {isEditable && !isEditing && (
                <div className="flex-shrink-0 flex items-center">
                  {isUpcoming && (
                    <div className="flex flex-col">
                      <button
                        type="button"
                        onClick={() => onReorder(stop.id, 'up')}
                        disabled={!canMoveUp}
                        className="w-9 h-6 text-neutral-300 text-sm disabled:opacity-25"
                        aria-label="Move stop earlier"
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        onClick={() => onReorder(stop.id, 'down')}
                        disabled={!canMoveDown}
                        className="w-9 h-6 text-neutral-300 text-sm disabled:opacity-25"
                        aria-label="Move stop later"
                      >
                        ▼
                      </button>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => onStartEdit(stop.id)}
                    className="w-11 h-11 text-lg"
                    aria-label="Edit address"
                  >
                    ✏️
                  </button>
                </div>
              )}
              </div>

              {isEditing ? (
                <div className="mt-2 pt-2 border-t border-neutral-800 space-y-2" onClick={(e) => e.stopPropagation()}>
                  <input
                    ref={inputRef}
                    type="text"
                    value={draftAddress}
                    onChange={(e) => setDraftAddress(e.target.value)}
                    disabled={isGeocodingEdit}
                    placeholder="Full street address"
                    className="w-full h-11 px-3 rounded-lg bg-neutral-950 border border-neutral-700 text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-60"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => onCancelEdit()}
                      disabled={isGeocodingEdit}
                      className="flex-1 h-10 rounded-lg bg-neutral-800 text-neutral-300 text-xs font-semibold disabled:opacity-60"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => onSaveEdit(stop.id, draftAddress)}
                      disabled={isGeocodingEdit || !draftAddress.trim()}
                      className="flex-1 h-10 rounded-lg bg-amber-500 text-neutral-950 text-xs font-semibold disabled:opacity-50"
                    >
                      {isGeocodingEdit ? 'Locating…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                isExpanded && (
                  <div className="mt-2 pt-2 border-t border-neutral-800 text-xs text-neutral-400 space-y-2">
                    <p>📦 {stop.packageCount || 1} package(s)</p>
                    {stop.deliveryWindow && <p>⏰ Window: {stop.deliveryWindow}</p>}
                    {stop.notes && <p>📝 {stop.notes}</p>}
                    {stop.vehicleZone && <p>🚗 {stop.vehicleZone.replace(/_/g, ' ')}</p>}
                    {!hasValidCoords(stop) && <p className="text-red-400">⚠️ Address couldn't be located</p>}

                  </div>
                )
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function hasValidCoords(stop) {
  return typeof stop.lat === 'number' && typeof stop.lng === 'number';
}
