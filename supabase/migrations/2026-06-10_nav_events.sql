-- nav_events: per-rider navigation telemetry for understanding what happens
-- during real test rides (especially around off-route + reroute behavior).
--
-- Each row is one event in a nav session. session_id groups events within a
-- single Navigate→Stop arc so they can be replayed end-to-end. Schema is
-- deliberately wide-but-sparse: most events fill in a subset of columns and
-- stuff anything else into metadata jsonb.
--
-- Event types currently emitted:
--   nav_start          — user tapped Navigate; metadata: {route_title, distance_mi, drive_minutes}
--   off_route          — rider drifted past threshold; metadata: {dist_off_route_m}
--   reroute_request    — about to call generateRoute; metadata: {destination}
--   reroute_complete   — server returned; metadata: {changed, new_first_lat, new_first_lng, dist_from_rider_m, raw_gh_minutes, drive_minutes}
--   reroute_failed     — request errored or got no destination; metadata: {error}
--   nav_arrive         — within arrival threshold of destination
--   nav_stop           — user tapped Stop; metadata: {reason}

create table if not exists public.nav_events (
  id            bigserial primary key,
  user_id       uuid references auth.users(id) on delete set null,
  session_id    uuid not null,                -- groups events within one nav arc
  route_id      text,                         -- references routes.id when known
  event_type    text not null,
  lat           double precision,
  lng           double precision,
  speed_mps     double precision,             -- from pos.coords.speed when available
  heading       double precision,             -- from pos.coords.heading when available
  metadata      jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists nav_events_user_id_idx
  on public.nav_events (user_id, created_at desc);
create index if not exists nav_events_session_id_idx
  on public.nav_events (session_id, created_at);
create index if not exists nav_events_event_type_idx
  on public.nav_events (event_type, created_at desc);

alter table public.nav_events enable row level security;

-- Riders insert their own events (client writes directly via the Supabase JS
-- client, no edge function in the way — keeps the firehose latency low).
create policy "users insert own nav events"
  on public.nav_events for insert
  to authenticated
  with check (user_id = auth.uid());

-- Riders read their own events. Admin portal accesses with service role.
create policy "users read own nav events"
  on public.nav_events for select
  to authenticated
  using (user_id = auth.uid());
