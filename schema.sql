-- TripSitter schema — multi-trip travel archive
-- Run in the Supabase SQL editor. Single-user, RLS scoped to auth.uid().

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists trips (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users,
  name        text not null,
  destination text,
  start_date  date,
  end_date    date,
  status        text default 'upcoming',      -- upcoming | active | past
  base_currency text default 'EUR',           -- currency the trip's totals roll up into
  created_at    timestamptz default now()
);
alter table trips add column if not exists base_currency text default 'EUR';

create table if not exists stays (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid references trips(id) on delete cascade,
  type       text,                          -- THS, hostel, hotel, airbnb
  city       text,
  start_date date,
  end_date   date,
  host_name  text,
  address    text,
  pets       text,
  price      numeric,   -- original amount in `currency` (0 / null for unpaid sits)
  currency   text default 'EUR',
  amount_base     numeric,   -- price converted into the trip's base_currency (cached)
  base_rate_date  date,      -- FX date used for that conversion
  notes      text
);
alter table stays add column if not exists price numeric;
alter table stays add column if not exists currency text default 'EUR';
alter table stays add column if not exists amount_base numeric;
alter table stays add column if not exists base_rate_date date;
-- Geo (maps feature): resolved coordinates of the stay, cached on the row.
alter table stays add column if not exists lat double precision;
alter table stays add column if not exists lng double precision;
alter table stays add column if not exists geo_source text;  -- 'address' | 'placetag' | 'city' | 'manual' | null

create table if not exists transport (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid references trips(id) on delete cascade,
  type         text,                        -- flight, bus, train
  origin       text,
  destination  text,
  departure    timestamptz,
  arrival      timestamptz,
  carrier      text,
  booking_code text,
  price        numeric,   -- original amount in `currency`
  currency     text default 'EUR',
  amount_base    numeric, -- price converted into the trip's base_currency (cached)
  base_rate_date date,
  notes        text
);
alter table transport add column if not exists currency text default 'EUR';
alter table transport add column if not exists amount_base numeric;
alter table transport add column if not exists base_rate_date date;
-- Geo (maps feature): resolved coordinates of both ends, cached on the row.
alter table transport add column if not exists origin_lat double precision;
alter table transport add column if not exists origin_lng double precision;
alter table transport add column if not exists dest_lat double precision;
alter table transport add column if not exists dest_lng double precision;
alter table transport add column if not exists geo_source text;  -- 'iata' | 'station' | 'city' | 'manual' | 'partial' | null
-- IANA timezone of each end (e.g. "Europe/Berlin"), resolved from its coords.
-- departure is always shown/interpreted in origin_tz, arrival in dest_tz —
-- never the viewer's own device timezone.
alter table transport add column if not exists origin_tz text;
alter table transport add column if not exists dest_tz text;
-- Train-only detail: service number and departure track/platform.
alter table transport add column if not exists train_number text;
alter table transport add column if not exists track_info text;

create table if not exists travel_docs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users,
  doc_type         text,                    -- ESTA, Global Entry, Visa
  country          text,
  status           text,
  expires_on       date,
  reference_number text,
  notes            text
);

-- For an approved Visa document, the stay length it actually grants — used
-- to override the static visa-free-days allowance shown on the entry tab
-- for that country (see computeVisa() in index.html).
alter table travel_docs add column if not exists max_stay_days integer;

-- A separate cumulative calendar-year cap some visas state (e.g. India's
-- e-Visa: 180 days per calendar year, on top of the 90-day per-entry limit
-- above). Used to total nights across ALL of a user's trips to that country
-- for the given year (see annualCapStatus() in index.html).
alter table travel_docs add column if not exists annual_cap_days integer;

-- Attachments (ticket / QR / doc scans) live in the private `tickets`
-- storage bucket; the row holds the object paths only. attachment_paths is
-- the current column (multiple images); attachment_path is the legacy
-- single-value column, still read as a fallback.
alter table stays       add column if not exists attachment_path text;
alter table transport   add column if not exists attachment_path text;
alter table travel_docs add column if not exists attachment_path text;
alter table stays       add column if not exists attachment_paths text[] default '{}';
alter table transport   add column if not exists attachment_paths text[] default '{}';
alter table travel_docs add column if not exists attachment_paths text[] default '{}';
-- migrate any existing single paths into the array
update stays       set attachment_paths = array[attachment_path] where attachment_path is not null and coalesce(array_length(attachment_paths,1),0) = 0;
update transport   set attachment_paths = array[attachment_path] where attachment_path is not null and coalesce(array_length(attachment_paths,1),0) = 0;
update travel_docs set attachment_paths = array[attachment_path] where attachment_path is not null and coalesce(array_length(attachment_paths,1),0) = 0;

