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
    (initialStops && initialStops.length > 0 ? initialStops : [emptyStop(1)]).map(withKey)
  );
  const [error, setError] = useState(null);

  const updateStop = (idx, field, value) => {
    setStops((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };

  const addStop = () => {
    setStops((prev) => [...prev, withKey(emptyStop(prev.length + 1))]);
  };

  const removeStop = (idx) => {
    setStops((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, stopNumber: i + 1 })));
  };

  const handleConfirm = () => {
    const trimmed = stops.map((s) => {
      const { _key, ...rest } = s;
      return { ...rest, address: (s.address || '').trim() };
    });
    const validStops = trimmed.filter((s) => s.address.length > 0);

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
        <strong className="text-amber-100">Review before continuing:</strong> these stops weren't read by
        the normal screenshot scanner, so please check each address is
        correct before routing.
      </div>

      <div className="space-y-3">
        {stops.map((stop, idx) => (
          <div key={stop._key} className="bg-neutral-900 rounded-xl border border-neutral-800 p-3">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-bold text-neutral-500 uppercase">Stop {idx + 1}</span>
              {stops.length > 1 && (
                <button
                  onClick={() => removeStop(idx)}
                  className="text-xs text-red-400 font-semibold px-2 py-1 min-h-[36px]"
                  aria-label={`Remove stop ${idx + 1}`}
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
                value={stop.packageCount}
                onChange={(e) => updateStop(idx, 'packageCount', Math.max(1, parseInt(e.target.value, 10) || 1))}
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
