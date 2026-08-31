# TripSitter — Maps feature spec (E2E)

**Approach: Path A** — cheap CSS/SVG globe on the overview first; the full
3D globe.gl lives only in the dedicated `#map` view. The overview globe can be
upgraded to a live globe.gl instance later (~2 h, once §4's globe.gl view
exists) if the extra polish proves worth the standing cost — decision deferred
until you've seen the real globe running on your own phone.

Surfaces:

1. **Overview globe (CSS/SVG)** — a slowly-rotating stylised globe on the trips
   overview, visited countries highlighted. Decorative, ~near-zero cost, no
   library. Tapping it opens the full Map view.
2. **Full Map view (`#map`, globe.gl)** — full-screen interactive 3D globe:
   every trip's stays as points, transport legs as arcs, a heatmap of time
   spent, click a point/arc to jump to that entry.
3. **Per-trip mini-map (canvas)** — a small static map on each trip's Trip tab,
   framed on that trip's visited places (local hops, not the long-haul flight
   in). Rendered on a `<canvas>` from a bundled world-outline GeoJSON.

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
- **globe.gl loads lazily** — the vendored library, the airport table, and the
  world GeoJSON are fetched only when the `#map` view opens, never on the
  overview or login path. The overview globe uses no library at all.
- **The per-trip mini-map is a `<canvas>`** drawn from a bundled world-outline
  GeoJSON — cheap, instant, no rotation, no external calls, themes in dark.
- **The overview globe is CSS/SVG** — a sphere with a rotating Earth texture (or
  simplified continents) + highlighted visited-country regions. ~5–10 KB, one
  CSS animation.
- **All surfaces share** the same geo resolution code (§2) and the same
  click-through routing (`openTrip` + tab/card focus, §6).

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

## 3. Overview globe (CSS/SVG) + full Map view (globe.gl)

### 3a. Overview globe — DECIDED: CSS/SVG, no library (Path A)

A stylised rotating globe sits in a card at the top of the overview (~260px):

- An SVG `<circle>` for the sphere; the world drawn from `data/world-110m.json`
  land polygons projected orthographically onto the sphere, OR a single
  equirectangular Earth texture wrapped via CSS. Prefer the SVG-land approach —
  it themes to the app's dark palette and lets us tint visited countries.
- **Visited countries highlighted**: colour any country whose ISO-2 appears in
  a place tag across all trips (`overviewTrips.flatMap(t => t.country_codes)`).