-- qr_paths runs parallel to attachment_paths (same index = same source
-- image): each entry is either the object path of a cropped QR-code/barcode
-- image auto-detected at upload time, or null if none was found in that
-- attachment. Lets the attachment preview show just the scannable code,
-- full-size, instead of the whole ticket screenshot.
alter table stays       add column if not exists qr_paths text[] default '{}';
alter table transport   add column if not exists qr_paths text[] default '{}';
alter table travel_docs add column if not exists qr_paths text[] default '{}';

-- Trip membership — future-proofs multi-user. The trip owner is always a
-- member (see trigger below). `scope` is null for full-trip access, or a
-- json array of section keys later (e.g. ["stays","transport"]).
create table if not exists trip_members (
  trip_id    uuid references trips(id) on delete cascade,
  user_id    uuid references auth.users on delete cascade,
  role       text default 'editor',   -- owner | editor | viewer
  scope      jsonb,
  created_at timestamptz default now(),
  primary key (trip_id, user_id)
);

-- Owner auto-joins as a member on trip insert.
create or replace function add_owner_as_member() returns trigger as $$
begin
  insert into trip_members (trip_id, user_id, role)
  values (new.id, new.user_id, 'owner')
  on conflict do nothing;
  return new;
end $$ language plpgsql security definer;

drop trigger if exists trg_add_owner_member on trips;
create trigger trg_add_owner_member after insert on trips
  for each row execute function add_owner_as_member();

-- Backfill membership for trips that predate the trigger.
insert into trip_members (trip_id, user_id, role)
  select id, user_id, 'owner' from trips
  on conflict do nothing;

-- Helper: is the current user a member of this trip?
create or replace function is_trip_member(t uuid) returns boolean as $$
  select exists (
    select 1 from trip_members m
    where m.trip_id = t and m.user_id = auth.uid()
  );
$$ language sql stable security definer;

-- Same, but tolerates a text segment that may not be a uuid (storage paths).
create or replace function is_trip_member_seg(seg text) returns boolean as $$
declare tid uuid;
begin
  begin tid := seg::uuid; exception when others then return false; end;
  return is_trip_member(tid);
end $$ language plpgsql stable security definer;

-- ---------------------------------------------------------------------------
-- Row Level Security — trips/stays/transport gated on trip membership,
-- travel_docs personal to the user
-- ---------------------------------------------------------------------------

alter table trips        enable row level security;
alter table stays        enable row level security;
alter table transport    enable row level security;
alter table travel_docs  enable row level security;
alter table trip_members enable row level security;

drop policy if exists "own trips"        on trips;
drop policy if exists "own travel_docs"  on travel_docs;
drop policy if exists "own stays"        on stays;
drop policy if exists "own transport"    on transport;
drop policy if exists "member trips"     on trips;
drop policy if exists "member stays"     on stays;
drop policy if exists "member transport" on transport;
drop policy if exists "member trip_members" on trip_members;

-- Trips: visible to any member; only the owner may insert/delete, members edit.
create policy "member trips" on trips
  for all using (is_trip_member(id) or auth.uid() = user_id)
  with check (auth.uid() = user_id or is_trip_member(id));

-- Stays / transport: gated on trip membership.
create policy "member stays" on stays
  for all using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));

create policy "member transport" on transport
  for all using (is_trip_member(trip_id)) with check (is_trip_member(trip_id));

-- trip_members: a member can see the roster; the trip owner manages it.
create policy "member trip_members" on trip_members
  for all using (
    is_trip_member(trip_id)
  ) with check (
    auth.uid() = (select user_id from trips where trips.id = trip_members.trip_id)
  );

-- Travel docs stay personal to the user (span trips).
create policy "own travel_docs" on travel_docs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Storage — private bucket for ticket / QR / doc images
-- Object path convention: <trip_id>/<row_id>/<filename>  (docs: user/<user_id>/...)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
  values ('tickets', 'tickets', false)
  on conflict (id) do nothing;

drop policy if exists "tickets read"   on storage.objects;
drop policy if exists "tickets write"  on storage.objects;
drop policy if exists "tickets delete" on storage.objects;

-- A user can touch an object when the first path segment is a trip they are
-- a member of, or the literal 'user' followed by their own uid (travel docs).
create policy "tickets read" on storage.objects for select using (
  bucket_id = 'tickets' and (
    is_trip_member_seg((storage.foldername(name))[1])
    or ((storage.foldername(name))[1] = 'user' and (storage.foldername(name))[2] = auth.uid()::text)
  )
);
create policy "tickets write" on storage.objects for insert with check (
  bucket_id = 'tickets' and (
    is_trip_member_seg((storage.foldername(name))[1])
    or ((storage.foldername(name))[1] = 'user' and (storage.foldername(name))[2] = auth.uid()::text)
  )
);
create policy "tickets delete" on storage.objects for delete using (
  bucket_id = 'tickets' and (
    is_trip_member_seg((storage.foldername(name))[1])
    or ((storage.foldername(name))[1] = 'user' and (storage.foldername(name))[2] = auth.uid()::text)
  )
);

