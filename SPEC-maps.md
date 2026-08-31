# TripSitter — Maps feature spec (E2E)

Two surfaces, one shared geo layer:

1. **Global globe** — a slowly-rotating 3D globe on the trips overview. Own
   full-screen "Map" view, reached by tapping the globe. Shows every trip's
   stays as points and every transport leg as an arc; a heatmap of time spent;
   click a point/arc to jump to that entry in the app.
2. **Per-trip mini-map** — a small static map on each trip's Trip tab, framed on
   that trip's tagged/visited places (local hops, not the long-haul flight in).

---

## 0. Guiding decisions (settled)

- **Geocoding is mostly deterministic**, not AI:
  - **Flights** → airport IATA/ICAO code → fixed lat/lng from a bundled airport
    table. Origin/destination text like "Frankfurt (FRA)" → extract `FRA`.
  - **Bus / train / car / ferry** → if the text names a station/stop, geocode
    it (Nominatim); otherwise fall back to the **main/central station of the
    named city** ("Chicago" → Chicago Union Station area, or just the city
    centroid — good enough at globe scale).
  - **Stays** → geocode the `address`; fall back to the place-tag's
    `geonameId` coords; fall back to the city centroid.
- **Coords are stored, not recomputed.** Once resolved, `lat`/`lng` live on the
  row. A background pass fills gaps; the user can correct with a pin.
- **The globe loads lazily** — its library and the airport table are only
  fetched when the Map view opens, never on the overview's critical path.
- **The per-trip mini-map is a static image** (a raster map tile snapshot or a
  lightweight 2D canvas), not the 3D globe — cheap, instant, no rotation.
- **Both surfaces share** the same geo resolution code and the same
  click-through routing (`openTrip` + tab/card focus).

---

## 1. Data model

### 1a. New columns

```sql
-- stays: where the stay physically is
alter table stays add column if not exists lat  double precision;
alter table stays add column if not exists lng  double precision;
alter table stays add column if not exists geo_source text;   -- 'address' | 'placetag' | 'city' | 'manual' | null

-- transport: both ends
alter table transport add column if not exists origin_lat  double precision;
alter table transport add column if not exists origin_lng  double precision;
alter table transport add column if not exists dest_lat    double precision;
alter table transport add column if not exists dest_lng    double precision;
alter table transport add column if not exists geo_source  text;   -- 'iata' | 'station' | 'city' | 'manual' | 'partial' | null
```

