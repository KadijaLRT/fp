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
 * Address editing, manual reordering and "mark delivered" apply to every
 * stop that isn't already completed, including the current one. A
 * completed stop's address and position are historical record of what
 * actually happened on this route, so they are locked. Marking a stop
 * delivered from here records no timer duration (nothing was timing it),
 * so it never feeds the learned stop-time averages.
 */
export default function StopListView({
  stops,
  currentIndex,
  editingStopId,
  isGeocodingEdit,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onMoveStop,
  onMarkDelivered,
  onAddStop
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [addAddress, setAddAddress] = useState('');
  const [addNumber, setAddNumber] = useState('');
  const [addMsg, setAddMsg] = useState(null);
  const [adding, setAdding] = useState(false);
  const submitAdd = async () => {
    if (adding || !addAddress.trim() || !onAddStop) return;
    setAdding(true);
    try {
      const n = parseInt(addNumber, 10);
      const r = await onAddStop({ address: addAddress, stopNumber: Number.isInteger(n) && n > 0 ? n : null });
      setAddMsg(r?.message || null);
      if (r?.ok) { setAddAddress(''); setAddNumber(''); }
    } finally {
      setAdding(false);
    }
  };

  const [expandedId, setExpandedId] = useState(null);
  const [draftAddress, setDraftAddress] = useState('');
  // Which row is showing the "Mark delivered?" confirmation (two taps, so a
  // stray touch while scrolling can't complete a stop).
  const [confirmDeliveredId, setConfirmDeliveredId] = useState(null);
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

  // Drag and drop (pointer events, works for touch and mouse). Only stops that
  // are not delivered can move, and only among themselves. Dragging by the
  // handle keeps normal page scrolling everywhere else on the row.
  const rowRefs = useRef(new Map());
  const dragRef = useRef(null);
  const [drag, setDrag] = useState(null); // { from, over, dy }

  const startDrag = (e, idx) => {
    if (!onMoveStop || idx < currentIndex) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Snapshot row midpoints (movable rows only) so targets stay stable while dragging.
    const mids = [];
    for (let i = currentIndex; i < stops.length; i++) {
      const el = rowRefs.current.get(i);
      if (el) {
        const r = el.getBoundingClientRect();
        mids.push({ i, mid: r.top + r.height / 2 });
      }
    }
    dragRef.current = { from: idx, startY: e.clientY, mids, scrollY: window.scrollY };
    setDrag({ from: idx, over: idx, dy: 0 });
  };

  const moveDrag = (e) => {
    const d = dragRef.current;
    if (!d) return;
    // Account for page scroll that happens during the drag.
    const dy = e.clientY - d.startY + (window.scrollY - d.scrollY);
    const pointerDocY = e.clientY;
    let over = d.from;
    let best = Infinity;
    d.mids.forEach(({ i, mid }) => {
      const dist = Math.abs(pointerDocY - (mid - (window.scrollY - d.scrollY)));
      if (dist < best) {
        best = dist;
        over = i;
      }
    });
    // Edge auto-scroll so long lists can be dragged end to end.
    if (e.clientY < 90) window.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 90) window.scrollBy(0, 12);
    setDrag({ from: d.from, over, dy });
  };

  const endDrag = (e) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const finalOver = drag ? drag.over : d.from;
    setDrag(null);
    if (finalOver !== d.from && finalOver >= currentIndex) {
      onMoveStop(stops[d.from].id, finalOver);
    }
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  return (
    <div className="max-w-md mx-auto px-4">
      <div className="space-y-1.5">
        {/* Remaining stops first, delivered stops at the bottom. Indices stay the
            real positions in the route, only the display order changes. */}
        {[...stops.keys()]
          .sort((a, b) => (a < currentIndex) - (b < currentIndex) || a - b)
          .map((idx) => {
          const stop = stops[idx];
          const isCompleted = idx < currentIndex;
          const showDeliveredHeader = isCompleted && idx === 0;
          const isCurrent = idx === currentIndex;
          const isExpanded = expandedId === stop.id;
          const isEditing = editingStopId === stop.id;
          // Every not-yet-completed stop (the current one included) can be
          // edited, moved and marked delivered. Only completed stops are locked.
          const isEditable = !isCompleted;
          // The current stop is the first movable row, so it can't go "up"
          // (that would put it among completed stops); the last row can't
          // go "down". Disabled rather than clickable-but-inert.
          const isConfirmingDelivered = confirmDeliveredId === stop.id;

          return (
            <React.Fragment key={stop.id}>
            {showDeliveredHeader && (
              <p className="pt-3 pb-1 text-xs font-bold uppercase tracking-wider text-emerald-500">
                Delivered ({currentIndex})
              </p>
            )}
            <div
              ref={(el) => {
                if (el) rowRefs.current.set(idx, el);
                else rowRefs.current.delete(idx);
              }}
              style={
                drag && drag.from === idx
                  ? { transform: `translateY(${drag.dy}px)`, zIndex: 20, position: 'relative', boxShadow: '0 8px 24px rgba(0,0,0,.6)', opacity: 0.95 }
                  : undefined
              }
              className={`w-full rounded-xl border px-3 py-2.5 ${
                drag && drag.from !== idx && drag.over === idx ? 'ring-2 ring-amber-400' : ''
              } ${drag ? '' : 'transition-all'} ${
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
                    {isCompleted ? '✓' : stop.stopNumber ?? idx + 1}
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
                        {stop.needsReview ? ` · ⚠️ ${stop.reviewReason || 'low-confidence address'}` : ''}
                        {stop.notes && stop.notes.length <= 20 ? ` · ${stop.notes}` : ''}
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
                  <button
                    type="button"
                    onClick={() => setConfirmDeliveredId(isConfirmingDelivered ? null : stop.id)}
                    className="w-11 h-11 text-lg text-emerald-400"
                    aria-label="Mark delivered"
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    onPointerDown={(e) => startDrag(e, idx)}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                    style={{ touchAction: 'none' }}
                    className="w-11 h-11 text-xl text-neutral-400 cursor-grab active:cursor-grabbing select-none"
                    aria-label="Drag to reorder"
                  >
                    ⠿
                  </button>
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

              {isConfirmingDelivered && !isEditing && (
                <div className="mt-2 pt-2 border-t border-neutral-800 flex items-center gap-2">
                  <span className="flex-1 text-xs text-neutral-300">Mark this stop delivered?</span>
                  <button
                    type="button"
                    onClick={() => setConfirmDeliveredId(null)}
                    className="h-10 px-3 rounded-lg bg-neutral-800 text-neutral-300 text-xs font-semibold"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDeliveredId(null);
                      onMarkDelivered?.(stop.id);
                    }}
                    className="h-10 px-3 rounded-lg bg-emerald-500 text-neutral-950 text-xs font-bold"
                  >
                    ✓ Delivered
                  </button>
                </div>
              )}

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
            </React.Fragment>
          );
        })}
      </div>
      {onAddStop && (
        <div className="mt-3">
          {!addOpen ? (
            <button
              onClick={() => setAddOpen(true)}
              className="w-full min-h-[48px] rounded-xl border border-dashed border-neutral-700 text-neutral-200 text-sm font-semibold"
            >
              + Add a stop
            </button>
          ) : (
            <div className="rounded-xl bg-neutral-900 border border-neutral-800 p-3 space-y-2">
              <input
                value={addAddress}
                onChange={(e) => setAddAddress(e.target.value)}
                placeholder="Street address, city"
                className="w-full h-11 rounded-lg bg-neutral-950 border border-neutral-700 text-neutral-100 px-3 text-sm"
              />
              <input
                value={addNumber}
                onChange={(e) => setAddNumber(e.target.value.replace(/\D/g, '').slice(0, 3))}
                inputMode="numeric"
                placeholder="Amazon stop number (optional)"
                className="w-full h-11 rounded-lg bg-neutral-950 border border-neutral-700 text-neutral-100 px-3 text-sm"
              />
              {addMsg && <p className="text-xs text-amber-300">{addMsg}</p>}
              <div className="flex gap-2">
                <button onClick={() => { setAddOpen(false); setAddMsg(null); }} className="flex-1 h-11 rounded-lg bg-neutral-800 text-neutral-200 text-sm font-semibold">
                  Done
                </button>
                <button
                  onClick={submitAdd}
                  disabled={adding || !addAddress.trim()}
                  className="flex-1 h-11 rounded-lg bg-amber-500 text-neutral-950 text-sm font-bold disabled:opacity-50"
                >
                  {adding ? 'Locating…' : 'Add stop'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function hasValidCoords(stop) {
  return typeof stop.lat === 'number' && typeof stop.lng === 'number';
}
