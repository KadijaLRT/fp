import React, { useState } from 'react';

/**
 * Minimal modal for entering what a block pays. Manual-only by design —
 * see the schema comment on routes.block_pay_cents for why (Amazon Flex
 * shows pay on the block-offer screen, a different screen than the
 * itinerary/stop-list screenshot this app parses).
 */
export default function BlockPayPrompt({ initialDollars, onSave, onSkip }) {
  const [value, setValue] = useState(initialDollars != null ? String(initialDollars) : '');
  const [error, setError] = useState(null);

  const handleSave = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      onSkip();
      return;
    }
    const dollars = Number(trimmed);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError('Enter a valid dollar amount.');
      return;
    }
    if (dollars > 1000) {
      setError("That's higher than any real Flex block — double check the amount.");
      return;
    }
    onSave(Math.round(dollars * 100));
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50">
      <div className="bg-slate-800 w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <h2 className="text-lg font-bold text-slate-50 mb-1">What's this block paying?</h2>
        <p className="text-xs text-slate-400 mb-4">
          Optional — lets the app show your live $/hr pace while you drive.
        </p>

        <div className="relative mb-3">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-lg">$</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="0.00"
            autoFocus
            className="w-full h-14 pl-8 pr-3 rounded-xl bg-slate-900 border border-slate-700 text-slate-100 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-amber-400"
          />
        </div>

        {error && <p role="alert" className="text-xs text-red-400 font-semibold mb-3">{error}</p>}

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onSkip}
            className="py-3 rounded-xl bg-slate-700 text-slate-300 font-semibold min-h-[48px]"
          >
            Skip
          </button>
          <button
            onClick={handleSave}
            className="py-3 rounded-xl bg-amber-500 text-slate-900 font-bold min-h-[48px]"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
