/**
 * Deep-links out to a native maps app. Validates coordinates first since a
 * bad geocode (null lat/lng) silently navigating to "undefined,undefined"
 * is a bad experience for a driver who's already at the wheel.
 */
export function openExternalMap(lat, lng, label, appPreference = 'google') {
  if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    console.error('openExternalMap called with invalid coordinates:', lat, lng);
    return { success: false, error: 'This stop has no valid location yet. Edit the address first.' };
  }

  const encodedLabel = encodeURIComponent(label || 'Delivery stop');

  try {
    if (appPreference === 'waze') {
      window.location.href = `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
    } else if (appPreference === 'apple') {
      // Bug fix: this used to fire the universal-link fallback
      // unconditionally 500ms later, even when the maps:// scheme
      // actually succeeded — meaning a driver genuinely on iOS would get
      // a second, unwanted navigation the moment they switched back to
      // the browser tab. The fix: only fall back if the tab never
      // actually lost visibility (backgrounded) in that window, which is
      // what a successful app-switch looks like.
      let appSwitchedAway = false;
      const onVisibilityChange = () => {
        if (document.hidden) appSwitchedAway = true;
      };
      document.addEventListener('visibilitychange', onVisibilityChange);

      window.location.href = `maps://maps.apple.com/?daddr=${lat},${lng}&q=${encodedLabel}`;

      setTimeout(() => {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (!appSwitchedAway) {
          window.location.href = `https://maps.apple.com/?daddr=${lat},${lng}&q=${encodedLabel}`;
        }
      }, 500);
    } else {
      window.location.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    }
    return { success: true, error: null };
  } catch (err) {
    console.error('Failed to open external map:', err);
    return { success: false, error: 'Could not open maps app.' };
  }
}
