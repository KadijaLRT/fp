# Amazon Flex Route Optimizer

Mobile-first PWA that OCRs a Flex itinerary screenshot, geocodes and
sequences the stops by total duration (not just distance), and learns
per-location delivery speed over time.

## Stack
- React + Vite + Tailwind, packaged as a PWA (`vite-plugin-pwa`)
- Vercel Serverless Functions (`api/`)
- Groq SDK for OCR (vision model) and route-shift explanations (reasoning model)
- Mapbox Geocoding + Matrix APIs
- Supabase (Postgres + Auth) for drivers, routes, and location learning

## Setup

```bash
npm install
cp .env.example .env.local   # fill in real keys
npm run dev
```

Set the same variables in your Vercel project dashboard (Settings → Environment
Variables) before deploying — `GROQ_API_KEY` stays server-only; everything
prefixed `VITE_` is bundled into the client.

Run `supabase/schema.sql` in the Supabase SQL editor to create tables, the
auto-learning trigger, and Row Level Security policies.

## Deploy
```bash
git push origin main   # if the repo is linked to Vercel, this auto-deploys
```
Then on your phone: open the deployment URL → Share/Menu → **Add to Home Screen**.

## Known limitations / things to verify before relying on this in production

1. **Groq model names drift.** Both models named in the original spec
   (`llama-3.2-11b-vision-preview`, `llama-3.3-70b-versatile`) are already
   decommissioned by Groq as of this build. This code uses
   `qwen/qwen3.6-27b` (vision) and `openai/gpt-oss-120b` (reasoning) instead,
   both overridable via env vars — check
   [console.groq.com/docs/models](https://console.groq.com/docs/models)
   periodically, since Groq deprecates preview models on short notice.
2. **Mapbox Matrix API caps at 25 coordinates per request — now handled
   transparently.** `api/optimize.js` tiles multiple Matrix API calls
   (12-stop chunks, run with limited concurrency) into a full N×N duration
   matrix for routes up to 100 stops, instead of rejecting anything over 25.
   A single stop pair failing to resolve degrades to a heavy-but-not-fatal
   penalty rather than failing the whole route; only a total Mapbox outage
   fails the request. Verified against synthetic 10/25/30-stop routes.
3. **The route solver is nearest-neighbor construction plus a 2-opt
   refinement pass**, not a true global TSP solver (that's NP-hard) — but
   no longer plain greedy nearest-neighbor either. 2-opt repeatedly tries
   reversing sub-segments of the route and keeps any reversal that lowers
   total cost, which eliminates the "zig-zag" crossings greedy construction
   is prone to. Bounded by an explicit time/evaluation budget
   (`TWO_OPT_TIME_BUDGET_MS` / `TWO_OPT_MAX_EVALUATIONS` in
   `api/optimize.js`) so it can't blow a serverless function's time limit.
   Verified against 20 randomized trials (sizes 8/15/30/45, five seeds
   each): 2-opt never produced a worse route than nearest-neighbor alone,
   and typically improved it 5-20%.
4. **Apartment intel linking is now wired up.** `src/lib/locations.js`
   upserts each geocoded address into `locations` (keyed on
   `formatted_address`, matching the schema's unique constraint) during
   route import, and stores the returned UUID on `stop.locationId`.
   `ApartmentIntelEditor` uses that real id, and the button disables itself
   with an explanatory label if linking failed for a given stop (e.g.
   Supabase not configured, or the write errored) instead of silently
   writing to nowhere. The route optimizer also now pulls each stop's
   learned `avg_total_stop_seconds` / `is_known_slow_stop` and factors it
   into the solver's cost function (see `api/optimize.js`), and
   `ActiveStopCard` shows a "known slow stop" badge with the historical
   average — this was called for in the original domain reasoning model
   but never actually connected to the solver until now.
5. **RLS was missing, and even after adding it there was a column-level
   gap — both addressed now.** The original schema had no RLS policies at
   all. `supabase/schema.sql` now scopes drivers to their own routes/stops,
   treats `locations`/`apartment_profiles` as crowd-sourced (any
   authenticated driver can read/contribute — reconsider if that's not your
   trust model). It also closes a follow-on gap: RLS controls which *rows*
   a role can touch, not which *columns*, so the crowd-write policy on
   `locations` would have let any driver's client directly overwrite the
   trigger-owned aggregate columns (`avg_total_stop_seconds`,
   `total_deliveries_count`, `is_known_slow_stop`) instead of only the
   `update_location_intelligence()` trigger being able to. Fixed via
   column-level `REVOKE`/`GRANT` plus a `SECURITY DEFINER` trigger function.
   Also added `CHECK` constraints (lat/lng bounds, enum-like text columns,
   non-negative durations) since RLS/grants control *who* can write, not
   *what* they write — nothing previously stopped `parking_difficulty:
   'lol'` or `latitude: 400` from being inserted.

## Live location & camera capture

Both gaps from the original web-to-mobile architecture brief are now implemented:

- **`src/utils/geolocation.js`** wraps `navigator.geolocation.watchPosition`
  with permission-state checks, accuracy filtering (fixes worse than 100m
  are ignored rather than trusted), and a haversine distance helper.
  `App.jsx` starts the watch only while a route is active (not on idle/
  upload screens, to avoid draining battery for no reason) and passes the
  live position down to `ActiveStopCard`, which shows a live distance
  badge and a geofenced "You've arrived" indicator (60m radius) that also
  highlights the Delivered button.
- **`ItineraryUpload.jsx`** now sets `capture="environment"` on the file
  input, so supporting mobile browsers open the rear camera directly
  instead of the gallery picker — while still falling back gracefully to a
  normal file picker (with library access) on browsers/devices that don't
  honor the attribute.

## Wiring audit — gaps found and closed

A later review specifically checked whether every schema column and every
documented feature was actually *wired end-to-end*, not just present. Two
real, previously-unnoticed gaps were found and fixed:

1. **Delivery-window urgency was silently a no-op.** The optimizer's
   `urgencyMultiplier()` (`api/optimize.js`) reads `stop.deliveryWindowEnd`,
   but nothing anywhere ever set that field — OCR only produces a free-text
   `deliveryWindow` string ("10:00 AM - 12:00 PM"), and it was never parsed
   into a real timestamp. "Prioritize approaching delivery time windows" (a
   documented core feature) had zero effect on route ordering. Fixed with
   `src/utils/deliveryWindow.js`, a best-effort parser for common Flex
   screenshot formats (verified against 9 sample strings including ranges,
   "By X", 24-hour notation, and unparseable text — fails closed to `null`
   rather than guessing wrong), wired into `App.jsx`'s geocoding step.
2. **The auto-learning loop never closed.** `routes` and `route_stops`
   were defined in the schema but nothing in the app ever wrote to them —
   `handleCompleteStop`/`handleSkipStop` only touched local React state.
   That meant `update_location_intelligence()` (the trigger that computes
   `avg_total_stop_seconds`/`is_known_slow_stop`) could never fire, so the
   "known slow stop" badge added earlier would never show real data despite
   looking fully wired, and `routes.efficiency_score` (feature #46) had a
   schema column that was never populated. Fixed with `src/lib/routes.js`
   (`createRoute`, `createRouteStops`, `finalizeRouteStop`, `finalizeRoute`,
   all best-effort/non-throwing) wired into route import and stop
   completion in `App.jsx`. `api/optimize.js` now also returns
   `estimatedDrivingSeconds` (pure driving time, no urgency/stop-duration
   modifiers) so there's something real to compare "actual" against —
   `efficiency_score` is computed as a simple, transparently-documented
   ratio (estimate ÷ actual, clamped 0-100), since the original spec never
   defined a formula beyond "0 to 100."
3. **`drivers.preferred_map_app` was never read.** The column existed and
   `AuthScreen` implicitly relied on its DB default, but navigation always
   hardcoded Google Maps regardless of what a driver had set. `App.jsx` now
   loads it on session load and passes it through to `ActiveStopCard`.

Verified: the delivery-window parser against 9 realistic OCR strings
(ranges, "By X", "Before X", 24-hour, unparseable); the
`estimatedDrivingSeconds` addition against the same randomized-trial
harness used for the earlier 2-opt verification, confirming no regression
in route quality or integrity.

## Project structure

```
api/                   Vercel serverless functions (OCR, optimize, explain-route)
src/components/        UI: upload, active stop card, auth, apartment editor
src/utils/              geocoder, navigation deep-linking
src/lib/                supabaseClient, auth helpers
supabase/schema.sql     DB schema, trigger, RLS policies
```
