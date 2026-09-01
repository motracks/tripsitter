# TripSitter — roadmap

Ideas parked for later. Nothing here is committed to; it's a memory aid.

## Shipped

- Auth + onboarding (profile: home, currency, language, passports, permissions) + settings screen
- Trips overview — grouped Ongoing / Upcoming / Past, collapsible, date-driven status
- **Search & filter** across all trips (name, destination, place tags, hosts, carriers, notes)
- **Day count** on overview cards (alongside the date range)
- CRUD for trips / stays / transport / travel docs; inline edit on every card
- Destination tags via GeoNames autocomplete → flag pills, drives currency + visa
- Currency: full ISO list, trip currencies floated to top with readable names, dated FX
  conversion via `/api/fx`, per-tab totals with picker
- Visa panel: computed requirements from the passport-index dataset, per-country
  guidance, ~50 official portal deep links, day-limit bars; replaced the ESTA badge
- Timeline with layover connectors (< 24h between transport legs)
- Ticket parsing (Gemini vision): multi-image, browser downscale, auto-fills fields
  incl. purpose; images discarded by default (kept for transport)
- Attachments: multiple per row, thumbnail gallery, signed URLs
- **Approved-visa override**: an approved Visa document (with its own allowed-stay
  days, and an optional calendar-year cap like India's 180/yr) overrides the
  static visa-free lookup on the entry tab, auto-filled from the scanned
  document where stated
- **Schengen 90/180 rule**: rolling 180-day window, summed across every trip
  tagged with a Schengen-bloc country (not just the open one), shown on the
  entry tab whenever a trip touches the bloc
- **Passport expiry warning**: inline badge on a Passport document when it
  expires within 6 months (or already has), since many countries require
  onward validity beyond the travel dates

## Next up — the map / globe  ← IN PROGRESS

Full E2E plan: **`SPEC-maps.md`**. Approach settled (Path A):
CSS/SVG rotating globe on the overview first; full 3D globe.gl only in a
dedicated `#map` view; per-trip canvas mini-map on each Trip tab. 9 commits,
detailed in the spec. The `## Globe — feasibility` notes below are superseded
by SPEC-maps.md but kept for context.

## Backlog

| Idea | Notes | Rough effort |
|---|---|---|
| **Trip export** | PDF itinerary and/or a read-only shareable link (`/t/<token>`). Link needs a public RLS policy on a share token, or a serverless renderer. | Medium |
| **Cost analytics** | Spend by category / country / month / year. Charts. Uses data already in the app. | Small–Medium |
| **Multi-user sharing** | `trip_members` schema is already in place. Needs: invite-by-email UI, a members list per trip, role handling (owner/editor/viewer), and `travel_docs` staying private. | Medium |
| **PWA / offline** | Installable, service worker caching the shell + last-loaded trip data, so it works on a plane. | Medium |
| **Full-screen QR view** | Tap a stored boarding-pass image → full-bleed QR for gate scanning, max brightness. | Small |
| **Recurring / template trips** | "Same as last year" — clone a trip with dates shifted. | Small |
| **Notifications** | Push/email versions of the expiry warnings that are currently only shown inline (passport, ESTA, visa-doc); check-in windows. Needs a scheduled function + email or push. | Medium |
| **Global per-country annual-cap dataset** | Right now a calendar-year cap (e.g. India's 180/yr) only shows up if the user's own uploaded visa document states one — deliberately not hardcoded per-country, since a global "who caps what, how, and when it resets" table for 190+ countries isn't something we can keep truthful. Worth revisiting if it turns out to matter for countries people don't upload a visa doc for. | Large, and honestly might not be worth the accuracy risk |
| **Tax-residency day counter (183-day rule)** | The thing that actually bites digital nomads — not overstay, but accidentally tripping tax residency. Every country counts differently (calendar year vs. rolling 12mo, physical-presence tests, treaty tie-breakers), so this should be a passive "you've spent N days in country X this year" counter with a strong disclaimer, never a computed verdict. Real legal-liability surface — think carefully before building. | Medium, high care needed |
| **Refresh visa data** | Dataset is from Feb 2026. Run `scripts/update-visa-data.sh` every few months and commit. | Trivial, manual |
| **iCal export / import** | Subscribe to a trip as a calendar; import flights from a `.ics`. | Small–Medium |
| **Per-stay / per-leg map preview** | Small static map thumbnail on each card (needs a tile source or static-map API). | Small |

---

## Globe — feasibility

**Verdict: feasible, not a wet dream.** A slowly-rotating 3D globe, with your
trips as points and your transport legs as arcs between them, clickable through
to the underlying data entry — all of that is doable in a single static page
with no backend beyond what already exists.

### What it takes

- **Rendering**: `three.js` + a globe helper. The cleanest option is
  **`globe.gl`** (wraps three.js, has points / arcs / rings / heatmap layers,
  auto-rotation, click handlers, zoom-to-point out of the box). One script,
  ~150 KB. Or `react-globe.gl` if we ever move to a framework. Pure three.js is
  also fine but more code.
- **Data**: every place tag already carries a `geonameId`; GeoNames gives us
  lat/long. We'd store `lat` / `lng` on the place tag at tag time (one extra
  field in `geo-search.js`), or resolve on demand and cache. Transport rows have
  `origin` / `destination` text — we'd geocode those the same way (or let the
  user pin them).
- **The "web" of travel**: arcs from each transport leg's origin → destination,
  coloured by mode (flight / bus / train), animated dash along the arc. This is
  a built-in `globe.gl` layer (`arcsData`).
- **Heatmap of where you've been**: `globe.gl` has a hex-bin / heatmap layer;
  feed it every stay location weighted by nights. Or simpler: point size / glow
  by total time spent.
- **Rotation**: `globe.controls().autoRotate = true` — one line. Stops on
  interaction, resumes after idle.
- **Click-through**: `onPointClick` / `onArcClick` → we know which stay or
  transport row it is → route into the app (`openTrip(tripId)` then switch to
  the right tab / expand the right card). All the plumbing for that already
  exists.
- **Zoom / extend**: `globe.pointOfView({ lat, lng, altitude }, ms)` animates a
  fly-to. Clicking a cluster zooms in; scroll zooms.

### The honest caveats

- **Geocoding coverage**: free-text origins like "Bethesda, MD" or
  "31st & 8th Ave" geocode fine; vague ones ("my flat") won't. Need a manual
  "drop a pin" fallback in the transport/stay form.
- **Mobile performance**: three.js on a globe is fine on modern phones but not
  free — keep the texture resolution sane, cap the arc count, pause the render
  loop when the globe isn't visible.
- **Bundle size**: adds ~150–200 KB. Load it lazily — only when the user opens
  the Map tab, never on the critical path.
- **It's a real feature, not an afternoon.** Rough shape: (1) add lat/lng to
  place tags + a geocode step for transport endpoints, (2) a new full-screen
  "Map" view with the globe, (3) points + arcs + rotation, (4) click-through
  wiring, (5) heatmap layer, (6) mobile perf pass. Several commits.

### Suggested first slice

A static globe with just **stay points** (from place tags we already have
coords for or can resolve), auto-rotating, click a point → open that trip.
Ship that, then layer arcs and heatmap on top. Gets the "wow" on screen fast
without the geocoding-everything problem up front.
