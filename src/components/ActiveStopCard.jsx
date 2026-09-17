import React, { useState, useEffect, useRef, useMemo } from 'react';
import { openExternalMap } from '../utils/navigation';
import { distanceMeters, isWithinGeofence } from '../utils/geolocation';

/**
 * Renders "3d ago" / "2mo ago" / "1y ago" style relative freshness for a
 * gate code — precise enough for a driver to judge trust, without pretending
 * false precision (nobody needs to know it was exactly 47 days).
 */
function formatFreshness(isoDate) {
  if (!isoDate) return null;
  const ageMs = Date.now() - new Date(isoDate).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const days = Math.floor(ageMs / 86400000);
  if (days < 1) return 'today';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

const VEHICLE_ZONES = [
  { value: 'front_seat', label: '🪑 Front' },
  { value: 'driver_rear', label: '🚗 Driver Rear' },
  { value: 'passenger_rear', label: '🚙 Pass. Rear' },
  { value: 'trunk_left', label: '📦 Trunk L' },
  { value: 'trunk_right', label: '📦 Trunk R' },
  { value: 'trunk_center', label: '📦 Trunk Ctr' }
];

export default function ActiveStopCard({
  currentStop,
  totalStops,
  onCompleteStop,
  onSkipStop,
  onSetVehicleZone,
  onOpenApartmentIntel,
  onReoptimize,
  isReoptimizing,
  isOnline,
  routeExplanation,
  driverPosition,
  geoError,
  preferredMapApp = 'google'
}) {
  const [seconds, setSeconds] = useState(0);
  const [isTimerRunning, setIsTimerRunning] = useState(true);
  const [navError, setNavError] = useState(null);
  const [actionPending, setActionPending] = useState(false);
  const intervalRef = useRef(null);
  // Synchronous lock, separate from actionPending state: a state update
  // isn't visible until the next render, so two click events dispatched
  // within the same tick (duplicate touch events, a very fast double-tap)
  // could both read actionPending as false and both fire. A ref mutates
  // immediately, so the second call sees the lock the first call just set,
  // even before React has re-rendered anything.
  const actionLockRef = useRef(false);

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
    setActionPending(false);
    actionLockRef.current = false;
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

  // Double-tap safeguard: this project's own hardening checklist calls out
  // "✓ DELIVERED" by name as a button that needs an execution lock during
  // pending state — without one, two taps (or a duplicate touch event,
  // which real touchscreens do send) before the stop actually changes both
  // fire onCompleteStop, and since App.jsx's currentIndex advance uses the
  // functional setState form, both calls genuinely apply: the route
  // silently skips a stop the driver never saw or acted on.
  const handleDone = () => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setActionPending(true);
    setIsTimerRunning(false);
    onCompleteStop?.({
      stopId: currentStop.id,
      durationSeconds: seconds
    });
  };

  const handleSkip = () => {
    if (actionLockRef.current) return;
    actionLockRef.current = true;
    setActionPending(true);
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
      <div className="flex justify-between items-center mb-3 text-xs text-slate-400 font-bold uppercase tracking-wider">
        <span>Stop {currentStop.stopNumber} of {totalStops}</span>
        <span className="bg-emerald-950 text-emerald-300 px-2 py-0.5 rounded-full">🟢 On Schedule</span>
      </div>

      {routeExplanation && (
        <div className="bg-indigo-950/60 border-l-4 border-indigo-500 p-2.5 rounded-r-md text-xs text-indigo-200 mb-3">
          <strong className="text-indigo-100">Why this order:</strong> {routeExplanation}
        </div>
      )}

      {proximity?.arrived && (
        <div className="bg-emerald-950/60 border-l-4 border-emerald-500 p-2.5 rounded-r-md text-xs text-emerald-200 mb-3 font-semibold">
          📍 You've arrived at this stop
        </div>
      )}

      {geoError && !driverPosition && (
        <div className="bg-slate-800 border-l-4 border-slate-600 p-2 rounded-r-md text-xs text-slate-400 mb-3">
          {geoError.message}
        </div>
      )}

      {/* Dark by default — not just under the OLED toggle. A bright white
          card was never the right default for an app used mostly at
          night/dawn/dusk; that's a glare/safety issue on its own, not
          something that should require an opt-in to fix. */}
      <div className="bg-slate-800 rounded-2xl shadow-lg border border-slate-700 p-5">
        <div className="flex justify-between items-start mb-2 gap-2">
          <h2 className="text-2xl font-bold text-slate-50 leading-tight">
            {currentStop.address}
          </h2>
          <span className="text-base font-mono bg-slate-700 text-slate-200 px-2.5 py-1 rounded-lg font-semibold whitespace-nowrap">
            ⏱️ {formatTime(seconds)}
          </span>
        </div>

        {!hasValidCoords && (
          <div className="bg-red-950/60 border-l-4 border-red-500 p-2.5 rounded-r-md text-xs text-red-200 mb-3">
            This address couldn't be located precisely. Navigation is disabled until it's fixed.
          </div>
        )}

        <div className="flex gap-2 my-3 flex-wrap">
          <span className="bg-blue-950/60 text-blue-300 text-xs font-semibold px-2.5 py-1 rounded-md">
            📦 {currentStop.packageCount || 1} Package(s)
          </span>
          {proximity && !proximity.arrived && (
            <span className="bg-slate-700 text-slate-300 text-xs font-semibold px-2.5 py-1 rounded-md">
              📍 {proximity.meters < 1000
                ? `${Math.round(proximity.meters)} m away`
                : `${(proximity.meters / 1000).toFixed(1)} km away`}
            </span>
          )}
          {currentStop.deliveryWindow && (
            <span className="bg-orange-950/60 text-orange-300 text-xs font-semibold px-2.5 py-1 rounded-md">
              ⏰ Window: {currentStop.deliveryWindow}
            </span>
          )}
          {currentStop.needsReview && (
            <span className="bg-yellow-950/60 text-yellow-300 text-xs font-semibold px-2.5 py-1 rounded-md">
              ⚠️ Low-confidence address
            </span>
          )}
          {currentStop.isKnownSlowStop && (
            <span className="bg-purple-950/60 text-purple-300 text-xs font-semibold px-2.5 py-1 rounded-md">
              🐢 Known slow stop{typeof currentStop.avgTotalStopSeconds === 'number'
                ? ` (~${Math.round(currentStop.avgTotalStopSeconds / 60)} min avg)`
                : ''}
            </span>
          )}
          {currentStop.gateCodeUpdatedAt && (
            <button
              onClick={onOpenApartmentIntel}
              className="bg-teal-950/60 text-teal-300 text-xs font-semibold px-2.5 py-1 rounded-md"
            >
              🔑 Gate code on file
              {formatFreshness(currentStop.gateCodeUpdatedAt) ? ` (${formatFreshness(currentStop.gateCodeUpdatedAt)})` : ''}
            </button>
          )}
        </div>

        {onSetVehicleZone && currentStop.routeStopId && (
          <div className="mb-3">
            <p className="text-[11px] font-semibold text-slate-500 uppercase mb-1.5">
              📦 Where's this in the vehicle?
              {currentStop.vehicleZoneSuggested && ' (suggested)'}
            </p>
            <div className="flex gap-1.5 flex-wrap">
              {VEHICLE_ZONES.map((zone) => (
                <button
                  key={zone.value}
                  onClick={() => onSetVehicleZone(currentStop.routeStopId, zone.value)}
                  className={`text-[11px] font-semibold px-2 py-1.5 rounded-md min-h-[32px] ${
                    currentStop.vehicleZone === zone.value
                      ? 'bg-amber-500 text-slate-900'
                      : 'bg-slate-700 text-slate-300'
                  }`}
                >
                  {zone.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {currentStop.notes && (
          <div className="bg-yellow-950/50 border-l-4 border-yellow-600 p-2.5 rounded-r-md text-xs text-yellow-100 mb-4">
            <strong>Note:</strong> {currentStop.notes}
          </div>
        )}

        {navError && (
          <p role="alert" className="text-xs text-red-400 font-semibold mb-2 text-center">{navError}</p>
        )}

        <div className="space-y-2 mt-4">
          <button
            onClick={() => triggerNavigation()}
            disabled={!hasValidCoords}
            className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed active:scale-98 text-white font-bold py-3.5 rounded-xl shadow transition-all flex items-center justify-center gap-2 min-h-[48px] text-base"
          >
            <span>🧭 NAVIGATE</span>
          </button>

          <div className="grid grid-cols-2 gap-2 pt-1">
            <button
              onClick={handleDone}
              disabled={actionPending}
              className={`bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 active:scale-98 text-white font-bold py-3 rounded-xl shadow transition-all min-h-[48px] ${
                proximity?.arrived ? 'ring-4 ring-emerald-400' : ''
              }`}
            >
              {actionPending ? 'Saving…' : '✓ DELIVERED'}
            </button>
            <button
              onClick={handleSkip}
              disabled={actionPending}
              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-slate-200 font-semibold py-3 rounded-xl transition-all min-h-[48px]"
            >
              ⏭️ SKIP
            </button>
          </div>

          {onReoptimize && (
            <button
              onClick={onReoptimize}
              disabled={isReoptimizing}
              className="w-full bg-red-950/60 hover:bg-red-900/60 disabled:opacity-60 text-red-300 font-bold py-3 rounded-xl transition-all min-h-[48px] flex items-center justify-center gap-2"
            >
              {isReoptimizing
                ? 'Reoptimizing…'
                : isOnline === false
                  ? '🔥 REOPTIMIZE (offline — approximate)'
                  : '🔥 REOPTIMIZE'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
