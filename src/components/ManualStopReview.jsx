import React, { useState } from 'react';
import { emptyStop } from '../utils/ocrTextParser';

let nextKey = 1;

// Bug fix: React `key` used to be the array index, which is a known
// anti-pattern — removing a stop from the middle shifts every subsequent
// item's key, and React can visually move focus to the wrong row as a
// result (harmless to the underlying data here since every field is
// fully controlled, but a real rough edge). Tagging each stop with a
// stable synthetic key at creation time fixes it properly.
function withKey(stop) {
  return { ...stop, _key: nextKey++ };
}

/**
 * Shown whenever stop data didn't come from a trusted source (Groq vision
 * OCR) — either a Tesseract.js fallback scan or fully manual entry. Every
 * field is editable and the driver must explicitly confirm before these
 * stops get geocoded and routed, since heuristically-extracted or
 * hand-typed data hasn't been through the same validation Groq's
 * structured JSON output has.
 */
export default function ManualStopReview({ initialStops, onConfirm, onCancel }) {
  const [stops, setStops] = useState(() =>
    (initialStops && initialStops.length > 0 ? initialStops : [emptyStop(2)]).map(withKey)
  );
  const [error, setError] = useState(null);

  const updateStop = (idx, field, value) => {
    setStops((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };

  const addStop = () => {
    setStops((prev) => {
      const highest = prev.reduce((m, s) => (Number.isInteger(Number(s.stopNumber)) ? Math.max(m, Number(s.stopNumber)) : m), 1);
      return [...prev, withKey(emptyStop(highest + 1))];
    });
  };

  // Removing a stop closes the gap: every stop numbered after it moves down
  // by one, so the list stays in order. Earlier numbers are left alone.
  const removeStop = (idx) => {
    setStops((prev) => {
      const removed = parseInt(prev[idx]?.stopNumber, 10);
      return prev
        .filter((_, i) => i !== idx)
        .map((s) => {
          const n = parseInt(s.stopNumber, 10);
          return Number.isInteger(removed) && Number.isInteger(n) && n > removed ? { ...s, stopNumber: n - 1 } : s;
        });
    });
  };

  const handleConfirm = () => {
    const trimmed = stops.map((s) => {
      const { _key, ...rest } = s;
      // Bug fix: packageCount was stored as whatever the input's raw
      // string value was while typing (see the onChange handler below),
      // so a stop left mid-edit (or never touched) could reach here as
      // '', undefined, or a non-integer string. Coerced to a valid
      // positive integer here as a last line of defense, independent of
      // whatever happened in the input — geocoding/Supabase should never
      // see anything but a real number.
      const parsedCount = parseInt(rest.packageCount, 10);
      const packageCount = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 1;
      return { ...rest, address: (s.address || '').trim(), packageCount };
    });
    const validStops = trimmed
      .filter((s) => s.address.length > 0)
      .map((s) => ({ ...s, stopNumber: parseInt(s.stopNumber, 10) }));

    if (validStops.some((s) => !Number.isInteger(s.stopNumber) || s.stopNumber < 1)) {
      setError(`${validStops.filter((s) => !Number.isInteger(s.stopNumber) || s.stopNumber < 1).length} stop(s) still need a number. Type the number shown in your Flex app.`);
      return;
    }
    const seenNums = new Set();
    for (const s of validStops) {
      if (seenNums.has(s.stopNumber)) {
        setError(`Stop number ${s.stopNumber} is used twice. Change one of them.`);
        return;
      }
      seenNums.add(s.stopNumber);
    }
    validStops.sort((x, y) => x.stopNumber - y.stopNumber);

    if (validStops.length === 0) {
      setError('Add at least one stop with an address before continuing.');
      return;
    }
    if (validStops.length < stops.length) {
      setError(`${stops.length - validStops.length} stop(s) with no address were skipped.`);
    }

    onConfirm(validStops);
  };

  return (
    <div className="max-w-md mx-auto p-4">
      <div className="bg-amber-950/40 border-l-4 border-amber-600 p-3 rounded-r-md text-xs text-amber-200 mb-4">
        <strong className="text-amber-100">Confirm your stops:</strong> check each stop number and
        address against your Flex app. Nothing is mapped or routed until you tap Continue.
      </div>

      <div className="space-y-3">
        {stops.map((stop, idx) => (
          <div key={stop._key} className="bg-neutral-900 rounded-xl border border-neutral-800 p-3">
            <div className="flex justify-between items-center mb-2">
              <label className="flex items-center gap-2 text-xs font-bold text-neutral-500 uppercase">
                Stop #
                <input
                  type="number"
                  min="1"
                  inputMode="numeric"
                  value={stop.stopNumber ?? ''}
                  onChange={(e) => updateStop(idx, 'stopNumber', e.target.value)}
                  placeholder="?"
                  aria-label={`Stop number for row ${idx + 1}`}
                  className={`w-16 h-9 px-2 rounded-md bg-neutral-950 border text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 ${
                    stop.stopNumber === null || stop.stopNumber === undefined || stop.stopNumber === ''
                      ? 'border-amber-500 ring-1 ring-amber-500'
                      : 'border-neutral-800'
                  }`}
                />
                {(stop.stopNumber === null || stop.stopNumber === undefined || stop.stopNumber === '') && (
                  <span className="normal-case text-amber-400 font-semibold">type the number from Flex</span>
                )}
              </label>
              {stops.length > 1 && (
                <button
                  onClick={() => removeStop(idx)}
                  className="text-xs text-red-400 font-semibold px-2 py-1 min-h-[36px]"
                  aria-label={`Remove row ${idx + 1}`}
                >
                  Remove
                </button>
              )}
            </div>

            <input
              type="text"
              value={stop.address}
              onChange={(e) => updateStop(idx, 'address', e.target.value)}
              placeholder="Full street address"
              className="w-full h-12 px-3 mb-2 rounded-lg bg-neutral-950 border border-neutral-800 text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />

            <div className="grid grid-cols-2 gap-2 mb-2">
              <input
                type="number"
                min="1"
                inputMode="numeric"
                // Bug fix: this used to run Math.max(1, parseInt(...) || 1)
                // on every keystroke. Selecting the existing digit and
                // typing a replacement passes through an empty-string
                // instant, where parseInt('') is NaN and `NaN || 1`
                // snapped the field straight back to 1 before the new
                // digit could land — so the field was effectively stuck
                // at 1 for any edit that didn't append a digit at the
                // end. Now the raw string is stored as-is while typing
                // (including empty, while the driver is mid-edit), and
                // clamping to a valid positive integer only happens on
                // blur and again as a final safety net in handleConfirm,
                // so it never fights a keystroke.
                value={stop.packageCount}
                onChange={(e) => updateStop(idx, 'packageCount', e.target.value)}
                onBlur={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  updateStop(idx, 'packageCount', Number.isFinite(parsed) && parsed > 0 ? parsed : 1);
                }}
                placeholder="Packages"
                className="h-12 px-3 rounded-lg bg-neutral-950 border border-neutral-800 text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
              <input
                type="text"
                value={stop.deliveryWindow || ''}
                onChange={(e) => updateStop(idx, 'deliveryWindow', e.target.value || null)}
                placeholder="Window (optional)"
                className="h-12 px-3 rounded-lg bg-neutral-950 border border-neutral-800 text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>

            <input
              type="text"
              value={stop.notes || ''}
              onChange={(e) => updateStop(idx, 'notes', e.target.value || null)}
              placeholder="Notes (optional)"
              className="w-full h-12 px-3 rounded-lg bg-neutral-950 border border-neutral-800 text-neutral-100 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500"
            />
          </div>
        ))}
      </div>

      <button
        onClick={addStop}
        className="w-full mt-3 py-3 rounded-xl border-2 border-dashed border-neutral-800 text-neutral-500 text-sm font-semibold min-h-[48px]"
      >
        + Add another stop
      </button>

      {error && (
        <p role="alert" className="text-xs text-red-400 font-semibold text-center mt-3">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 mt-4">
        <button
          onClick={onCancel}
          className="py-3 rounded-xl bg-neutral-800 text-neutral-300 font-semibold min-h-[48px]"
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          className="py-3 rounded-xl bg-amber-500 text-neutral-950 font-bold min-h-[48px]"
        >
          Continue ({stops.filter((s) => (s.address || '').trim()).length})
        </button>
      </div>
    </div>
  );
}
