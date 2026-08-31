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
- The one required env var (optional — parsing is disabled without it):
  - `ANTHROPIC_API_KEY` — enables the "upload a ticket, auto-fill the fields"
    feature via `/api/parse-ticket`. ~cents per parse. See `PRIVACY.md`.
- `npm install` runs automatically because `package.json` exists (only the
  Anthropic SDK, used by the API route).

The Supabase URL and anon key are hardcoded in `index.html` — the anon key is
public by design; Row-Level Security is the actual protection.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole app — login, trips overview, tabbed trip view, CRUD |
| `api/parse-ticket.js` | Vercel function: Claude vision → structured travel fields |
| `schema.sql` | Full schema, RLS, storage bucket, seed data |
| `PRIVACY.md` | What's stored, where it goes, how to erase |
| `HouseTrip_reference.html` | The original single-trip prototype, kept for reference |