-- ---------------------------------------------------------------------------
-- Seed migration — the trip hardcoded in the original HouseTrip.html
-- Run this block AFTER you have signed up / logged in at least once so that
-- auth.users has your row. It attributes everything to the single user.
-- ---------------------------------------------------------------------------

do $$
declare
  uid uuid := (select id from auth.users order by created_at limit 1);
  tid uuid;
begin
  if uid is null then
    raise notice 'No auth user yet — sign up first, then re-run the seed block.';
    return;
  end if;

  insert into trips (user_id, name, destination, start_date, end_date, status, base_currency)
  values (uid, 'HouseTrip · USA', 'USA', '2026-04-23', '2026-06-01', 'upcoming', 'EUR')
  returning id into tid;

  insert into stays (trip_id, type, city, start_date, end_date, host_name, address, pets, price, currency, notes) values
    (tid, 'hostel', 'Chicago, IL',      '2026-04-24', '2026-04-25', null,   '24 E Ida B Wells Dr, Chicago IL 60605',      null,                         57.06, 'USD', 'HI Chicago · Confirmation #16263020 · Men''s 10-Bed Dorm · check-in after 4pm, out by 11am'),
    (tid, 'THS',    'Chicago, IL',      '2026-04-25', '2026-05-05', 'Kara', '215 E Chestnut St, Apt 204, Chicago IL 60611', 'Dogs: Apolo & Berkeley',    0, 'USD', '10 nights · TrustedHousesitters · walk 60 mins total'),
    (tid, 'THS',    'Brooklyn, NY',     '2026-05-06', '2026-05-21', 'Jared', null,                                        'Dogs: Bruce & Remi',        0, 'USD', '15 nights · TrustedHousesitters · walk 30 mins'),
    (tid, 'THS',    'Washington, D.C.', '2026-05-22', '2026-05-25', 'Lia',  null,                                         'Dogs: Bartleby & Oswald; Cats: Reggie & Sammy', 0, 'USD', '3 nights · TrustedHousesitters · no walk needed'),
    (tid, 'THS',    'New York City, NY','2026-05-25', '2026-05-31', 'Laura', '156 W 120th St, Garden Level, New York NY 10027', 'Dogs: Kate & Prudence',  0, 'USD', '6 nights · TrustedHousesitters · walk 60 mins');

  insert into transport (trip_id, type, origin, destination, departure, arrival, carrier, booking_code, price, currency, notes) values
    (tid, 'flight', 'Frankfurt (FRA)',        'New York (JFK)',       '2026-04-23 11:50', '2026-04-23 14:36', 'KLM / Delta A330-200', 'XGTGX2',        573.48, 'EUR', 'KL6107 · boarding 10:55 · seat 33F class V · zone 7 · 9h 46m · price is return'),
    (tid, 'bus',    'New York (31st & 8th)',  'Chicago Bus Station',  '2026-04-23 21:30', '2026-04-24 13:25', 'FlixBus N2641',        '334 771 1876',  77.78,  'EUR', 'Seat 8B · 15h 55m · 1x carry-on + 1x checked 20kg'),
    (tid, 'flight', 'Chicago (ORD)',          'New York (LGA)',       '2026-05-06 08:55', '2026-05-06 12:11', 'American Airlines',    '0012340142179', 202.20, 'USD', 'AA2079 · economy (B) · 3h 16m'),
    (tid, 'bus',    'New York (Port Authority)', 'Washington Union Station', '2026-05-22 02:30', '2026-05-22 08:15', 'FlixBus / Greyhound US0670', '335 687 1749', 64.17, 'EUR', 'Seat 3D · 5h 45m'),
    (tid, 'bus',    'Bethesda, MD',           'New York (Midtown)',   '2026-05-25 08:35', '2026-05-25 12:45', 'FlixBus 2601',         '335 687 1749',  null,   'EUR', 'Seat 14C · 4h 10m'),
    (tid, 'flight', 'New York (JFK)',         'Frankfurt (FRA)',      '2026-05-31 18:29', '2026-06-01 08:40', 'KLM / Delta A330-200', 'XGTGX2',        150.00, 'EUR', 'KL6106 · 8h 11m · price shown is change fee'),
    (tid, 'train',  'Frankfurt Airport (Fernbf)', 'München Hbf',      '2026-06-01 09:41', '2026-06-01 13:12', 'ICE 529',              null,            40.49,  'EUR', '2nd class · 3h 31m');

  insert into travel_docs (user_id, doc_type, country, status, expires_on, reference_number, notes) values
    (uid, 'ESTA',         'USA', 'Authorization Approved', '2026-12-16', null,         'Max stay 90 days per entry'),
    (uid, 'Global Entry', 'USA', 'Active',                 '2030-03-02', '161514529',  'CBP Trusted Traveler · Known Traveler No. · TSA PreCheck included');
end $$;
