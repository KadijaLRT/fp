import React, { useState, useEffect } from 'react';
import { projectRouteFinish, parseDeadlineToday, assessDeadlineStatus } from '../utils/deadlineProjection';

const STATUS_STYLES = {
  comfortable: 'text-emerald-400',
  tight: 'text-amber-400',
  late: 'text-red-400'
};

const STATUS_LABELS = {
  comfortable: 'on pace',
  tight: 'cutting it close',
  late: 'running late'
};

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Shows a live "on pace to finish ~7:52 AM" projection against a driver's
 * hard deadline. Own 1s ticker, same isolation-from-the-rest-of-the-app
 * pattern as PayRateBanner. Early in a route (no stops completed yet) this
 * is based on the optimizer's driving-time-only estimate and should read
 * as optimistic; once stops start completing, it extrapolates from actual
 * pace, which is more honest but still just an extrapolation — a heuristic
 * for "should I be worried," not a promise.
 */
export default function DeadlineBanner({
  routeStartedAtMs,
  routeEstDurationSeconds,
  completedStopCount,
  totalStopCount,
  deadlineTime,
  onSetDeadline
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!routeStartedAtMs) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [routeStartedAtMs]);

  if (!routeStartedAtMs) return null;

  if (!deadlineTime) {
    return (
      <button
        onClick={onSetDeadline}
        className="w-full max-w-md mx-auto flex justify-center mb-3 text-xs text-neutral-500 underline py-1"
      >
        + Set a "must finish by" time
      </button>
    );
  }

  const deadlineMs = parseDeadlineToday(deadlineTime, routeStartedAtMs);
  const { projectedFinishMs } = projectRouteFinish(
    routeStartedAtMs,
    now,
    completedStopCount,
    totalStopCount,
    routeEstDurationSeconds
  );
  const status = assessDeadlineStatus(projectedFinishMs, deadlineMs);

  if (!status || projectedFinishMs === null) return null;

  return (
    <div className="max-w-md mx-auto mb-3 text-center">
      <span className={`text-sm font-bold ${STATUS_STYLES[status]}`}>
        ⏰ {STATUS_LABELS[status]} — finishing ~{formatTime(projectedFinishMs)}
      </span>
      <span className="text-xs text-neutral-600 ml-2">(need to be done by {formatTime(deadlineMs)})</span>
    </div>
  );
}
