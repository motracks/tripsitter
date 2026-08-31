# TripSitter — data & privacy notes

Personal travel archive. Single controller (the account owner). This file
records what is stored, where it goes, and how to erase it — the discipline
that keeps the project GDPR-conformant if it ever grows beyond one user.

## What is stored

| Data | Where | Notes |
|---|---|---|
| Trips, stays, transport, travel documents | Supabase Postgres (EU region) | Row-Level Security scopes every row to its owner / trip members |
| Uploaded ticket / QR / document images | Supabase Storage, private `tickets` bucket | Only kept when "keep the image" is ticked on upload. Served via short-lived signed URLs, never public |
| Auth (email + password hash) | Supabase Auth (EU region) | Managed by Supabase |
| FX rates | fetched from frankfurter.app (ECB data), cached in-row | No personal data sent |

## The ticket parser (`/api/parse-ticket`)

- Runs as a Vercel serverless function. Needs `GEMINI_API_KEY` (an AI Studio
  key) set in Vercel env vars; if unset, the feature is simply disabled and
  manual entry still works.
- The uploaded image is held **in memory for one request only** — never written
  to disk, never logged.
- Sent to the Google Gemini API for field extraction. Note: Google's free /
  consumer AI Studio tier may use submitted data to improve their products; a
  paid API tier does not. Use a paid-tier key if that matters to you.
- The prompt asks the model to extract travel logistics **only** — route, times,
  carrier, booking code, price. It is instructed **not** to extract passenger
  name, passport number, date of birth, or frequent-flyer number even when
  visible, and the function strips any `name` / `passenger` key from the result.

## Data minimisation

- Images are parse-and-discard by default. They are only persisted when the user
  explicitly opts in per upload (default ON for transport, where the QR is
  needed at the gate; default OFF for stays and documents).

## Right to erasure

- Deleting a stay / transport / document row also deletes its stored image.
- Deleting a trip cascades to all its stays and transport rows and removes their
  images from storage.
- Deleting the Supabase Auth user removes everything owned by that user.

## If multi-user is enabled later

- `trip_members` already gates visibility: trip data is only visible to users
  explicitly added to that trip. Before storing a document that names another
  person, get their consent.
