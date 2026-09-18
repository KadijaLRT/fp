import React from 'react';

/**
 * Dispatch-console redesign: near-black background, amber as the sole
 * bright accent (reserved for the primary action, matching the "amber =
 * go" convention this whole redesign is built around), bolder/tighter
 * typography with letterspacing on the brand mark.
 */
export default function HomeScreen({ onUpload, driverEmail }) {
  return (
    <div className="max-w-md mx-auto px-4 pt-8 pb-4">
      <div className="flex items-center gap-2.5 mb-10">
        <div className="w-9 h-9 bg-amber-500 rounded-lg flex items-center justify-center text-lg">⚡</div>
        <span className="text-amber-500 font-extrabold text-sm tracking-[0.15em]">FLEX DISPATCH</span>
      </div>

      <p className="text-neutral-500 text-xs font-semibold tracking-widest uppercase mb-1">
        {driverEmail ? 'Ready when you are' : 'Fastest route, best rate'}
      </p>
      <h1 className="text-2xl font-extrabold text-neutral-50 mb-8">
        {driverEmail ? driverEmail.split('@')[0] : 'Every block.'}
      </h1>

      <button
        onClick={onUpload}
        className="w-full bg-amber-500 hover:bg-amber-600 active:scale-98 rounded-2xl p-5 text-left transition-all"
      >
        <div className="flex items-center gap-4">
          <span className="text-2xl">📸</span>
          <div>
            <p className="text-neutral-950 font-extrabold text-base">Upload itinerary</p>
            <p className="text-amber-950 text-xs mt-0.5 font-semibold">Import your block's stop list</p>
          </div>
        </div>
      </button>
    </div>
  );
}
