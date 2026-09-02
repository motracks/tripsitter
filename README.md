# TripSitter

Multi-trip travel archive. Static `index.html` + Supabase backend + one Vercel
serverless function for ticket parsing.

## Setup

### 1. Supabase

Run `schema.sql` in the Supabase SQL editor. It is idempotent — safe to re-run,
**except** the seed `do $$ … $$;` block at the bottom, which inserts the original
HouseTrip data and would duplicate it on a second run.

Project must be in an EU region (it is). Under **Authentication → URL
Configuration**, set the Site URL and add a Redirect URL for your Vercel domain.

Turn **off** email confirmation (Authentication → Providers → Email) or create
users manually via Authentication → Users → Add user (Auto Confirm).

### 2. Vercel

- Framework preset: **Other**. Leave Build / Output / Install commands empty.
- No dependencies, no build step — `index.html` is served static, and
  `api/parse-ticket.js` uses only the built-in `fetch`.
- One optional env var (parsing is disabled without it, manual entry still works):
  - `GEMINI_API_KEY` — an AI Studio key (aistudio.google.com). Enables the
    "upload a ticket, auto-fill the fields" feature via `/api/parse-ticket`.
    See `PRIVACY.md`.
  - `GEONAMES_USERNAME` — a free geonames.org username with "Free Web
    Services" enabled on the account page. Enables destination autocomplete
    via `/api/geo-search`. Without it, destinations are free-text tags.

The Supabase URL and anon key are hardcoded in `index.html` — the anon key is
public by design; Row-Level Security is the actual protection.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app — login, trips overview, tabbed trip view, CRUD |
| `api/parse-ticket.js` | Vercel function: Gemini vision → structured travel fields |
| `api/geocode.js` | Vercel function: Nominatim geocoding proxy (no key), for the maps |
| `api/research-visa-options.js` | Manual research helper for `VISA_OPTIONS` in `index.html` — fetches a short hand-picked list of official visa pages and asks Gemini to draft duration/fee tiers for a human to verify and paste in. Not linked from the UI; hit `/api/research-visa-options` yourself (optionally `?cc=NP,TH`) every so often. Requires `GEMINI_API_KEY`. |
| `data/airports.json` | IATA → coords, bundled (OurAirports). `scripts/update-airports.sh` |
| `data/world-110m.json` | Country outlines for globe + mini-maps. `scripts/update-world-outline.sh` |
| `schema.sql` | Full schema, RLS, storage bucket, seed data |
| `PRIVACY.md` | What's stored, where it goes, how to erase |
| `HouseTrip_reference.html` | The original single-trip prototype, kept for reference |
