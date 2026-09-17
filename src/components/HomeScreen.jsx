import React from 'react';
import { getPreferredStations } from '../lib/preferredStations';

/**
 * The first thing a driver sees on opening the app (when there's no route
 * in progress). Previously this was just the bare upload card — felt more
 * like a debug screen than an app. This gives it actual presence: branding,
 * two clear primary actions, and a light personal touch (preferred
 * stations) using data the app already has rather than inventing anything
 * new.
 */
export default function HomeScreen({ onUpload, onCompareOffers, driverEmail }) {
  const stations = getPreferredStations();

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

        <button
          onClick={onCompareOffers}
          className="w-full bg-slate-800 hover:bg-slate-700 active:scale-98 rounded-2xl p-5 text-left transition-all border border-slate-700"
        >
          <div className="flex items-center gap-4">
            <span className="text-3xl">📊</span>
            <div>
              <p className="text-slate-100 font-bold text-base">Compare Offers</p>
              <p className="text-slate-400 text-xs mt-0.5">Check $/hr before you accept a block</p>
            </div>
          </div>
        </button>
      </div>

      {stations.length > 0 && (
        <div className="mt-8">
          <p className="text-[11px] font-semibold text-slate-500 uppercase mb-2 text-center">Your stations</p>
          <div className="flex gap-1.5 flex-wrap justify-center">
            {stations.map((station) => (
              <span key={station} className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-slate-800 text-slate-400">
                {station}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
