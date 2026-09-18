import React from 'react';

/**
 * The first thing a driver sees on opening the app (when there's no route
 * in progress). Previously this was just the bare upload card — felt more
 * like a debug screen than an app. This gives it actual presence: branding
 * plus a clear primary action.
 */
export default function HomeScreen({ onUpload, driverEmail }) {
  return (
    <div className="max-w-md mx-auto px-4 pt-6 pb-4">
      <div className="text-center mb-8">
        <div className="text-5xl mb-2">⚡</div>
        <h1 className="text-2xl font-extrabold text-slate-50 tracking-tight">Flex Route Optimizer</h1>
        <p className="text-sm text-slate-400 mt-1">
          {driverEmail ? `Ready when you are, ${driverEmail.split('@')[0]}.` : 'Fastest route, best rate, every block.'}
        </p>
      </div>

      <div className="space-y-3">
        <button
          onClick={onUpload}
          className="w-full bg-blue-600 hover:bg-blue-700 active:scale-98 rounded-2xl p-5 text-left transition-all shadow-lg"
        >
          <div className="flex items-center gap-4">
            <span className="text-3xl">📸</span>
            <div>
              <p className="text-white font-bold text-base">Upload Itinerary</p>
              <p className="text-blue-100 text-xs mt-0.5">Import your accepted block's stop list</p>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}