`place_tags` already carries `geonameId`; we also start storing `lat`/`lng` on
each tag object when GeoNames returns them (no schema change — it's jsonb):

```jsonc
{ "label": "Chicago", "kind": "city", "country": "US",
  "admin": "Illinois", "geonameId": 4887398, "lat": 41.85, "lng": -87.65 }
```

### 1b. Bundled reference data

- `data/airports.json` — IATA code → `{ name, city, country, lat, lng }`.
  Source: OurAirports public-domain dataset, filtered to airports with an IATA
  code and scheduled service (~5–6k rows, ~400 KB). Refresh script like the
  visa one.
- No bundled station database — stations resolve live via Nominatim, cached
  into the row.

---

## 2. Geo resolution service

New file: `api/geocode.js` (Vercel function). Thin, provider-swappable, same
pattern as `geo-search` / `fx` / `parse-ticket`.

```
GET /api/geocode?q=<free text>&country=<ISO2 optional>
→ { lat, lng, display_name, source: 'nominatim' } | { lat: null }
```

- Backend: **Nominatim** (`nominatim.openstreetmap.org/search`), `format=json`,
  `limit=1`, `email=` param (their usage policy), 1 req/sec — we call it
  server-side and cache aggressively (`s-maxage` + our own row cache).
- The airport lookup does **not** hit this endpoint — it's a local table lookup
  in the client (or a `?iata=` mode on this function if we prefer server-side).

### 2a. Client-side resolver (`resolveGeo.js` logic, lives in index.html)

```
async function geoForTransportEnd(text, mode):
  iata = extractIATA(text)                    # /\b([A-Z]{3})\b/ near "(" ")" or known list
  if mode == 'flight' and iata in AIRPORTS:   return AIRPORTS[iata] , source 'iata'
  # station / city
  hit = await /api/geocode?q=`${text} station` (for bus/train)  or  q=text
  if hit.lat: return hit, source 'station'|'city'
  hit = await /api/geocode?q=cityOnly(text)
  if hit.lat: return hit, source 'city'
  return null

async function geoForStay(stay, tripPlaceTags):
  if stay.address: hit = await /api/geocode?q=stay.address
      if hit.lat: return hit, 'address'
  tag = matching place tag by city; if tag.lat: return {tag.lat,tag.lng}, 'placetag'
  hit = await /api/geocode?q=`${stay.city}`
  if hit.lat: return hit, 'city'
  return null
```

### 2b. When resolution runs

1. **On save** — after adding/editing a stay or transport row, kick off geo
   resolution for the changed fields (fire-and-forget; writes `lat`/`lng` back).
2. **Backfill pass** — when the Map view opens, any row for the current scope
   with null coords is resolved then (throttled, max ~5 concurrent), results
   written back so it's a one-time cost per row.
3. **Manual override** — a "set location" affordance (see §5) writes
   `geo_source = 'manual'` and is never overwritten by the automatic passes.

---

## 3. Global globe view

### 3a. Entry point — DECIDED: live globe.gl on the overview

The overview shows a **live, rotating globe.gl instance** (~280px tall, full
card width) above the trip list, with stay points for all trips. It auto-loads
globe.gl on the overview (accepted cost: ~250 ms added first-paint, a standing
low-power render loop while the overview is visible — paused when it isn't).
Tapping the globe opens the full-screen `#map` view (same globe instance grows
to fill the screen, or a fresh full instance) with arcs, heatmap, filters, and
click-through.

Mitigations for the standing cost:
- `globe.pauseAnimation()` whenever the overview is not the visible view
  (navigating into a trip, the map, onboarding, or the tab losing focus via
  `visibilitychange`).
- Low renderer settings on small screens (`powerPreference: 'low-power'`,
  `antialias:false` under ~480px width, capped `devicePixelRatio` at 1.5).
- `autoRotateSpeed` low (~0.35) so it's a slow drift, not a fast spin.
- The globe script + Earth texture are cached after first load; subsequent
  overview visits pay only the render-loop cost.
- If globe.gl fails to load or WebGL is unavailable → the overview shows the
  2D fallback (§3f) as a static strip, and the app is otherwise unaffected.

New view id `#map` (peer of `#login` / `#onboarding` / `#overview` / `#detail`).
`show('map')` added to the `show()` list. Back button → `routeToOverview()`.

### 3b. Library — DECIDED: vendored, not CDN

Vendor `globe.gl` (UMD build, three.js bundled in, ~150 KB min / ~45 KB gzip)
into **`vendor/globe.gl.min.js`**, committed to the repo. Referenced with a
local `<script>` injected on first need. Rationale: no external script
dependency, works offline (needed for the PWA on the roadmap), consistent with
the app's self-contained ethos, no CSP host to whitelist later. Cost accepted:
~150 KB in the repo, manual version bumps (rare, fine).

`scripts/update-globe.sh` — re-download the pinned version, commit.

### 3b-note. Weight budget

Lazy-loaded map assets (only fetched when a map surface first appears):
`vendor/globe.gl.min.js` ~45 KB gz, `data/world-110m.json` ~35 KB gz,
`data/airports.json` ~120 KB gz. ~200 KB gz total, none on the login/onboarding
path. globe.gl is on the *overview* path (see 3a) — the rest are deferred to
the Trip tab / Map view.

### 3c. Layers

| Layer | Data | Encoding |
|---|---|---|
| **Points** | every stay with coords, across all trips | size ∝ nights; colour by trip status (upcoming/ongoing/done) or a per-trip hue; label = city + trip name |
| **Arcs** | every transport leg with both ends resolved | colour by mode (flight = blue, bus = green, train = amber, car/ferry = grey); dashed animation along the arc; altitude ∝ great-circle distance |
| **Heatmap / rings** | stay coords weighted by nights | `globe.gl` hex-bin layer, or pulsing rings on the most-stayed cities |
| **Home marker** | `profiles.home_country` centroid (or home_place if resolved) | a distinct static marker |

### 3d. Interaction

- `globe.controls().autoRotate = true`, `autoRotateSpeed ≈ 0.3`. Pauses on
  pointer-down, resumes ~4 s after the last interaction.
- Scroll / pinch to zoom; drag to rotate.
- **Click a point** → `openTrip(tripId)`, then switch to the Stays tab and
  expand that stay's card (needs a `focusStay(id)` helper — scroll into view +
  add `.expanded` + open `.ic-details`).
- **Click an arc** → `openTrip(tripId)`, Transport tab, focus that leg.
- Hover → tooltip with the place/leg summary.
- A legend (mode colours, "size = nights") in a corner.
- Filter chips: All / Upcoming / Ongoing / Past — dims non-matching points/arcs.

### 3e. Performance

- Cap arcs shown at once (~300); if more, aggregate or require a filter.
- `rendererConfig: { antialias: true, powerPreference: 'low-power' }` on mobile.
- Pause the render loop (`globe.pauseAnimation()`) when `#map` isn't visible.
- Earth texture: use globe.gl's built-in night/day at medium res; don't ship a
  huge 8k texture.
- Lazy: nothing globe-related is parsed until `openMap()`.

### 3f. Fallback (no WebGL / script fails)

A flat equirectangular world image with absolutely-positioned dots
(lat/lng → x/y projection). Same click-through. Not pretty, but functional.

---

## 4. Per-trip mini-map

On the **Trip tab**, above the timeline: a static map image framed on the
trip's visited places.

### 4a. What "framed on visited places" means

- Collect all resolved coords for the trip: stay points + transport endpoints
  **that fall within the trip's bounding region**.
- Compute a bbox of those points, **excluding outliers** — specifically, drop a
  transport endpoint if it's > ~1500 km from the median of the other points
  (this removes the FRA end of a FRA→JFK flight when the trip is a US road
  trip). Keep at least the destination end of every leg.
- Pad the bbox ~15% and fit the image to it.

### 4b. Rendering options (pick one)

1. **Static tile snapshot** — a lightweight raster from a static-map provider.
   - **Geoapify Static Maps** (free tier 3k/day, no card) or **MapTiler**
     (free tier, needs key). Returns a PNG for a given bbox + markers +
     polyline. One `<img>`. Zero JS.
   - Needs an API key env var (`GEOAPIFY_KEY` / `MAPTILER_KEY`), same pattern.
2. **No-provider 2D canvas** — draw our own: a simplified country-outline
   GeoJSON (bundled, ~100 KB world-110m from Natural Earth) on a `<canvas>`,
   plot points + a route polyline. Full control, no key, no external calls,
   works offline. Slightly more code; looks clean in the app's dark theme.

**DECIDED: option 2** — bundled GeoJSON + `<canvas>`. No key, no external
calls, themes perfectly in dark, doubles as the globe's 2D fallback (§3f),
works offline. Neighbourhood detail isn't needed ("get where you are" is the
bar) so the lack of streets/labels is fine.

