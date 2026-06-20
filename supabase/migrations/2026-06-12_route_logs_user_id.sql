-- route_logs.user_id — persist the rider for planning-only sessions.
--
-- Until now, route_logs.user_id didn't exist. The admin Rides view sourced
-- user_id from nav_events for navigated sessions; planning-only sessions
-- (route generated but Navigate never tapped) showed "—" because there was
-- no nav_events row to look at. Adding the column + populating it from
-- body.user_id in the edge function (v2.70) closes that gap.

alter table public.route_logs add column if not exists user_id uuid
  references auth.users(id) on delete set null;

create index if not exists route_logs_user_id_idx
  on public.route_logs (user_id)
  where user_id is not null;

-- ── Backfill existing rows from nav_events (one-time) ───────────────────────
-- For every route_logs row tied to a nav_session_id whose nav_events have a
-- user_id, copy that user_id over. Safe to re-run.
update route_logs rl
set user_id = ne.user_id
from (
  select distinct on (session_id) session_id, user_id
  from nav_events
  where user_id is not null
  order by session_id, created_at
) ne
where rl.nav_session_id = ne.session_id
  and rl.user_id is null;
