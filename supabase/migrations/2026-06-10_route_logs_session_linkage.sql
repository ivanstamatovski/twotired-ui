-- Link route_logs to nav_events.
--
-- Until now, every edge function call produced a route_logs row with no
-- way to correlate it back to the navigation session that triggered it.
-- A reroute in nav_events and the corresponding generate-route call in
-- route_logs could only be matched by timestamp + user_lat/lng, which is
-- brittle and breaks the unified ride-detail view in the admin portal.
--
-- nav_session_id mirrors the column on nav_events. event_origin records
-- which client-side flow produced the call:
--   initial_query  — fresh user prompt (voice or text)
--   refine         — refine flow (had an intent, modifying it)
--   reroute        — auto-reroute from rerouteFromCurrentPosition

alter table public.route_logs add column if not exists nav_session_id uuid;
alter table public.route_logs add column if not exists event_origin   text;

create index if not exists route_logs_nav_session_id_idx
  on public.route_logs (nav_session_id)
  where nav_session_id is not null;