**Kept swappable:** all rendering lives in ONE function —
`renderTripMap(canvasOrImgEl, { points, legs, bbox })`. Switching to a
static-map provider later = rewrite only that function (build a URL, set an
`<img src>`) + add a key env var. ~1 hour, nothing else changes. The upstream
(geo resolution, bbox + outlier logic, which points to include) is
provider-agnostic.

### 4c. Interaction

- The mini-map is a button → opens the global Map view **pre-zoomed to this
  trip** (`openMap({ focusTripId })` → fly-to that trip's bbox, filter to it).
- Markers on the mini-map itself are not individually clickable (it's a
  picture); the whole thing is one tap target.

---

## 5. Form changes

Stay form and Transport form each get a **Location** section:

- Shows the currently resolved point(s) on a tiny inline map (the §4b canvas,
  ~140px) with the `geo_source` noted ("from address" / "airport FRA" /
  "city centre — approximate").
- **"Adjust"** → a slightly bigger map; tap to drop/move a pin →
  `lat/lng` + `geo_source = 'manual'`.
- For transport: two pins (origin, destination), each adjustable.
- Purely optional — leaving it alone uses automatic resolution.

---

## 6. Routing / plumbing

- `show()` list gains `'map'`.
- `openMap(opts?)`:
  - `show('map')`, lazy-load globe.gl if not loaded,
  - ensure geo backfill for the scope (`opts.focusTripId` → just that trip;
    else all trips),
  - build layers, start rotation,
  - if `opts.focusTripId` → `globe.pointOfView(bbox center, altitude)` + filter.
- `focusStay(stayId)` / `focusTransport(legId)` helpers on `window` for
  click-through (also reusable elsewhere).
- Map view has its own back button → `routeToOverview()`.

---

## 7. New / changed files

| File | Change |
|---|---|
| `schema.sql` | + lat/lng/geo_source columns on stays & transport (idempotent) |
| `data/airports.json` | new — IATA → coords, bundled |
| `data/world-110m.json` | new — country outlines for the canvas maps |
| `vendor/globe.gl.min.js` | new — vendored globe library (three.js bundled) |
| `scripts/update-airports.sh` | new — refetch OurAirports, filter, commit |
| `scripts/update-globe.sh` | new — re-download the pinned globe.gl build |
| `api/geocode.js` | new — Nominatim proxy, cached |
| `index.html` | `#map` view, globe widget on overview, mini-map on Trip tab, Location section in stay/transport forms, geo resolver logic, click-through helpers, lazy globe loader |
| `ROADMAP.md` | mark maps as in progress |
| `PRIVACY.md` | note: addresses are sent to Nominatim (OSM) for geocoding; results cached; no third party beyond OSM + the static-map/airport data which is local |

---

## 8. Build order (commits)

1. **Schema + geo resolver + `api/geocode.js`.** Columns, the client resolver,
   the proxy. Resolve-on-save wired. No UI yet. Verify rows get coords.
2. **Bundled data.** `airports.json`, `world-110m.json`, refresh scripts.
3. **Per-trip mini-map (canvas).** The §4b renderer, bbox+outlier logic, on the
   Trip tab. This proves the geo data and gives immediate value.
4. **Global globe — first slice.** `#map` view, lazy globe.gl, **stay points
   only**, auto-rotate, click point → `openTrip`. The overview globe widget.
5. **Arcs.** Transport legs as coloured arcs, click-through to the leg.
6. **Heatmap + home marker + filter chips + legend.**
7. **Location section in the forms** (manual pin override).
8. **Perf pass + 2D fallback + PRIVACY/ROADMAP updates.**

Each commit is independently deployable and testable.

---

## 9. Decisions (resolved)

- **Mini-map**: bundled canvas + `data/world-110m.json`, no key. Rendering
  isolated in `renderTripMap()` so a provider swap later is ~1 hour. ✅
- **Globe library**: vendored (`vendor/globe.gl.min.js`), not CDN. Offline-
  capable, no external script, no CSP host. ✅
- **Overview globe**: full live globe.gl instance on the overview, points only,
  slow auto-rotate, render loop paused when the overview isn't visible. Tap →
  full `#map` view. ✅

## 9b. Still-open / accept-as-is

- **Geocoding traffic.** Nominatim's free endpoint is rate-limited and
  usage-policy-bound. For personal single-user scale it's fine; if it ever grows
  we'd move to a keyed provider (Geoapify/MapTiler/LocationIQ) — the
  `api/geocode.js` swap is trivial.
