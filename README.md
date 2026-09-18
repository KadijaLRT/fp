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

## Roadmap features added

A later roadmap review requested several new features. Implemented in this
pass, in order:

- **Rate limiting** (`api/_rateLimit.js`) — sliding-window limits on
  `/api/ocr`, `/api/optimize`, `/api/explain-route` via Upstash Redis
  (10/20/20 requests per minute per caller IP). Fails **open** — both when
  Upstash isn't configured and when it's configured but unreachable — since
  a rate limiter outage should never be able to take down the whole app.
  Set `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` before production
  traffic; without them, these endpoints have no request ceiling.
- **OCR fallback pipeline** — when Groq vision OCR fails, the driver gets
  two fallback paths instead of a dead end: a client-side Tesseract.js
  re-scan of the same image (dynamically imported, code-split into its own
  chunk so sessions that never need it don't pay the bundle cost), or fully
  manual entry. Both land in `ManualStopReview.jsx`, a mandatory edit
  screen — heuristically-extracted or hand-typed data is never trusted the
  way Groq's structured JSON output is.
- **Package/trunk zone tagging** — `route_stops.vehicle_zone` (schema +
  `updateVehicleZone()` + quick-tap chips on `ActiveStopCard`). This is
  manual-only: Flex itinerary screenshots have no source data for where a
  package physically is in the vehicle, so there was nothing for OCR to
  extract — a driver taps a zone when they load the vehicle.
- **Gate-code freshness badge** — `fetchApartmentIntelPreview()` surfaces
  whether crowd-sourced apartment intel exists for a stop and how old it
  is ("5d ago", "2mo ago") directly on `ActiveStopCard`, tappable straight
  into the editor, instead of the driver having to open the editor blind
  to find out if anything's there.
- **Battery/thermal guard mode** — an OLED true-black toggle
  (localStorage-persisted device preference, `bg-black` instead of
  `bg-slate-900`), plus an *honestly scoped* version of "adaptive GPS
  polling": a web app cannot tell a phone's GPS chip to sample at a
  different hardware rate — what it can control is how often it *acts* on
  incoming fixes. Updates are throttled to once per 15s when the driver is
  both far from the current stop (>0.2mi) and moving at highway speed
  (>30mph), and applied immediately otherwise, since that's where geofence
  accuracy actually matters.
- **Offline-first engine** — `src/lib/offlineStore.js` (IndexedDB
  wrapper — **note:** IndexedDB doesn't exist in a Node sandbox, so unlike
  everything else in this project this module could not be exercised with
  an actual runtime test, only carefully hand-reviewed; treat it with more
  scrutiny until it's run on a real device) caches the current route and
  queues writes that fail while offline for replay on reconnect.
  `src/utils/offlineSolver.js` is a local nearest-neighbor + 2-opt fallback
  using straight-line distance (verified: 12 randomized trials, route
  integrity confirmed, consistently beats nearest-neighbor-only, same
  methodology as the server solver's earlier verification) for when the
  network is unreachable. This surfaced a second gap while building it:
  **"🔥 REOPTIMIZE" was named in this project's original system prompt but
  never actually implemented** — added now as `handleReoptimize` in
  `App.jsx`, re-sequencing only the remaining (not-yet-completed) stops,
  using the server solver when online and falling back to the offline
  solver when not.

### Explicitly not implemented — flagged rather than faked

- **Right-side/curb delivery bias.** True side-of-street routing needs
  Mapbox's Directions API with per-leg `approaches` parameters, not the
  Matrix API this app uses for TSP costing. Building a "looks like it
  works" heuristic (e.g. comparing route bearing to a stop's offset) would
  give false confidence about a safety-adjacent feature — avoiding
  dangerous left turns across traffic — without it actually being
  verified to work. This needs a real Directions API integration, which is
  a separate scope of work, not a quick addition to the existing solver.
- **Package barcode scan / weather-aware buffers** — not yet built in this
  pass; see the roadmap conversation for scoping notes (barcode scanning
  via the `BarcodeDetector` Web API is Chrome/Android-only, no Safari/iOS
  support — worth confirming that's acceptable before building around it;
  weather buffers need a provider decision, Open-Meteo requires no API key
  and is a reasonable default).

## Follow-up fixes: offline restore, zone suggestions, night-driving theme

Three specific asks led to finding and fixing real gaps rather than just
adding the features literally as described:

1. **Offline cache now actually restores, and had a real bug.** The cache
   was write-only — nothing ever read it back, so an app kill/reload while
   offline (the exact rural-dead-zone scenario this exists for) lost the
   driver's progress entirely. Also found and fixed a stale-closure bug:
   `cacheRouteOffline` was reading the `currentRouteId` **state** variable
   immediately after calling `setCurrentRouteId()` in the same function —
   React state updates aren't synchronous, so every route after the first
   in a session was caching under the *previous* route's id. Fixed by
   using the locally-scoped id instead. The cache now also updates as the
   driver progresses (not just at import), stores enough metadata for a
   faithful resume (`currentIndex`, `routeStartedAtMs`,
   `routeEstDurationSeconds`), and offers an explicit Resume/Discard
   prompt on mount rather than silently reappearing — a route from days
   ago shouldn't resume without being asked.
2. **Package zone tagging is a deterministic suggestion, not an OCR
   feature.** A Flex itinerary screenshot has no visual data about where a
   package sits in the vehicle — there's nothing for Groq's vision model to
   read. `src/utils/vehicleZoneSuggester.js` instead auto-suggests a zone
   per stop based on route position (early stops → easy-reach zones, later
   stops → deeper trunk), which is more reliable and instant/free compared
   to asking an LLM to guess with no image of the actual vehicle. Verified
   directly: zone distribution across a 30-stop route, edge cases (empty/
   short routes), and confirmed it never overwrites a zone the driver
   already set manually.
3. **`ActiveStopCard` was never actually dark-themed.** The OLED toggle
   only ever changed the app shell (header/background) — the stop card
   itself, which is what's on screen almost the entire time a driver is
   working a route, was a bright white card with black text regardless of
   the toggle. That's a real glare issue for night driving, not just a
   missing feature — fixed by making the card dark by default (not gated
   behind the toggle, since a blinding white card was never the right
   default for an app used mostly at night/dawn/dusk), with all badge
   colors converted to dark-appropriate contrast and larger text for the
   address/timer for at-a-glance readability while driving. Note: the
   upload screen, manual-entry review, and apartment-intel editor are
   still light-themed — only the active navigation view (what's on screen
   while actually driving) was in scope here.

## Live $/hr pace tracking

Added after a priority conversation about low-block-volume drivers (1-2
Flex blocks/week) needing every block to count — the app previously
optimized purely for time, with no dollar figure anywhere. Since block pay
is fixed once accepted, minimizing time is a reasonable proxy for
maximizing $/hr, but there was no way to actually *see* the real pace
while driving, or compare across the rare blocks a low-volume driver gets.

- **`routes.block_pay_cents`** (schema) — manual entry only. Amazon's
  block-offer screen (where pay is shown) is a different screen than the
  itinerary/stop-list screenshot this app OCRs, so there's no source for
  this in the parsed image.
- **`BlockPayPrompt.jsx`** — a lightweight modal shown right after a route
  is optimized, asking what the block pays (skippable, addable later via
  the pace banner).
- **`PayRateBanner.jsx`** — a self-ticking (own 1s interval, doesn't force
  the whole app to re-render) live pace display: `$XX.XX/hr`, color-coded
  against rough Flex pay benchmarks (≥$25/hr green, ≥$15/hr amber, below
  red) so it's meaningful at a glance rather than a raw number the driver
  has to judge. Deliberately withholds the rate for the first 60 seconds
  of a block — dividing a fixed pay by a few seconds of elapsed time
  produces a wildly inflated, meaningless figure. Verified: the underlying
  math directly, and all four render states (inactive, no-pay-set,
  too-early-to-show, correct calculation) via SSR rendering.
- Route completion now shows the final $/hr achieved for the block, not
  just a generic "done" message.

**Bug caught while wiring this in:** `routeStartedAtMs` (which the pace
banner depends on) was previously only ever set *inside* the
Supabase-persistence code path — meaning if Supabase wasn't configured,
the route clock never started and the pace banner would silently never
appear at all, despite live pace tracking having no actual dependency on
a backend. Fixed by starting the clock unconditionally and making DB
persistence a separate, independent concern.

**`src/utils/payRate.js`** now holds the shared rate-formatting/color
logic so `PayRateBanner` and `OfferComparator` (below) can't quietly drift
into disagreeing about what counts as a "good" rate.

## Compare Offers — removed

The pre-accept $/hr comparator (`OfferComparator.jsx`) was removed:
filling out pay/duration/start-time fields for each offer isn't something
you can realistically do in the few seconds an offer actually sits on
screen before it's gone, so the feature had no real-world usable moment
despite being technically correct. Removed along with its
offer-comparator-only dependents: `src/lib/preferredStations.js` (the
station quick-select chips existed purely to speed up data entry into the
now-removed comparator) and the "Your stations" display on the Home
screen, which had no other purpose once nothing consumed it.
`PayRateBanner` (live pace *during* a route) and the deadline-tracking
system (`DeadlineBanner`/`DeadlinePrompt`/`driverDeadline.js`) are
unaffected — both are genuinely usable in real time while driving, unlike
a pre-accept form.




```
api/                   Vercel serverless functions (OCR, optimize, explain-route)
src/components/        UI: upload, active stop card, auth, apartment editor
src/utils/              geocoder, navigation deep-linking
src/lib/                supabaseClient, auth helpers
supabase/schema.sql     DB schema, trigger, RLS policies
```

## "Must finish by" deadline warning

Added after context about a hard time constraint (needing to be done and
home before a school-morning routine) explaining a preference for very
early blocks. `src/utils/deadlineProjection.js` is the pure logic —
verified with 11 direct assertions before any UI was built on top of it,
including the pace-extrapolation math, deadline-string parsing, and all
three status boundaries (comfortable/tight/late).

- **`DeadlinePrompt.jsx`** — optional, skippable modal to set a "need to
  be done by" time, same pattern as `BlockPayPrompt`.
- **`DeadlineBanner.jsx`** — self-ticking (own 1s interval) live
  projection: "⏰ on pace — finishing ~7:52 AM" vs "cutting it close" vs
  "running late", color-coded. Before any stops are completed, the
  projection falls back to the optimizer's pure-driving-time estimate
  (which understates real time — no per-stop service time included — so it
  reads as optimistic, not authoritative); once stops start completing, it
  extrapolates from actual pace-so-far instead, which is more honest but
  still just a linear extrapolation, not a promise. Verified via rendered
  output using a scenario matching the described situation (3am start,
  4/20 stops after 1 hour, 8:30am deadline).

Reset alongside `blockPayCents` at the same three points (new route
imported, route completed, route abandoned) so a deadline from a previous
block never silently carries over to a new one.

### Deadline checking

`src/lib/driverDeadline.js` stores the deadline as a saved *standing*
preference ("need to be done by 8:30") rather than something re-entered
per block, since for a driver with a fixed daily constraint that's the
more honest model — `DeadlinePrompt` pre-fills from it and saves back to
it. (This originally also fed a pre-accept version of the check in the
now-removed Compare Offers feature; that part went with it, but the
in-route `DeadlineBanner` check is unaffected.)


## Schema fix: re-running `schema.sql` no longer errors

Caught from a screenshot of a real Supabase SQL editor run against
production: `ERROR 42710: constraint "chk_locations_lat_range" ... already
exists`. Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, and the SQL
editor runs a script's statements in order — so re-running `schema.sql`
against a database that already had these constraints (from an earlier
run) failed partway through and left everything after that point
un-applied, silently. `CREATE POLICY` has the same limitation and would
have hit the identical error on the very next statement once the first
was fixed.

Fixed throughout: every `ADD CONSTRAINT` is now preceded by a
`DROP CONSTRAINT IF EXISTS` for the same name, and every `CREATE POLICY`
by a `DROP POLICY IF EXISTS` — both are the standard idempotent pattern
for objects Postgres doesn't support `IF NOT EXISTS` on directly. Verified
mechanically, not just by eye: every drop/recreate pair's name matches
exactly (16 constraints, 16 policies, checked programmatically against
the actual file rather than assumed from the edit). The file is now safe
to run any number of times — first time or fiftieth, on an empty database
or one that already has everything from a prior partial run.

**Follow-up fix, same root cause, a different symptom.** After the fix
above, re-running the file against production hit
`ERROR 42703: column "vehicle_zone" does not exist`. `CREATE TABLE IF NOT
EXISTS` is a no-op once a table exists — so a column added to a table's
*definition* in a later revision of this file than the one that first
created that table never actually reached the real database; it only
existed in the file. `vehicle_zone` (added for package-zone tagging) and
`block_pay_cents` (added for pay-rate tracking) were the two casualties,
but rather than patch just those two, every nullable column across all
five tables now has an `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` right
after its `CREATE TABLE IF NOT EXISTS`, converging any existing table
(however old) to the current full definition regardless of which
historical version first created it. The handful of `NOT NULL`-with-no-
`DEFAULT` columns (`email`, `total_stops`, `formatted_address`,
`latitude`, `longitude`, `sequence_order`) are deliberately left alone,
since they were part of every version of this schema from the start, and
retroactively adding a `NOT NULL` column with no default to a table that
may already have rows would itself fail.

Verified with a per-table script comparing each `CREATE TABLE`'s column
list against its `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` list: every
column matches with zero typos, zero columns attached to the wrong table,
and the only "missing" ones are exactly the six intentionally-excluded
`NOT NULL` columns listed above — confirmed programmatically, not
eyeballed.

## Safe-area fix: header was rendering under the status bar

Caught from a screenshot: the "FLEX ROUTE OPTIMIZER" header was drawing
directly under the iPhone status bar/clock, overlapping and unreadable.
`index.html`'s viewport meta already sets `viewport-fit=cover` (needed
for a proper full-screen PWA — without it the app would show white bars
around the notch/status bar instead of extending behind it), but nothing
in the app actually padded for that safe area. This is the exact "Notch &
Keyboard Occlusion" item from this project's original hardening
checklist — specified as a requirement from the very first version, never
actually implemented until this screenshot surfaced it visibly.

Fixed: the header now gets
`pt-[calc(1rem+env(safe-area-inset-top))]` instead of plain `p-4`, and
the same class of fix was applied proactively (not yet screenshotted, but
structurally identical risk) to all four bottom-sheet modals
(`BlockPayPrompt`, `DeadlinePrompt`, `ApartmentIntelEditor`,
`OfferComparator`) — each slides up flush against the literal bottom edge
of the viewport on mobile, which on an iPhone sits under the home
indicator / gesture bar. Verified the compiled CSS actually contains both
`env(safe-area-inset-top)` and `env(safe-area-inset-bottom)` rules after
building, not just that the source edit looked right.

## Camera-only bug fixed, Home screen added

**Real regression, my mistake.** `capture="environment"` (added earlier
based on the original brief's camera-access language) was forcing the
file input straight to the camera app with no path to the photo library
on iOS — but a Flex itinerary is a screenshot already sitting in Photos
from the Flex app, never something to photograph live. Removed the
attribute entirely; `ItineraryUpload` now opens the standard picker
(library, camera, files), which is what the app's actual use case always
needed.

**`HomeScreen.jsx`** — the idle screen was previously just a bare upload
card, which read more like a debug screen than an app. Now the entry
point is proper branding plus two clear primary actions (Upload
Itinerary, Compare Offers) as equally-weighted cards, a personalized
greeting when signed in, and a light touch of the driver's saved
preferred stations. Upload now lives behind its own sub-screen (reachable
from Home, with a "← Home" back button) rather than being the only thing
on screen. Verified via rendered output: the personalized greeting when
an email is present, the fallback tagline when not, both action cards,
and the station chips all render correctly.

## Full line-by-line audit

A rigorous pass through all 32 source files plus schema.sql (not a
skim — every file read in full, cross-referenced against how it's
actually called elsewhere in the app) found 8 real bugs, all fixed and
verified:

1. **Auto-learning trigger double-counted deliveries.** The trigger only
   checked `NEW.status = 'completed'`, never comparing against
   `OLD.status` — so any repeat update to an already-completed
   `route_stops` row (a double-tap, or the offline queue replaying a
   write that had actually already succeeded) would fire again and
   silently double-count that delivery into the location's learned
   average. Fixed with `OLD.status IS DISTINCT FROM 'completed'`.
2. **No double-tap lock on DELIVERED/SKIP** — the bug that fed #1 in
   practice. `setCurrentIndex(prev => prev + 1)` isn't idempotent, so two
   fires before re-render genuinely advance the index by 2, silently
   skipping a stop the driver never saw. This was a named requirement in
   the original project brief, never implemented. Fixed with a
   synchronous ref-based lock (a `useState` alone isn't fast enough to
   catch two events in the same tick) plus a visual disabled/"Saving…"
   state. Verified directly: two rapid calls produce exactly one
   execution; resetting and tapping again correctly produces a second.
3. **Offline route restore silently dropped pay/deadline tracking** — the
   IndexedDB cache never stored `blockPayCents`/`deadlineTime`, so
   resuming an interrupted route (the exact scenario the cache exists
   for) lost both silently. Fixed and verified round-trip through real
   IndexedDB (via `fake-indexeddb`, finally closing a testing gap that
   had been flagged but not resolved across several earlier rounds).
4. **Stale closure in the reoptimize cache write** — read the
   closed-over `stops` variable instead of fresh state, which could
   silently drop a concurrent vehicle-zone tag from the cache if it
   landed while a reoptimize network call was in flight. Fixed by
   removing the redundant/buggy explicit call and relying on the
   existing auto-sync effect, which always reads fresh state.
5. **Apple Maps fired a spurious second navigation** — the fallback link
   fired unconditionally 500ms later even when the `maps://` scheme
   succeeded, so a driver genuinely on iOS got an unwanted redirect when
   switching back to the browser. Fixed with a `visibilitychange` check.
   Verified both branches directly: app-switch-succeeds (no fallback
   fires) and app-switch-fails (fallback correctly still fires).
6. **OCR text parser could misattribute data between duplicate-address
   stops** — `lines.indexOf(line)` found only the first match of a given
   line's text, so two stops with identical address text (plausible for
   duplicate deliveries to the same apartment complex) would have their
   package count/delivery window extraction scrambled. Fixed by tracking
   `{line, index}` pairs through the filter instead of re-deriving
   positions afterward. Verified with the exact duplicate-address
   scenario: each stop now correctly keeps its own data.
7. Misplaced JSDoc comment in `routes.js` (described the wrong function).
8. Index-based React `key` in `ManualStopReview.jsx` (cosmetic focus-jump
   risk on row removal, not data corruption) — given a stable synthetic
   key instead.

Also fixed opportunistically while in these files: a misleading comment
in `auth.js` claiming a database trigger creates the `drivers` row (no
such trigger exists — the client-side upsert is the only mechanism, and
there's no retry if it fails, which is a real if narrow gap worth
knowing about), a dead no-op ternary in `optimize.js`, and a comment
typo.

## Multiple screenshot upload (large routes, 50+ stops)

A single Flex itinerary screenshot only shows ~15-20 stops before
scrolling, so a 55-stop route needs several images — `ItineraryUpload.jsx`
now accepts multiple files at once (`multiple` on the file input) and
processes each through `/api/ocr` independently (limited concurrency, 3 at
a time, reusing the same worker-pool pattern as `geocodeAddressBatch`),
then merges every successfully-scanned screenshot's stops into one
itinerary, renumbered sequentially in upload order.

Deliberately **not** all-or-nothing: if one screenshot in a batch fails
OCR, the others still succeed and merge normally — the failed one gets
its own retry / text-scan / manual-entry recovery options inline, so a
single bad photo doesn't cost you the rest of an otherwise-successful
50-stop import. Confirming a manual/text-scan recovery for a failed item
merges it back into the batch as a normal success, going through the same
"Continue with N stops" step as everything else.

**Known limitation, stated plainly rather than silently handled:** the
merge trusts upload order as the best available signal for overall stop
sequence (each screenshot's own OCR'd `stopNumber` restarts at 1 and has
no idea it's part of a larger set, so it's ignored in favor of sequential
renumbering after merge). This matters less than it might sound: actual
delivery order is decided by the route optimizer from real coordinates,
not by this initial numbering. What merge order can't detect is
**overlapping screenshots** — if two images both captured some of the
same stops (overlapping scroll positions), those stops appear twice in
the merged list. Worth a glance at the total count against what the Flex
app shows before starting the route; no automatic dedup is attempted,
since two genuinely different stops can look very similar (same street,
different unit) and a false-positive removal is worse than a rare
duplicate.

Verified directly: a 3-screenshot / 55-stop merge (including one
screenshot failing) produces exactly 55 correctly-renumbered stops in the
right order with no duplicate numbers, and the full 55-stop set was run
through `api/optimize.js`'s chunked-matrix path end-to-end (55 > 25,
so this exercises the tiling logic, not the single-request fast path) —
55 stops back, no duplicates or missing entries, in under 30ms against a
mocked Mapbox response.

## Real production incident: OCR failing on every screenshot

A screenshot showed two uploaded screenshots both failing with a bare
"✗ Failed" and no other information. Two real problems, chased down and
fixed, not just patched over:

1. **The error message was invisible on the device that matters.** It
   only lived in an HTML `title` attribute — a hover tooltip, which does
   nothing on a touchscreen. A driver had no way to ever see *why*
   something failed, on the one device type this app actually runs on.
   Fixed: the message now renders as visible text under the failed item.
2. **The root cause, once visible, would have been a model 404.**
   `qwen/qwen3.6-27b` (this file's vision-model default) has been
   withdrawn by Groq — confirmed via a corroborated real-world bug report
   in another project hitting the identical symptom, even though Groq's
   own docs page still listed it as current at the time. It's a preview
   model, which Groq's own vision docs note explicitly is "intended for
   evaluation, not production" — exactly the kind of model that gets
   pulled with little notice regardless of what the docs say. Switched
   the default to `qwen/qwen3.8-27b`, the newer model in the same family,
   also confirmed as a currently-documented vision model (not a blind
   guess — `openai/gpt-oss-120b`, tempting as a swap since it's used
   elsewhere in this app, is text-only and would have silently broken
   OCR entirely rather than fixing it).
3. **Added specific 404 handling** in `api/ocr.js` — previously a
   withdrawn-model error fell through to a generic "Failed to reach the
   OCR service" message, indistinguishable from an actual network
   problem. Now surfaces a specific, correctly-scoped message ("OCR model
   temporarily unavailable, not your screenshot's fault") and logs the
   exact model name for whoever's maintaining the deploy to act on.

**The uncomfortable part worth being honest about:** this exact failure
mode (a Groq preview vision model getting silently withdrawn) already
happened once before in this project (`llama-3.2-11b-vision-preview`,
back at the very start) and is *why* the model was made env-configurable
in the first place — and it still happened again, because "configurable"
only helps once someone notices and changes it. If OCR ever silently
stops working again, check `console.groq.com/docs/vision` for the
current model list before assuming the code itself is broken.

## Text scan fallback was completely broken — real fix, not a guess

Checked directly rather than assumed: `await import('tesseract.js')`
returns the ES module **namespace object**, not the package's actual
API surface. Tesseract.js ships as CJS with `recognize`/`createWorker`/
etc. attached to `module.exports`, which lands on that namespace
object's `.default` property, not on the object itself. The previous
code called `Tesseract.recognize(...)` directly on the namespace object
— which is `undefined` there — so every single text-scan attempt threw
a `TypeError` immediately, silently caught by the surrounding try/catch,
and always reported "text scan also failed" regardless of image quality.
Confirmed both the bug and the fix directly against the real installed
package (not assumed from documentation): `Tesseract.recognize` is
`undefined` on the raw import, `Tesseract.default.recognize` is a real
function. Fixed by destructuring `{ default: Tesseract }` at the import
site. Code-splitting confirmed unaffected — same 16KB separate chunk as
before, so Tesseract still isn't bundled into the main app for sessions
that never need it.

**Manual entry — structurally correct, but likely hitting a separate,
non-code issue.** `ManualStopReview.jsx` and the batch-merge logic in
`ItineraryUpload.jsx` were reviewed line by line and are sound — no bug
found there. But every path (OCR success, text-scan recovery, and manual
entry) all funnel into the same `handleRouteImported` in `App.jsx`, whose
very first action is checking `VITE_MAPBOX_TOKEN`. If that's still unset
on the live deployment (the exact error shown in this project's very
first screenshot), *every* import method would fail identically the
moment "Continue" is pressed — which would look like "nothing works"
even though only the text-scan path had an actual code bug. Worth
confirming directly: does manually entering a stop and hitting Continue
show "Mapbox is not configured (VITE_MAPBOX_TOKEN missing)" in red text?
If so, that's a Vercel environment-variable configuration issue, not
something a code fix can address — see the "how do I add API key"
section of this README's history for the exact steps (Vercel dashboard →
Environment Variables → add `VITE_MAPBOX_TOKEN` → **redeploy**, since
Vite bakes env vars in at build time and a restart alone won't pick up a
newly-added one).

## The real manual-entry bug (once Mapbox/Groq were confirmed set)

With both API keys confirmed configured, the actual bug was structural,
not configuration: `handleRouteImported` required **2 or more** routable
stops just to proceed at all — a threshold that makes sense for the
*optimizer* (nothing to route between one point) but was wrongly gating
whether the app could use a single stop at all. Traced precisely:

- **One address, geocoded successfully:** no error shown, but the route
  never actually started — `routeStartedAtMs` stayed null, nothing
  persisted, no pay/deadline banners — a silently stranded half-state.
- **One address, geocoding failed:** dumped into a broken "active route"
  view for an unnavigable stop, with a message reading *"add at least 2
  valid addresses"* — actively misleading, since the real problem was
  that the one address entered didn't resolve, not that more were needed.

Fixed by splitting what used to be one combined check into what it
actually is: **zero** routable stops is the only real failure (stay on
the import screen, show an accurate message about the address itself,
never touch `stops` state); **one** routable stop is a completely
legitimate route (skip the network round trip to `/api/optimize` — there's
nothing to order between a single point — and run it through the exact
same persistence/caching/clock-start pipeline multi-stop routes get);
**two or more** is the original optimize path, unchanged. Verified by
tracing the downstream consequences directly: `handleCompleteStop`'s
existing branch logic (`currentIndex < stops.length - 1`) correctly
completes a route when `stops.length === 1` without any special-casing
needed there, and `ActiveStopCard` renders "Stop 1 of 1" cleanly. This
one wasn't verified with an executable test the way the pure-logic files
were — it's threaded through live geocoding/session/Supabase state that
isn't practical to mock outside a real browser — so it's worth an actual
click-through on a real device before fully trusting it.

