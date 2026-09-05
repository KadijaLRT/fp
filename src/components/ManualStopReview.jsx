import React, { useState } from 'react';
import { emptyStop } from '../utils/ocrTextParser';

/**
 * Shown whenever stop data didn't come from a trusted source (Groq vision
 * OCR) — either a Tesseract.js fallback scan or fully manual entry. Every
 * field is editable and the driver must explicitly confirm before these
 * stops get geocoded and routed, since heuristically-extracted or
 * hand-typed data hasn't been through the same validation Groq's
 * structured JSON output has.
 */
export default function ManualStopReview({ initialStops, onConfirm, onCancel }) {
  const [stops, setStops] = useState(
    initialStops && initialStops.length > 0 ? initialStops : [emptyStop(1)]
  );
  const [error, setError] = useState(null);

  const updateStop = (idx, field, value) => {
    setStops((prev) => prev.map((s, i) => (i === idx ? { ...s, [field]: value } : s)));
  };

  const addStop = () => {
    setStops((prev) => [...prev, emptyStop(prev.length + 1)]);
  };

  const removeStop = (idx) => {
    setStops((prev) => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, stopNumber: i + 1 })));
  };

  const handleConfirm = () => {
    const trimmed = stops.map((s) => ({ ...s, address: (s.address || '').trim() }));
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
      <div className="bg-amber-50 border-l-4 border-amber-400 p-3 rounded-r-md text-xs text-amber-800 mb-4">
        <strong>Review before continuing:</strong> these stops weren't read by
        the normal screenshot scanner, so please check each address is
        correct before routing.
      </div>

      <div className="space-y-3">
        {stops.map((stop, idx) => (
          <div key={idx} className="bg-white rounded-xl border border-gray-200 p-3 shadow-sm">
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs font-bold text-gray-500 uppercase">Stop {idx + 1}</span>
              {stops.length > 1 && (
                <button
                  onClick={() => removeStop(idx)}
                  className="text-xs text-red-500 font-semibold px-2 py-1 min-h-[36px]"
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
              className="w-full h-12 px-3 mb-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />

            <div className="grid grid-cols-2 gap-2 mb-2">
              <input
                type="number"
                min="1"
                value={stop.packageCount}
                onChange={(e) => updateStop(idx, 'packageCount', Math.max(1, parseInt(e.target.value, 10) || 1))}
                placeholder="Packages"
                className="h-12 px-3 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input
                type="text"
                value={stop.deliveryWindow || ''}
                onChange={(e) => updateStop(idx, 'deliveryWindow', e.target.value || null)}
                placeholder="Window (optional)"
                className="h-12 px-3 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <input
              type="text"
              value={stop.notes || ''}
              onChange={(e) => updateStop(idx, 'notes', e.target.value || null)}
              placeholder="Notes (optional)"
              className="w-full h-12 px-3 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        ))}
      </div>

      <button
        onClick={addStop}
        className="w-full mt-3 py-3 rounded-xl border-2 border-dashed border-gray-300 text-gray-500 text-sm font-semibold min-h-[48px]"
      >
        + Add another stop
      </button>

      {error && (
        <p role="alert" className="text-xs text-red-500 font-semibold text-center mt-3">
          {error}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 mt-4">
        <button
          onClick={onCancel}
          className="py-3 rounded-xl bg-gray-100 text-gray-700 font-semibold min-h-[48px]"
        >
          Cancel
        </button>
        <button
          onClick={handleConfirm}
          className="py-3 rounded-xl bg-blue-600 text-white font-bold min-h-[48px]"
        >
          Continue ({stops.filter((s) => (s.address || '').trim()).length})
        </button>
      </div>
    </div>
  );
}
