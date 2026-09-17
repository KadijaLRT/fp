import React, { useState, useEffect, useCallback, useRef } from 'react';
import ItineraryUpload from './components/ItineraryUpload';
import ActiveStopCard from './components/ActiveStopCard';
import AuthScreen from './components/AuthScreen';
import ApartmentIntelEditor from './components/ApartmentIntelEditor';
import BlockPayPrompt from './components/BlockPayPrompt';
import PayRateBanner from './components/PayRateBanner';
import OfferComparator from './components/OfferComparator';
import DeadlinePrompt from './components/DeadlinePrompt';
import DeadlineBanner from './components/DeadlineBanner';
import { geocodeAddressBatch } from './utils/geocoder';
import { watchDriverPosition, distanceMeters } from './utils/geolocation';
import { parseDeliveryWindowEnd } from './utils/deliveryWindow';
import { upsertLocationBatch, fetchLocationIntelligence, fetchApartmentIntelPreview } from './lib/locations';
import { createRoute, createRouteStops, finalizeRouteStop, finalizeRoute, updateVehicleZone, updateBlockPay } from './lib/routes';
import { cacheRouteOffline, getCachedRoute, clearCachedRoute, getPendingWrites, removePendingWrite, queuePendingWrite } from './lib/offlineStore';
import { solveRouteOffline } from './utils/offlineSolver';
import { applySuggestedZones } from './utils/vehicleZoneSuggester';
import { supabase } from './lib/supabaseClient';
import { getCurrentSession, onAuthStateChange, signOut } from './lib/auth';

