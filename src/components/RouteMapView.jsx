import React, { useEffect, useRef, useState } from 'react';

/**
 * Shows every stop as a pin on an actual map, colored by status, with a
 * thin line connecting them in route order (indicative, not road-accurate
 * — that would need the Directions API, a separate cost/call this doesn't
 * need to justify just to show "roughly this order"). Complements the
 * card (driving) and list (manifest review) views — this is for "where
 * am I relative to what's left," which neither of those actually shows.
 *
 * mapbox-gl is dynamically imported (large library — no reason to load it
 * for sessions that never switch to map view), same pattern as
 * tesseract.js elsewhere in this app.
 *
 * TESTING NOTE: unlike most of this codebase, this component could not be
 * visually verified — there's no browser/WebGL context available to
 * actually render a Mapbox GL map in this environment, the same class of
 * gap IndexedDB had until a Node-compatible implementation was found for
 * it. No equivalent exists for WebGL. Reviewed carefully against the
 * mapbox-gl v3 API, and the build compiles clean, but this is the one
 * component in the app that's genuinely unverified beyond that — worth
 * an actual look on a real device before trusting it fully.
 */
export default function RouteMapView({ stops, currentIndex, driverPosition }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const mapboxToken = import.meta.env.VITE_MAPBOX_TOKEN;
    if (!mapboxToken) {
      setError('Mapbox is not configured.');
      setLoading(false);
      return;
    }

    const routableStops = stops.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number');
    if (routableStops.length === 0) {
      setError('No stops have a valid location to show on the map yet.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    let map = null;

    (async () => {
      try {
        const mapboxgl = (await import('mapbox-gl')).default;
        await import('mapbox-gl/dist/mapbox-gl.css');
        if (cancelled || !containerRef.current) return;

        mapboxgl.accessToken = mapboxToken;

        map = new mapboxgl.Map({
          container: containerRef.current,
          style: 'mapbox://styles/mapbox/dark-v11',
          center: [routableStops[0].lng, routableStops[0].lat],
          zoom: 11
        });
        mapRef.current = map;

        map.on('load', () => {
          if (cancelled) return;

          map.addSource('route-line', {
            type: 'geojson',
            data: {
              type: 'Feature',
              geometry: {
                type: 'LineString',
                coordinates: routableStops.map((s) => [s.lng, s.lat])
              }
            }
          });
          map.addLayer({
            id: 'route-line',
            type: 'line',
            source: 'route-line',
            paint: { 'line-color': '#f59e0b', 'line-width': 2, 'line-opacity': 0.4, 'line-dasharray': [1, 1.5] }
          });

          const bounds = new mapboxgl.LngLatBounds();
          routableStops.forEach((s) => bounds.extend([s.lng, s.lat]));
          if (driverPosition) bounds.extend([driverPosition.lng, driverPosition.lat]);
          map.fitBounds(bounds, { padding: 48, maxZoom: 15 });

          setLoading(false);
        });

        map.on('error', (e) => {
          console.error('Mapbox GL error:', e);
          if (!cancelled) setError('Map failed to load.');
        });
      } catch (err) {
        console.error('Failed to load Mapbox GL:', err);
        if (!cancelled) {
          setError('Could not load the map.');
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      if (map) map.remove();
      mapRef.current = null;
    };
    // Intentionally only re-runs when the route itself changes (stop
    // count/order), not on every currentIndex/driverPosition tick — those
    // update the existing markers in the effect below instead of
    // rebuilding the whole map, which would flash/reset the view on every
    // GPS fix.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops.length]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || loading) return;

    (async () => {
      const mapboxgl = (await import('mapbox-gl')).default;
      if (!mapRef.current) return;

      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];

      stops.forEach((stop, idx) => {
        if (typeof stop.lat !== 'number' || typeof stop.lng !== 'number') return;

        const isCompleted = idx < currentIndex;
        const isCurrent = idx === currentIndex;
        const color = isCompleted ? '#10b981' : isCurrent ? '#f59e0b' : '#525252';

        const el = document.createElement('div');
        el.style.width = isCurrent ? '20px' : '14px';
        el.style.height = isCurrent ? '20px' : '14px';
        el.style.borderRadius = '50%';
        el.style.background = color;
        el.style.border = '2px solid #0a0a0a';
        el.style.boxShadow = isCurrent ? '0 0 0 4px rgba(245,158,11,0.3)' : 'none';

        const marker = new mapboxgl.Marker({ element: el })
          .setLngLat([stop.lng, stop.lat])
          .setPopup(new mapboxgl.Popup({ offset: 12 }).setText(`${stop.stopNumber}. ${stop.address}`))
          .addTo(map);
        markersRef.current.push(marker);
      });

      if (driverPosition) {
        const el = document.createElement('div');
        el.style.width = '16px';
        el.style.height = '16px';
        el.style.borderRadius = '50%';
        el.style.background = '#3b82f6';
        el.style.border = '3px solid white';
        const marker = new mapboxgl.Marker({ element: el }).setLngLat([driverPosition.lng, driverPosition.lat]).addTo(map);
        markersRef.current.push(marker);
      }
    })();
  }, [stops, currentIndex, driverPosition, loading]);

  if (error) {
    return (
      <div className="max-w-md mx-auto px-4">
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 text-center text-sm text-neutral-500">
          {error}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4">
      <div className="relative rounded-xl overflow-hidden border border-neutral-800" style={{ height: '60vh', minHeight: '360px' }}>
        {loading && (
          <div className="absolute inset-0 bg-neutral-900 flex items-center justify-center z-10">
            <span className="text-2xl animate-spin">⚙️</span>
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
      <div className="flex gap-4 justify-center mt-3 text-xs text-neutral-500">
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1.5" />Done</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500 mr-1.5" />Current</span>
        <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-neutral-600 mr-1.5" />Upcoming</span>
        {driverPosition && <span><span className="inline-block w-2.5 h-2.5 rounded-full bg-blue-500 mr-1.5" />You</span>}
      </div>
    </div>
  );
}
