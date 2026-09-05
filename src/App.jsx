import React, { useState, useEffect, useCallback } from 'react';
import ItineraryUpload from './components/ItineraryUpload';
import ActiveStopCard from './components/ActiveStopCard';
import AuthScreen from './components/AuthScreen';
import ApartmentIntelEditor from './components/ApartmentIntelEditor';
import { geocodeAddressBatch } from './utils/geocoder';
import { watchDriverPosition } from './utils/geolocation';
import { parseDeliveryWindowEnd } from './utils/deliveryWindow';
import { upsertLocationBatch, fetchLocationIntelligence } from './lib/locations';
import { createRoute, createRouteStops, finalizeRouteStop, finalizeRoute } from './lib/routes';
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

  // --- Live GPS tracking ---------------------------------------------------
  // Only watch position while there's an active route to work — starting a
  // GPS watch during upload/idle screens would drain battery for no
  // benefit, and most drivers would reasonably not expect background
  // tracking before they've actually imported a route.
  useEffect(() => {
    if (stops.length === 0) {
      setDriverPosition(null);
      return;
    }

    const unsubscribe = watchDriverPosition(
      (pos) => {
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
          console.error('Optimization failed, falling back to unoptimized order:', result.error);
          setProcessingError(`Route optimization failed (${result.error || 'unknown error'}). Showing stops in original order.`);
        }
      } catch (optErr) {
        console.error('Optimize request failed:', optErr);
        setProcessingError('Could not reach the route optimizer. Showing stops in original order.');
      }

      if (unresolvedCount > 0) {
        setProcessingError((prev) =>
          prev ? prev : `${unresolvedCount} address(es) need manual review — check the flagged stops.`
        );
      }

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
            estDurationSeconds: estimatedDrivingSeconds
          });

          if (routeId) {
            const routeStopIdsByStopId = await createRouteStops(routeId, finalRoute);
            finalRoute = finalRoute.map((s) => ({ ...s, routeStopId: routeStopIdsByStopId[s.id] || null }));
            setCurrentRouteId(routeId);
            setRouteStartedAtMs(Date.now());
            setRouteEstDurationSeconds(estimatedDrivingSeconds);
          }
        } catch (persistErr) {
          console.error('Route persistence failed (non-fatal — history will not be saved):', persistErr);
        }
      }

      setStops(finalRoute);
      setCurrentIndex(0);
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

  const handleCompleteStop = useCallback(
    (stopMetrics) => {
      setCompletedStops((prev) => [...prev, stopMetrics]);
      setRouteExplanation(null);

      // Fire-and-forget: this is the one write in the app that actually
      // feeds the auto-learning trigger (update_location_intelligence
      // fires AFTER UPDATE ON route_stops when status becomes 'completed').
      // finalizeRouteStop never throws — a failed write just means this
      // stop's timing won't be learned from, not a broken UI.
      const completedStop = stops.find((s) => s.id === stopMetrics.stopId);
      if (completedStop?.routeStopId) {
        finalizeRouteStop(completedStop.routeStopId, {
          status: 'completed',
          totalStopSeconds: stopMetrics.durationSeconds
        });
      }

      if (currentIndex < stops.length - 1) {
        setCurrentIndex((prev) => prev + 1);
      } else {
        if (currentRouteId && routeStartedAtMs) {
          finalizeRoute(currentRouteId, {
            estDurationSeconds: routeEstDurationSeconds,
            actualDurationSeconds: (Date.now() - routeStartedAtMs) / 1000
          });
        }
        setStops([]);
        setCurrentIndex(0);
        setCurrentRouteId(null);
        setRouteStartedAtMs(null);
        setRouteEstDurationSeconds(null);
        alert('🎉 Route Complete! Awesome job.');
      }
    },
    [currentIndex, stops, currentRouteId, routeStartedAtMs, routeEstDurationSeconds]
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

  const handleNewRoute = () => {
    // If the driver abandons a route mid-way (taps "New Route" instead of
    // finishing), still close out the DB row with whatever actually
    // happened rather than leaving it permanently "in progress" with no
    // completed_at — an abandoned route is a real outcome worth recording,
    // not a reason to silently drop the data.
    if (currentRouteId && routeStartedAtMs) {
      finalizeRoute(currentRouteId, {
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
    <div className="min-h-screen bg-slate-900 text-slate-100 flex flex-col font-sans">
      <header className="p-4 bg-slate-800 border-b border-slate-700 flex justify-between items-center">
        <h1 className="font-extrabold text-base tracking-tight text-amber-400">
          ⚡ FLEX ROUTE OPTIMIZER
        </h1>
        <div className="flex items-center gap-2">
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
            {processingError && (
              <p role="alert" className="text-center text-xs text-red-400 font-semibold mb-3 px-4">
                {processingError}
              </p>
            )}
            <ItineraryUpload onRouteImported={handleRouteImported} />
          </div>
        ) : (
          <div>
            {processingError && (
              <p role="alert" className="text-center text-xs text-amber-400 font-semibold mb-3 px-4">
                {processingError}
              </p>
            )}
            <ActiveStopCard
              currentStop={currentStop}
              totalStops={stops.length}
              onCompleteStop={handleCompleteStop}
              onSkipStop={handleSkipStop}
              routeExplanation={routeExplanation}
              driverPosition={driverPosition}
              geoError={geoError}
              preferredMapApp={preferredMapApp}
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
    </div>
  );
}