const OPTIMIZE_TIMEOUT_MS = 20000;

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Request timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [stops, setStops] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isProcessingRoute, setIsProcessingRoute] = useState(false);
  const [processingError, setProcessingError] = useState(null);
  const [completedStops, setCompletedStops] = useState([]);
  const [routeExplanation, setRouteExplanation] = useState(null);
  const [showApartmentEditor, setShowApartmentEditor] = useState(false);
  const [driverPosition, setDriverPosition] = useState(null);
  const [geoError, setGeoError] = useState(null);
  // DB-backed route tracking — null when Supabase isn't configured or the
  // persistence write failed, in which case the app still works, it just
  // doesn't feed the auto-learning loop or save route history.
  const [currentRouteId, setCurrentRouteId] = useState(null);
  const [routeStartedAtMs, setRouteStartedAtMs] = useState(null);
  const [routeEstDurationSeconds, setRouteEstDurationSeconds] = useState(null);
  // Live $/hr tracking — see BlockPayPrompt/PayRateBanner. Manual entry
  // only, since Flex's block-offer screen (where pay is shown) isn't the
  // same screen as the itinerary this app OCRs.
  const [blockPayCents, setBlockPayCents] = useState(null);
  const [showBlockPayPrompt, setShowBlockPayPrompt] = useState(false);
  const [showOfferComparator, setShowOfferComparator] = useState(false);
  // "Must finish by" deadline — see DeadlineBanner/DeadlinePrompt. Reset
  // per-route like blockPayCents, since a deadline from a previous block
  // shouldn't silently carry over to a new one.
  const [deadlineTime, setDeadlineTime] = useState(null);
  const [showDeadlinePrompt, setShowDeadlinePrompt] = useState(false);
  // OLED true-black battery saver: a device-local display preference, not
  // account data, so it's stored in localStorage rather than Supabase —
  // wrapped in try/catch since some browsers (private/incognito modes)
  // throw on localStorage access rather than just returning null.
  const [batterySaverMode, setBatterySaverMode] = useState(() => {
    try {
      return localStorage.getItem('flexBatterySaverMode') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('flexBatterySaverMode', batterySaverMode ? '1' : '0');
    } catch {
      // Ignore — this is a nice-to-have preference, not critical state.
    }
  }, [batterySaverMode]);

  // Keep the offline cache current as the driver progresses through the
  // route (completing/skipping stops moves currentIndex), not just at
  // import/reoptimize — otherwise an app kill mid-route in a dead zone
  // would restore the driver to the *start* of the route, not where they
  // actually were. Cheap and infrequent enough (a few times per route)
  // that no debouncing is needed.
  useEffect(() => {
    if (stops.length === 0) return;
    cacheRouteOffline(currentRouteId, stops, {
      currentIndex,
      routeStartedAtMs,
      routeEstDurationSeconds
    });
  }, [stops, currentIndex, currentRouteId, routeStartedAtMs, routeEstDurationSeconds]);

  // On mount, offer to restore a cached route if one exists — this is the
  // actual "seamless in a dead zone" scenario: the app got killed
  // (backgrounded too long, phone restarted) while offline, React state is
  // gone, but the route the driver was working is still in IndexedDB.
  // Deliberately asks rather than silently auto-loading, since silently
  // resuming a stale/wrong route without confirmation could be more
  // confusing than starting fresh — a route from days ago should not
  // reappear without the driver choosing that.
  const [restorableRoute, setRestorableRoute] = useState(null);
  const RESTORE_MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20h — longer than any single Flex block realistically runs

  useEffect(() => {
    if (session === undefined) return; // wait for auth to settle first
    if (stops.length > 0) return; // already have an active route in memory

    (async () => {
      const cached = await getCachedRoute();
      if (cached && Array.isArray(cached.stops) && cached.stops.length > 0) {
        const age = Date.now() - (cached.cachedAt || 0);
        if (age <= RESTORE_MAX_AGE_MS) {
          setRestorableRoute(cached);
        } else {
          clearCachedRoute();
        }
      }
    })();
    // Intentionally only on mount / once session resolves — this is a
    // one-time "did you get interrupted" check, not something that should
    // re-trigger every time stops happens to become empty (e.g. right
    // after a driver legitimately finishes a route).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleRestoreRoute = () => {
    if (!restorableRoute) return;
    setStops(restorableRoute.stops);
    setCurrentIndex(restorableRoute.currentIndex || 0);
    setCurrentRouteId(restorableRoute.routeId || null);
    setRouteStartedAtMs(restorableRoute.routeStartedAtMs || null);
    setRouteEstDurationSeconds(restorableRoute.routeEstDurationSeconds || null);
    setRestorableRoute(null);
  };

  const handleDiscardRestorableRoute = () => {
    clearCachedRoute();
    setRestorableRoute(null);
  };

  // --- Online/offline tracking + pending-write sync -----------------------
  const [isOnline, setIsOnline] = useState(() => (typeof navigator !== 'undefined' ? navigator.onLine : true));
  const [isReoptimizing, setIsReoptimizing] = useState(false);

  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // When connectivity returns, replay any stop-completion/route-finalize
  // writes that failed while offline. Best-effort and order-independent —
  // each queued write is fully self-contained (has its own routeStopId or
  // routeId), so replaying them in any order or losing one to a second
  // failure doesn't corrupt anything else.
  useEffect(() => {
    if (!isOnline) return;

    (async () => {
      const pending = await getPendingWrites();
      for (const entry of pending) {
        try {
          let success = false;
          if (entry.kind === 'finalizeStop') {
            success = await finalizeRouteStop(entry.payload.routeStopId, entry.payload);
          } else if (entry.kind === 'finalizeRoute') {
            success = await finalizeRoute(entry.payload.routeId, entry.payload);
          }
          if (success) {
            await removePendingWrite(entry.id);
          }
        } catch (err) {
          console.error('Failed to replay a queued offline write (will retry next reconnect):', err);
        }
      }
    })();
  }, [isOnline]);

  // --- Live GPS tracking ---------------------------------------------------
  // Only watch position while there's an active route to work — starting a
  // GPS watch during upload/idle screens would drain battery for no
  // benefit, and most drivers would reasonably not expect background
  // tracking before they've actually imported a route.
  //
  // "Adaptive polling": a web app cannot tell the phone's GPS chip to
  // sample at a different hardware rate — watchPosition delivers fixes at
  // whatever cadence the OS/browser decides. What this *can* control is
  // how often the app acts on those fixes. So the real, honest version of
  // "reduce polling on the highway, tighten near a stop" is: throttle how
  // often driverPosition state actually updates (and thus how often
  // ActiveStopCard re-renders) when the driver is far from the current
  // stop and moving at highway speed, and update on every fix without
  // throttling once close — which is where accuracy actually matters for
  // the arrival geofence.
  const lastAppliedPositionAtRef = useRef(0);
  const currentStopCoordsRef = useRef(null);

  useEffect(() => {
    const active = stops[currentIndex];
    currentStopCoordsRef.current =
      active && typeof active.lat === 'number' && typeof active.lng === 'number'
        ? { lat: active.lat, lng: active.lng }
        : null;
  }, [stops, currentIndex]);

  useEffect(() => {
    if (stops.length === 0) {
      setDriverPosition(null);
      return;
    }

    const unsubscribe = watchDriverPosition(
      (pos) => {
        const target = currentStopCoordsRef.current;
        const meters = target ? distanceMeters(pos.lat, pos.lng, target.lat, target.lng) : null;
        const isFarFromStop = meters === null || meters > 322; // ~0.2 miles
        const isHighwaySpeed = typeof pos.speed === 'number' && pos.speed > 13.4; // ~30 mph

        if (isFarFromStop && isHighwaySpeed) {
          const now = Date.now();
          if (now - lastAppliedPositionAtRef.current < 15000) {
            return; // throttled — cruising far from the destination, no need to react to every fix
          }
          lastAppliedPositionAtRef.current = now;
        } else {
          lastAppliedPositionAtRef.current = Date.now();
        }

        setDriverPosition(pos);
        setGeoError(null);
      },
      (err) => {
        // Don't let a transient timeout/unavailable blank out a position we
        // already have — only surface it if we never got a fix at all.
        setGeoError(err);
      }
    );

    return unsubscribe;
  }, [stops.length > 0]);

  // --- Auth bootstrap ---------------------------------------------------
  const [preferredMapApp, setPreferredMapApp] = useState('google');

  useEffect(() => {
    if (!supabase) {
      // Supabase not configured — run in "no auth" demo mode rather than
      // hard-crashing the whole app for local development.
      setSession(null);
      return;
    }

    let unsub = () => {};
    (async () => {
      const { session: current } = await getCurrentSession();
      setSession(current);
      unsub = onAuthStateChange((next) => setSession(next));
    })();

    return () => unsub();
  }, []);

  // Load the driver's saved map-app preference (drivers.preferred_map_app)
  // once authenticated. This column existed in the schema from the start
  // but nothing ever read it — navigation always defaulted to Google Maps
  // regardless of what a driver had set, silently ignoring their choice.
  useEffect(() => {
    if (!supabase || !session?.user?.id) return;
    let cancelled = false;

    (async () => {
      try {
        const { data, error } = await supabase
          .from('drivers')
          .select('preferred_map_app')
          .eq('id', session.user.id)
          .maybeSingle();
        if (!cancelled && !error && data?.preferred_map_app) {
          setPreferredMapApp(data.preferred_map_app);
        }
      } catch (err) {
        console.error('Failed to load driver map preference (non-fatal, defaulting to Google Maps):', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  // --- Route import: geocode + optimize ----------------------------------
  const handleRouteImported = useCallback(async (rawStops) => {
    setIsProcessingRoute(true);
    setProcessingError(null);
    setRouteExplanation(null);
    setBlockPayCents(null); // fresh block — don't carry over the previous one's pay figure
    setDeadlineTime(null);
    let persistedRouteId = null;

    try {
      const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
      if (!mapboxToken) {
        throw new Error('Mapbox is not configured (VITE_MAPBOX_TOKEN missing).');
      }

      const geoResults = await geocodeAddressBatch(
        rawStops.map((s) => s.address),
        mapboxToken
      );

      let geocodedStops = rawStops.map((stop, idx) => {
        const geo = geoResults[idx];
        return {
          id: `stop-${idx + 1}`,
          stopNumber: stop.stopNumber || idx + 1,
          address: geo.address || stop.address,
          lat: geo.lat,
          lng: geo.lng,
          confidence: geo.confidence,
          needsReview: geo.needsReview || geo.lat === null,
          packageCount: stop.packageCount || 1,
          deliveryWindow: stop.deliveryWindow || null,
          deliveryWindowEnd: parseDeliveryWindowEnd(stop.deliveryWindow),
          notes: stop.notes || null,
          locationId: null,
          avgTotalStopSeconds: null,
          isKnownSlowStop: false
        };
      });

      // Link each geocoded stop to the shared `locations` table (upserting
      // on formatted address) so apartment intel and per-location learning
      // have a real, durable id to attach to instead of the throwaway
      // client-side "stop-N" id. Best-effort: if Supabase isn't configured
      // or a write fails, stops just fall back to locationId: null and the
      // app keeps working without personalization.
      if (supabase) {
        try {
          const locationResults = await upsertLocationBatch(
            geocodedStops.map((s) => ({
              formattedAddress: s.address,
              lat: s.lat,
              lng: s.lng
            }))
          );
          geocodedStops = geocodedStops.map((s, idx) => ({
            ...s,
            locationId: locationResults[idx]?.locationId || null
          }));

          const resolvedIds = geocodedStops.map((s) => s.locationId).filter(Boolean);
          if (resolvedIds.length > 0) {
            const intel = await fetchLocationIntelligence(resolvedIds);
            geocodedStops = geocodedStops.map((s) => {
              const row = s.locationId ? intel[s.locationId] : null;
              return row
                ? {
                    ...s,
                    avgTotalStopSeconds: row.avg_total_stop_seconds ?? null,
                    isKnownSlowStop: !!row.is_known_slow_stop
                  }
                : s;
            });

            const apartmentPreview = await fetchApartmentIntelPreview(resolvedIds);
            geocodedStops = geocodedStops.map((s) => {
              const preview = s.locationId ? apartmentPreview[s.locationId] : null;
              return preview ? { ...s, gateCodeUpdatedAt: preview.updatedAt } : s;
            });
          }
        } catch (linkErr) {
          // Non-fatal — location linking is an enhancement, not a blocker.
          console.error('Location linking/intelligence lookup failed (non-fatal):', linkErr);
        }
      }

      const unresolvedCount = geocodedStops.filter((s) => s.lat === null || s.lng === null).length;

      // Only send stops with real coordinates into the matrix solver —
      // Mapbox Matrix will 422 on nulls, and we already validate this
      // server-side, but filtering here avoids a wasted round trip.
      const routableStops = geocodedStops.filter((s) => s.lat !== null && s.lng !== null);

      if (routableStops.length < 2) {
        setStops(geocodedStops);
        setCurrentIndex(0);
        setProcessingError(
          unresolvedCount > 0
            ? `${unresolvedCount} address(es) couldn't be located. Add at least 2 valid addresses to optimize a route.`
            : null
        );
        return;
      }

      const originalOrder = routableStops.map((s) => s.id);

      let finalRoute = geocodedStops;
      let estimatedDrivingSeconds = null;
      try {
        const response = await withTimeout(
          fetch('/api/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stops: routableStops, mapboxToken })
          }),
          OPTIMIZE_TIMEOUT_MS
        );
        const result = await response.json();

        if (response.ok && result.success) {
          const unresolvedStops = geocodedStops.filter((s) => s.lat === null || s.lng === null);
          finalRoute = [...result.optimizedStops, ...unresolvedStops];
          estimatedDrivingSeconds = typeof result.estimatedDrivingSeconds === 'number' ? result.estimatedDrivingSeconds : null;

          const newOrder = result.optimizedStops.map((s) => s.id);
          const orderChanged = originalOrder.some((id, i) => id !== newOrder[i]);
          if (orderChanged) {
            fetchRouteExplanation(originalOrder, newOrder);
          }
        } else {
          console.error('Optimization failed, falling back to offline solver:', result.error);
          finalRoute = [...solveRouteOffline(routableStops), ...geocodedStops.filter((s) => s.lat === null || s.lng === null)];
          setProcessingError(`Route optimization failed (${result.error || 'unknown error'}). Used an approximate offline route instead — reconnect and reoptimize when possible.`);
        }
      } catch (optErr) {
        console.error('Optimize request failed, falling back to offline solver:', optErr);
        finalRoute = [...solveRouteOffline(routableStops), ...geocodedStops.filter((s) => s.lat === null || s.lng === null)];
        setProcessingError('Could not reach the route optimizer. Used an approximate offline route (straight-line distance, not real driving times) instead.');
      }

      if (unresolvedCount > 0) {
        setProcessingError((prev) =>
          prev ? prev : `${unresolvedCount} address(es) need manual review — check the flagged stops.`
        );
      }

      // Auto-suggest a vehicle zone per stop based on route position (see
      // vehicleZoneSuggester.js for why this is a deterministic heuristic
      // rather than something pulled from the OCR screenshot — there's no
      // visual packing data in a Flex itinerary image for OCR to read).
      // Never overwrites a zone that's already set.
      finalRoute = applySuggestedZones(finalRoute);

      // Start the route clock unconditionally — this drives the live
      // $/hr pace banner and the per-stop timer's "route complete" summary,
      // neither of which depend on Supabase. Only DB persistence
      // (createRoute/createRouteStops below) is conditional; the clock
      // itself is a purely client-side concern and was previously wired
      // to only start when Supabase was configured, which meant the pace
      // banner silently never appeared in demo/no-backend mode.
      const routeStartMs = Date.now();
      setRouteStartedAtMs(routeStartMs);
      setRouteEstDurationSeconds(estimatedDrivingSeconds);

      // Persist the route + its stops so the auto-learning trigger has
      // something to fire against later, and so route history/efficiency
      // scoring (routes.efficiency_score) has real data to compute from.
      // Best-effort: a failed write here degrades to "this session isn't
      // saved," not a broken route — the driver can still work it.
      if (supabase && session) {
        try {
          const routeId = await createRoute({
            driverId: session.user.id,
            totalStops: finalRoute.length,
            totalPackages: finalRoute.reduce((sum, s) => sum + (s.packageCount || 1), 0),
            strategyUsed: 'fastest',
            estDurationSeconds: estimatedDrivingSeconds,
            blockPayCents: null // fresh route — pay is entered via the post-import prompt, never carried over
          });

          if (routeId) {
            const routeStopIdsByStopId = await createRouteStops(routeId, finalRoute);
            finalRoute = finalRoute.map((s) => ({ ...s, routeStopId: routeStopIdsByStopId[s.id] || null }));
            persistedRouteId = routeId;
            setCurrentRouteId(routeId);
          }
        } catch (persistErr) {
          console.error('Route persistence failed (non-fatal — history will not be saved):', persistErr);
        }
      }

      setStops(finalRoute);
      setCurrentIndex(0);
      // Bug fix: this used to pass the `currentRouteId` state variable,
      // but setCurrentRouteId() above doesn't update it synchronously
      // within this same function call — that meant every route after the
      // first in a session cached under the *previous* route's id. Use the
      // local variable set at the point of creation instead.
      cacheRouteOffline(persistedRouteId, finalRoute, {
        currentIndex: 0,
        routeStartedAtMs: routeStartMs,
        routeEstDurationSeconds: estimatedDrivingSeconds
      });
      setShowBlockPayPrompt(true);
    } catch (err) {
      console.error('Failed to process route:', err);
      setProcessingError(err.message || 'Failed to process this route. Please try again.');
    } finally {
      setIsProcessingRoute(false);
    }
  }, [session]);

  const fetchRouteExplanation = async (originalOrder, newOrder) => {
    try {
      const res = await withTimeout(
        fetch('/api/explain-route', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalOrder, newOrder, reasoningFactors: { metric: 'total_duration' } })
        }),
        10000
      );
      const data = await res.json();
      if (data?.explanation) setRouteExplanation(data.explanation);
    } catch (err) {
      console.error('Failed to fetch route explanation (non-fatal):', err);
      // Silent failure is fine here — the explanation is a nice-to-have,
      // not blocking the driver's ability to work the route.
    }
  };

  // Wrapped persistence helpers: queue to IndexedDB instead of losing the
  // write entirely when offline (checked before attempting) or when a
  // write fails outempted while nominally online (network flakiness isn't
  // always reflected accurately in navigator.onLine). Queued entries get
  // replayed by the reconnect effect above.
  const persistStopCompletion = useCallback(
    async (routeStopId, payload) => {
      if (!isOnline) {
        await queuePendingWrite('finalizeStop', { routeStopId, ...payload });
        return;
      }
      const success = await finalizeRouteStop(routeStopId, payload);
      if (!success) {
        await queuePendingWrite('finalizeStop', { routeStopId, ...payload });
      }
    },
    [isOnline]
  );

  const persistRouteCompletion = useCallback(
    async (routeId, payload) => {
      if (!isOnline) {
        await queuePendingWrite('finalizeRoute', { routeId, ...payload });
        return;
      }
      const success = await finalizeRoute(routeId, payload);
      if (!success) {
        await queuePendingWrite('finalizeRoute', { routeId, ...payload });
      }
    },
    [isOnline]
  );

  const handleCompleteStop = useCallback(
    (stopMetrics) => {
      setCompletedStops((prev) => [...prev, stopMetrics]);
      setRouteExplanation(null);

      // This is the one write in the app that actually feeds the
      // auto-learning trigger (update_location_intelligence fires AFTER
      // UPDATE ON route_stops when status becomes 'completed').
      const completedStop = stops.find((s) => s.id === stopMetrics.stopId);
      if (completedStop?.routeStopId) {
        persistStopCompletion(completedStop.routeStopId, {
          status: 'completed',
          totalStopSeconds: stopMetrics.durationSeconds
        });
      }

      if (currentIndex < stops.length - 1) {
        setCurrentIndex((prev) => prev + 1);
      } else {
        let completionMessage = '🎉 Route Complete! Awesome job.';
        if (currentRouteId && routeStartedAtMs) {
          const actualDurationSeconds = (Date.now() - routeStartedAtMs) / 1000;
          persistRouteCompletion(currentRouteId, {
            estDurationSeconds: routeEstDurationSeconds,
            actualDurationSeconds
          });
          if (typeof blockPayCents === 'number' && actualDurationSeconds > 0) {
            const finalRate = blockPayCents / 100 / (actualDurationSeconds / 3600);
            completionMessage += `\n\nFinal pace: $${finalRate.toFixed(2)}/hr ($${(blockPayCents / 100).toFixed(2)} in ${(actualDurationSeconds / 3600).toFixed(1)}h)`;
          }
        }
        setStops([]);
        setCurrentIndex(0);
        setCurrentRouteId(null);
        setRouteStartedAtMs(null);
        setRouteEstDurationSeconds(null);
        setBlockPayCents(null);
        setDeadlineTime(null);
        clearCachedRoute();
        alert(completionMessage);
      }
    },
    [currentIndex, stops, currentRouteId, routeStartedAtMs, routeEstDurationSeconds, blockPayCents, persistStopCompletion, persistRouteCompletion]
  );

  const handleSkipStop = useCallback((skippedStop) => {
    // Deliberately no DB write here: "skip" in this UI means "move to the
    // end of the queue and come back to it," not "abandon permanently." The
    // stop's route_stops row stays 'pending' — if the driver does complete
    // it later in the route, that's when it gets finalized. If the route
    // ends with it still un-delivered, it's correctly left as 'pending'
    // rather than being marked something it isn't (there's no honest
    // 'skipped-but-might-still-happen' status in the schema).
    setStops((prev) => {
      const remaining = [...prev];
      const idx = remaining.findIndex((s) => s.id === skippedStop.id);
      if (idx === -1) return prev;
      remaining.splice(idx, 1);
      remaining.push(skippedStop);
      return remaining;
    });
    setRouteExplanation(null);
  }, []);

  const handleSaveBlockPay = useCallback(
    (cents) => {
      setBlockPayCents(cents);
      setShowBlockPayPrompt(false);
      if (currentRouteId) {
        updateBlockPay(currentRouteId, cents);
      }
    },
    [currentRouteId]
  );

  const handleSkipBlockPay = useCallback(() => {
    setShowBlockPayPrompt(false);
  }, []);

  const handleSaveDeadline = useCallback((timeStr) => {
    setDeadlineTime(timeStr);
    setShowDeadlinePrompt(false);
  }, []);

  const handleSkipDeadline = useCallback(() => {
    setShowDeadlinePrompt(false);
  }, []);

  const handleSetVehicleZone = useCallback((routeStopId, zone) => {
    // Optimistic local update so the UI reflects the tap immediately;
    // the persisted write is best-effort (updateVehicleZone never throws).
    setStops((prev) => prev.map((s) => (s.routeStopId === routeStopId ? { ...s, vehicleZone: zone } : s)));
    updateVehicleZone(routeStopId, zone);
  }, []);

  // "Emergency Reoptimize" — re-sequences only the *remaining* stops
  // (current position onward; anything already completed stays put).
  // Goes through the server solver when online (real driving times), and
  // falls back to the local offline solver (straight-line distance) when
  // offline or when the network call fails — this is the offline-first
  // engine's main practical use case, since the app's one other
  // optimize call only happens once at initial import.
  const handleReoptimize = useCallback(async () => {
    if (isReoptimizing) return; // double-tap safeguard
    const remaining = stops.slice(currentIndex);
    const routableRemaining = remaining.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
    const unresolvedRemaining = remaining.filter((s) => typeof s.lat !== 'number' || typeof s.lng !== 'number');

    if (routableRemaining.length < 2) {
      setProcessingError('Not enough remaining stops with valid locations to reoptimize.');
      return;
    }

    setIsReoptimizing(true);
    setProcessingError(null);

    const originalOrder = routableRemaining.map((s) => s.id);
    let reordered = null;

    if (isOnline) {
      try {
        const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
        const response = await withTimeout(
          fetch('/api/optimize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stops: routableRemaining, mapboxToken })
          }),
          OPTIMIZE_TIMEOUT_MS
        );
        const result = await response.json();
        if (response.ok && result.success) {
          reordered = result.optimizedStops;
        } else {
          console.error('Reoptimize failed server-side, using offline solver:', result.error);
        }
      } catch (err) {
        console.error('Reoptimize request failed, using offline solver:', err);
      }
    }

    if (!reordered) {
      reordered = solveRouteOffline(routableRemaining);
      setProcessingError(
        isOnline
          ? 'Could not reach the route optimizer — used an approximate offline route instead.'
          : "You're offline — used an approximate route (straight-line distance, not real driving times)."
      );
    }

    const newOrder = reordered.map((s) => s.id);
    const orderChanged = originalOrder.some((id, i) => id !== newOrder[i]);

    setStops((prev) => [...prev.slice(0, currentIndex), ...reordered, ...unresolvedRemaining]);
    cacheRouteOffline(currentRouteId, [...stops.slice(0, currentIndex), ...reordered, ...unresolvedRemaining], {
      currentIndex,
      routeStartedAtMs,
      routeEstDurationSeconds
    });

    if (orderChanged && isOnline) {
      fetchRouteExplanation(originalOrder, newOrder);
    }

    setIsReoptimizing(false);
  }, [stops, currentIndex, isOnline, isReoptimizing, currentRouteId, routeStartedAtMs, routeEstDurationSeconds]);

  const handleNewRoute = () => {
    // If the driver abandons a route mid-way (taps "New Route" instead of
    // finishing), still close out the DB row with whatever actually
    // happened rather than leaving it permanently "in progress" with no
    // completed_at — an abandoned route is a real outcome worth recording,
    // not a reason to silently drop the data.
    if (currentRouteId && routeStartedAtMs) {
      persistRouteCompletion(currentRouteId, {
        estDurationSeconds: routeEstDurationSeconds,
        actualDurationSeconds: (Date.now() - routeStartedAtMs) / 1000
      });
    }
    setStops([]);
    setCurrentIndex(0);
    setCompletedStops([]);
    setProcessingError(null);
    setRouteExplanation(null);
    setCurrentRouteId(null);
    setRouteStartedAtMs(null);
    setRouteEstDurationSeconds(null);
    setBlockPayCents(null);
    setShowBlockPayPrompt(false);
    setDeadlineTime(null);
    setShowDeadlinePrompt(false);
    clearCachedRoute();
  };

  // --- Render -------------------------------------------------------------
  if (session === undefined) {
    return (
      <div className="min-h-screen bg-slate-900 flex items-center justify-center">
        <div className="animate-spin text-4xl">⚙️</div>
      </div>
    );
  }

  if (session === null && supabase) {
    return <AuthScreen onAuthenticated={setSession} />;
  }

  const currentStop = stops[currentIndex];

  return (
    <div className={`min-h-screen ${batterySaverMode ? 'bg-black' : 'bg-slate-900'} text-slate-100 flex flex-col font-sans`}>
      <header className={`p-4 ${batterySaverMode ? 'bg-black border-slate-800' : 'bg-slate-800 border-slate-700'} border-b flex justify-between items-center`}>
        <h1 className="font-extrabold text-base tracking-tight text-amber-400">
          ⚡ FLEX ROUTE OPTIMIZER
        </h1>
        <div className="flex items-center gap-2">
          {!isOnline && (
            <span className="text-xs bg-amber-900 text-amber-200 px-2.5 py-1.5 rounded-lg font-semibold">
              📡 Offline
            </span>
          )}
          <button
            onClick={() => setBatterySaverMode((prev) => !prev)}
            className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-slate-300 transition-all min-h-[36px]"
            aria-pressed={batterySaverMode}
            title="OLED true-black mode — reduces screen power draw on OLED displays"
          >
            {batterySaverMode ? '🔋 OLED On' : '🔋 OLED Off'}
          </button>
          {stops.length > 0 && (
            <button
              onClick={handleNewRoute}
              className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-slate-300 transition-all min-h-[36px]"
            >
              New Route
            </button>
          )}
          {supabase && session && (
            <button
              onClick={() => signOut()}
              className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-1.5 rounded-lg text-slate-300 transition-all min-h-[36px]"
            >
              Sign Out
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col justify-center">
        {isProcessingRoute ? (
          <div className="text-center p-6">
            <div className="animate-spin text-4xl mb-3">⚙️</div>
            <p className="font-semibold text-sm text-slate-300">
              Geocoding addresses &amp; calculating fastest route…
            </p>
          </div>
        ) : stops.length === 0 ? (
          <div>
            {restorableRoute && (
              <div className="max-w-md mx-auto px-4 mb-4">
                <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-center">
                  <p className="text-sm font-bold text-amber-900 mb-1">Resume interrupted route?</p>
                  <p className="text-xs text-amber-700 mb-3">
                    Found a saved route with {restorableRoute.stops.length} stops
                    ({restorableRoute.stops.length - (restorableRoute.currentIndex || 0)} remaining) —
                    looks like the app closed before you finished.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleDiscardRestorableRoute}
                      className="py-2.5 rounded-lg bg-white border border-amber-300 text-amber-700 text-sm font-semibold min-h-[44px]"
                    >
                      Discard
                    </button>
                    <button
                      onClick={handleRestoreRoute}
                      className="py-2.5 rounded-lg bg-amber-500 text-white text-sm font-bold min-h-[44px]"
                    >
                      Resume
                    </button>
                  </div>
                </div>
              </div>
            )}
            {processingError && (
              <p role="alert" className="text-center text-xs text-red-400 font-semibold mb-3 px-4">
                {processingError}
              </p>
            )}
            <ItineraryUpload onRouteImported={handleRouteImported} />

            {/* Pre-accept decision tool — independent of any active route,
                since this is for the moment BEFORE you accept a block, not
                during one. Pure arithmetic on numbers Amazon's own Offers
                screen already shows; no automation of anything. */}
            <div className="max-w-md mx-auto px-4 mt-2 text-center">
              <button
                onClick={() => setShowOfferComparator(true)}
                className="text-xs text-slate-400 underline py-2"
              >
                📊 Compare offer pay rates
              </button>
            </div>
          </div>
        ) : (
          <div>
            {processingError && (
              <p role="alert" className="text-center text-xs text-amber-400 font-semibold mb-3 px-4">
                {processingError}
              </p>
            )}
            <PayRateBanner
              blockPayCents={blockPayCents}
              routeStartedAtMs={routeStartedAtMs}
              onSetBlockPay={() => setShowBlockPayPrompt(true)}
            />
            <DeadlineBanner
              routeStartedAtMs={routeStartedAtMs}
              routeEstDurationSeconds={routeEstDurationSeconds}
              completedStopCount={completedStops.length}
              totalStopCount={stops.length}
              deadlineTime={deadlineTime}
              onSetDeadline={() => setShowDeadlinePrompt(true)}
            />
            <ActiveStopCard
              currentStop={currentStop}
              totalStops={stops.length}
              onCompleteStop={handleCompleteStop}
              onSkipStop={handleSkipStop}
              routeExplanation={routeExplanation}
              driverPosition={driverPosition}
              geoError={geoError}
              preferredMapApp={preferredMapApp}
              onSetVehicleZone={handleSetVehicleZone}
              onOpenApartmentIntel={() => setShowApartmentEditor(true)}
              onReoptimize={handleReoptimize}
              isReoptimizing={isReoptimizing}
              isOnline={isOnline}
            />
            {currentStop && (
              <div className="max-w-md mx-auto px-4 pb-4 -mt-2">
                <button
                  onClick={() => setShowApartmentEditor(true)}
                  disabled={!currentStop.locationId}
                  className="w-full text-xs text-slate-400 underline py-2 disabled:text-slate-600 disabled:no-underline disabled:cursor-not-allowed"
                >
                  {currentStop.locationId
                    ? '🏢 Edit building intel for this stop'
                    : '🏢 Building intel unavailable (location not linked)'}
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {showApartmentEditor && currentStop?.locationId && (
        <ApartmentIntelEditor
          locationId={currentStop.locationId}
          onClose={() => setShowApartmentEditor(false)}
          onSaved={() => setShowApartmentEditor(false)}
        />
      )}

      {showBlockPayPrompt && (
        <BlockPayPrompt
          initialDollars={typeof blockPayCents === 'number' ? blockPayCents / 100 : null}
          onSave={handleSaveBlockPay}
          onSkip={handleSkipBlockPay}
        />
      )}

      {showOfferComparator && <OfferComparator onClose={() => setShowOfferComparator(false)} />}

      {showDeadlinePrompt && (
        <DeadlinePrompt initialTime={deadlineTime} onSave={handleSaveDeadline} onSkip={handleSkipDeadline} />
      )}
    </div>
  );
}
