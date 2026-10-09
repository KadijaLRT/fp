import React, { useState } from 'react';
import { parseDeadlineToday } from '../utils/deadlineProjection';

/**
 * Asks for the driver's block end time (shown on their Flex block details).
 * Not pre-filled from a saved value: block end times change from block to
 * block, so a remembered one would usually be wrong. Skippable and
 * editable later from the banner.
 */
export default function DeadlinePrompt({ initialTime, onSave, onSkip }) {
  const [value, setValue] = useState(initialTime || '');
  const [error, setError] = useState(null);

  const handleSave = () => {
    if (!value) {
      onSkip();
      return;
    }
    if (parseDeadlineToday(value) === null) {
      setError('Enter a valid time.');
      return;
    }
    onSave(value);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50">
      <div className="bg-neutral-900 w-full sm:max-w-sm sm:rounded-2xl rounded-t-2xl px-5 pt-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
        <h2 className="text-lg font-bold text-neutral-50 mb-1">When does your block end?</h2>
        <p className="text-xs text-neutral-500 mb-4">
          Find it in your block details in Flex. The app will show how much time you have left and how many minutes each remaining stop gets.
        </p>

        <input
          type="time"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
          autoFocus
          className="w-full h-14 px-3 rounded-xl bg-neutral-950 border border-neutral-800 text-neutral-100 text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-amber-400 mb-3"
        />

        {error && <p role="alert" className="text-xs text-red-400 font-semibold mb-3">{error}</p>}

        <div className="grid grid-cols-2 gap-2">
          <button onClick={onSkip} className="py-3 rounded-xl bg-neutral-800 text-neutral-300 font-semibold min-h-[48px]">
            Skip
          </button>
          <button onClick={handleSave} className="py-3 rounded-xl bg-amber-500 text-neutral-950 font-bold min-h-[48px]">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
