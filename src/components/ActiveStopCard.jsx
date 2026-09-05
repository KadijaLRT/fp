import React, { useState, useEffect, useRef, useMemo } from 'react';
import { openExternalMap } from '../utils/navigation';
import { distanceMeters, isWithinGeofence } from '../utils/geolocation';

export default function ActiveStopCard({
  currentStop,
  totalStops,
  onCompleteStop,
  onSkipStop,
  routeExplanation,
  driverPosition,
  geoError,
  preferredMapApp = 'google'
}) {
  const [seconds, setSeconds] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(true);
  const [navError, setNavError] = useState(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (isTimerRunning) {
      intervalRef.current = setInterval(() => {
        setSeconds((prev) => prev + 1);
      }, 1000);
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [isTimerRunning]);

  // Reset the timer whenever the underlying stop changes (e.g. after a skip
  // reorders the queue) instead of only on explicit "Delivered" taps.
  useEffect(() => {
    setSeconds(0);
    setIsTimerRunning(true);
    setNavError(null);
  }, [currentStop?.id]);

  const formatTime = (totalSec) => {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const triggerNavigation = (app = preferredMapApp) => {
    if (!currentStop) return;
    const { lat, lng, address } = currentStop;
    const result = openExternalMap(lat, lng, address, app);
    if (!result.success) {
      setNavError(result.error);
    } else {
      setNavError(null);
    }
  };

  const handleDone = () => {
    setIsTimerRunning(false);
    onCompleteStop?.({
      stopId: currentStop.id,
      durationSeconds: seconds
    });
  };

  const handleSkip = () => {
    onSkipStop?.(currentStop);
  };

  const hasValidCoords =
    typeof currentStop?.lat === 'number' && typeof currentStop?.lng === 'number';

  // Computed unconditionally (before any early return) so hook call order
  // never changes between renders — React requires this regardless of
  // whether currentStop happens to be null this time.
  const proximity = useMemo(() => {
    if (!driverPosition || !hasValidCoords || !currentStop) return null;
    const meters = distanceMeters(driverPosition.lat, driverPosition.lng, currentStop.lat, currentStop.lng);
    if (meters === null) return null;
    const arrived = isWithinGeofence(driverPosition.lat, driverPosition.lng, currentStop.lat, currentStop.lng);
    return { meters, arrived };
  }, [driverPosition, currentStop?.lat, currentStop?.lng, hasValidCoords]);

  if (!currentStop) {
    return (
      <div className="max-w-md mx-auto p-4 text-center text-slate-400 text-sm">
        No active stop. Import a route to get started.
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto p-4">
      <div className="flex justify-between items-center mb-3 text-xs text-gray-500 font-bold uppercase tracking-wider">
        <span>Stop {currentStop.stopNumber} of {totalStops}</span>
        <span className="bg-green-100 text-green-700 px-2 py-0.5 rounded-full">🟢 On Schedule</span>
      </div>

      {routeExplanation && (
        <div className="bg-indigo-50 border-l-4 border-indigo-400 p-2.5 rounded-r-md text-xs text-indigo-800 mb-3">
          <strong>Why this order:</strong> {routeExplanation}
        </div>
      )}

      {proximity?.arrived && (
        <div className="bg-emerald-50 border-l-4 border-emerald-400 p-2.5 rounded-r-md text-xs text-emerald-800 mb-3 font-semibold">
          📍 You've arrived at this stop
        </div>
      )}

      {geoError && !driverPosition && (
        <div className="bg-slate-100 border-l-4 border-slate-300 p-2 rounded-r-md text-xs text-slate-500 mb-3">
          {geoError.message}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 p-5">
        <div className="flex justify-between items-start mb-2">
          <h2 className="text-xl font-bold text-gray-900 leading-tight">
            {currentStop.address}
          </h2>
          <span className="text-sm font-mono bg-gray-100 text-gray-700 px-2.5 py-1 rounded-lg font-semibold ml-2 whitespace-nowrap">
            ⏱️ {formatTime(seconds)}
          </span>
        </div>

        {!hasValidCoords && (
          <div className="bg-red-50 border-l-4 border-red-400 p-2.5 rounded-r-md text-xs text-red-700 mb-3">
            This address couldn't be located precisely. Navigation is disabled until it's fixed.
          </div>
        )}

        <div className="flex gap-2 my-3 flex-wrap">
          <span className="bg-blue-50 text-blue-700 text-xs font-semibold px-2.5 py-1 rounded-md">
            📦 {currentStop.packageCount || 1} Package(s)
          </span>
          {proximity && !proximity.arrived && (
            <span className="bg-slate-100 text-slate-600 text-xs font-semibold px-2.5 py-1 rounded-md">
              📍 {proximity.meters < 1000
                ? `${Math.round(proximity.meters)} m away`
                : `${(proximity.meters / 1000).toFixed(1)} km away`}
            </span>
          )}
          {currentStop.deliveryWindow && (
            <span className="bg-orange-50 text-orange-700 text-xs font-semibold px-2.5 py-1 rounded-md">
              ⏰ Window: {currentStop.deliveryWindow}
            </span>
          )}
          {currentStop.needsReview && (
            <span className="bg-yellow-50 text-yellow-700 text-xs font-semibold px-2.5 py-1 rounded-md">
              ⚠️ Low-confidence address
            </span>
          )}
          {currentStop.isKnownSlowStop && (
            <span className="bg-purple-50 text-purple-700 text-xs font-semibold px-2.5 py-1 rounded-md">
              🐢 Known slow stop{typeof currentStop.avgTotalStopSeconds === 'number'
                ? ` (~${Math.round(currentStop.avgTotalStopSeconds / 60)} min avg)`
                : ''}
            </span>
          )}
        </div>

        {currentStop.notes && (
          <div className="bg-yellow-50 border-l-4 border-yellow-400 p-2.5 rounded-r-md text-xs text-yellow-800 mb-4">
            <strong>Note:</strong> {currentStop.notes}
          </div>
        )}

        {navError && (
          <p role="alert" className="text-xs text-red-500 font-semibold mb-2 text-center">{navError}</p>
        )}

        <div className="space-y-2 mt-4">
          <button
            onClick={() => triggerNavigation()}
            disabled={!hasValidCoords}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed active:scale-98 text-white font-bold py-3.5 rounded-xl shadow transition-all flex items-center justify-center gap-2 min-h-[48px]"
          >
            <span>🧭 NAVIGATE</span>
          </button>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={handleDone}
              className={`bg-emerald-600 hover:bg-emerald-700 active:scale-98 text-white font-bold py-3 rounded-xl shadow transition-all min-h-[48px] ${
                proximity?.arrived ? 'ring-4 ring-emerald-300' : ''
              }`}
            >
              ✓ DELIVERED
            </button>
            <button
              onClick={handleSkip}
              className="bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold py-3 rounded-xl transition-all min-h-[48px]"
            >
              ⏭️ SKIP
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