- **Rotation**: one CSS `@keyframes` spinning the land group (or shifting the
  texture's longitude) — ~60 s per revolution, slow drift. `prefers-reduced-
  motion` → no spin.
- Cost: ~5–10 KB of code, one compositor-only CSS animation, negligible CPU/GPU.
  Loads on the overview with no penalty.
- The whole card is a button → `openMap()`.

**Upgrade path (deferred):** once §3c's globe.gl `#map` view exists, the
overview card can host a live globe.gl instance instead (~2 h swap:
`renderOverviewGlobe()` mounts a globe.gl canvas + a `pauseAnimation()` on
view-change). The CSS globe then becomes the reduced-motion / no-WebGL
fallback. Not built now — revisit after seeing the real globe on-device.

### 3b. `renderOverviewGlobe(container, { countryCodes })`

Single entry point for whatever the overview card contains. Called from
`renderOverview()`. Today: draws the SVG globe. Later: may mount globe.gl.
Nothing else in the overview knows or cares.

### 3c. Full Map view — `#map`, globe.gl

New view id `#map` (peer of `#login` / `#onboarding` / `#overview` /
`#detail`). `show('map')` added to the `show()` list. Its own back button →
`routeToOverview()`. `openMap(opts?)` (see §6) lazy-loads globe.gl on first use.

**Library — DECIDED: vendored, not CDN.** Vendor `globe.gl` (UMD build,
three.js bundled, ~150 KB min / ~45 KB gz) into **`vendor/globe.gl.min.js`**,
committed. Injected as a local `<script>` on first `openMap()`. Rationale: no
external script dependency, offline-capable (PWA on the roadmap), consistent
with the app's self-contained ethos, no CSP host to whitelist later.
`scripts/update-globe.sh` re-downloads the pinned version.

**Weight budget** — all deferred, none on the login/overview path:
`vendor/globe.gl.min.js` ~45 KB gz, `data/world-110m.json` ~35 KB gz,
`data/airports.json` ~120 KB gz. Fetched only when `#map` (globe.gl) or a
Trip tab (world GeoJSON) first appears.

**Perf** (globe.gl in `#map`):
- `globe.pauseAnimation()` when `#map` is not the visible view + on
  `visibilitychange`.
- `powerPreference: 'low-power'`, `antialias:false` under ~480px, `devicePixel
  Ratio` capped at 1.5.
- `autoRotateSpeed ≈ 0.35`; pauses on pointer-down, resumes ~4 s after.
- Cap arcs shown at once (~300); require a filter above that.
- WebGL unavailable / script fails → the 2D fallback (§3f).

### 3d. Layers (globe.gl `#map` view)

| Layer | Data | Encoding |
|---|---|---|
| **Points** | every stay with coords, across all trips | size ∝ nights; colour by trip status (upcoming/ongoing/done) or a per-trip hue; label = city + trip name |
| **Arcs** | every transport leg with both ends resolved | colour by mode (flight = blue, bus = green, train = amber, car/ferry = grey); dashed animation along the arc; altitude ∝ great-circle distance |
| **Heatmap / rings** | stay coords weighted by nights | `globe.gl` hex-bin layer, or pulsing rings on the most-stayed cities |
| **Home marker** | `profiles.home_country` centroid (or home_place if resolved) | a distinct static marker |

### 3e. Interaction (globe.gl `#map` view)

- `globe.controls().autoRotate = true`, `autoRotateSpeed ≈ 0.35`. Pauses on
  pointer-down, resumes ~4 s after the last interaction.
- Scroll / pinch to zoom; drag to rotate.
- **Click a point** → `openTrip(tripId)`, then Stays tab, `focusStay(stayId)`
  (scroll into view + add `.expanded` + open `.ic-details`).
- **Click an arc** → `openTrip(tripId)`, Transport tab, `focusTransport(legId)`.
- Hover → tooltip with the place/leg summary.
- A legend (mode colours, "size = nights") in a corner.
- Filter chips: All / Upcoming / Ongoing / Past — dims non-matching points/arcs.

### 3f. Fallback (no WebGL / globe.gl fails to load)

The `#map` view falls back to the **canvas world map** (§4b `renderTripMap`,
run in "all trips" mode) — a flat projection with dots for stays and lines for
legs. Same click-through. Not 3D, but fully functional. This reuses the
per-trip mini-map renderer at a world bbox.

---

## 4. Per-trip mini-map

On the **Trip tab**, above the timeline: a static canvas map framed on the
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
| `index.html` | `#map` view, CSS overview globe, mini-map on Trip tab, Location section in stay/transport forms, geo resolver logic, click-through helpers, lazy globe.gl loader |
| `ROADMAP.md` | mark maps as in progress |
| `PRIVACY.md` | note: addresses are sent to Nominatim (OSM) for geocoding; results cached; no third party beyond OSM. Airport + world-outline data is bundled/local. |

---

## 8. Build order (commits) — Path A

1. **Schema + `api/geocode.js` + geo resolver.** lat/lng/geo_source columns
   (stays + transport); Nominatim proxy; the client resolver (§2a); resolve-on-
   save wired into `stayForm` / `transportForm`. No UI. Verify rows get coords
   in the DB after adding/editing.
2. **Bundled data.** `data/airports.json` (OurAirports, IATA-only, ~5–6k rows),
   `data/world-110m.json` (Natural Earth land/countries), `scripts/update-
   airports.sh`. Airport lookup helper (`extractIATA`, `AIRPORTS[code]`).
3. **Per-trip mini-map (canvas).** `renderTripMap(el, {points, legs, bbox})` —
   orthographic/equirectangular projection of `world-110m` land + stay dots +
   leg polylines. bbox + outlier logic (§4a). Mounted above the timeline on the
   Trip tab. Backfill missing coords when the Trip tab opens. **Proves the geo
   data end to end.**
4. **CSS overview globe.** `renderOverviewGlobe(el, {countryCodes})` — SVG
   sphere, `world-110m` land projected on it, visited countries tinted, slow CSS
   rotation, `prefers-reduced-motion` respected. Card on the overview; tap →
   `openMap()` (stub for now).
5. **globe.gl `#map` view — first slice.** Vendor `globe.gl.min.js` +
   `scripts/update-globe.sh`. `#map` view + `show('map')` + back button.
   `openMap(opts?)` lazy-loads the script. **Stay points only**, auto-rotate,
   click point → `openTrip` + `focusStay`. `openMap({focusTripId})` flies to a
   trip's bbox.
6. **Arcs.** Transport legs as mode-coloured arcs in `#map`; click → `openTrip`
   + `focusTransport`. Per-trip mini-map gains the leg polylines (if not already
   from commit 3).
7. **Heatmap + home marker + filter chips + legend** in `#map`.
8. **Location section in the forms** (§5) — inline mini-map + manual pin
   override (`geo_source = 'manual'`).
9. **Perf pass + fallback wiring + PRIVACY/ROADMAP updates.** globe.gl pause on
   view-change + `visibilitychange`; WebGL-absent → canvas world map fallback in
   `#map`; renderer settings by screen size.

Each commit is independently deployable and testable. Commits 1–4 need no new
external dependency (Nominatim is a proxied API, already the pattern). globe.gl
enters at commit 5.

### Deferred (post Path A, optional)

- **Live globe.gl on the overview** — swap `renderOverviewGlobe` to mount a
  globe.gl instance instead of the SVG; CSS globe becomes the reduced-motion /
  no-WebGL fallback. ~2 h. Decide after using commit 5 on a real phone.

---

## 9. Decisions (resolved)

- **Mini-map**: bundled canvas + `data/world-110m.json`, no key. Rendering
  isolated in `renderTripMap()` so a provider swap later is ~1 hour. ✅
- **Globe library**: vendored (`vendor/globe.gl.min.js`), not CDN. Offline-
  capable, no external script, no CSP host. ✅
- **Overview globe**: **Path A** — CSS/SVG rotating globe first (no library,
  ~near-zero cost). Upgrade to a live globe.gl instance is deferred and
  isolated behind `renderOverviewGlobe()`; decide after commit 5. ✅
- **Sequencing**: build the geo layer + mini-map + CSS globe (commits 1–4,
  no globe.gl) before touching globe.gl at all (commit 5). This reaches
  "spinning globe on the overview" fast and defers the heavy/risky part until
  it can be judged on-device. ✅

## 9b. Still-open / accept-as-is

- **Geocoding traffic.** Nominatim's free endpoint is rate-limited and
  usage-policy-bound. For personal single-user scale it's fine; if it ever grows
  we'd move to a keyed provider (Geoapify/MapTiler/LocationIQ) — the
  `api/geocode.js` swap is trivial.
