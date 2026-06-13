-- public.tasks — backlog / work-tracking table backing the admin Tasks panel.
--
-- Read by Claude at session start to surface "what should we work on?", and
-- by the admin Kanban/list view. Writes happen via:
--   - Admin UI (service role from the admin portal)
--   - Claude during sessions ("add a task to ...")
--   - Manual SQL when bulk-editing
--
-- Status flow: inbox → todo → in_progress → done
--                                      └─ blocked  (until unblocker resolves)
--                                      └─ wontdo   (terminal, no resurrection)

create table if not exists public.tasks (
  id              uuid primary key default gen_random_uuid(),
  title           text not null,
  description     text,
  status          text not null default 'inbox'
                  check (status in ('inbox', 'todo', 'in_progress', 'blocked', 'done', 'wontdo')),
  priority        text check (priority in ('p0', 'p1', 'p2', 'p3')),
  category        text,                              -- 'feature' | 'bug' | 'infra' | 'ops' | 'paperwork'
  notes           text,
  blocked_by      text,                              -- free-form: "Waiting on Twilio 10DLC review"
  linked_memory   text[],                            -- ['project_future_sms_signup']
  linked_files    text[],                            -- ['supabase/functions/.../index.ts']
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  done_at         timestamptz,
  created_by      uuid references auth.users(id) on delete set null
);

create index if not exists tasks_status_idx     on public.tasks (status);
create index if not exists tasks_priority_idx   on public.tasks (priority) where priority is not null;
create index if not exists tasks_updated_at_idx on public.tasks (updated_at desc);

-- Auto-update updated_at on any change.
create or replace function public.tasks_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  if new.status = 'done' and (old.status is null or old.status <> 'done') then
    new.done_at = now();
  elsif new.status <> 'done' and old.done_at is not null then
    new.done_at = null;
  end if;
  return new;
end $$;

drop trigger if exists tasks_set_updated_at on public.tasks;
create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.tasks_set_updated_at();

alter table public.tasks enable row level security;

-- Read: any authenticated user (the admin portal uses service role anyway,
-- but in case we ever expose this to the rider-facing app, scope it down).
create policy "tasks read" on public.tasks
  for select to authenticated using (true);

-- Writes: service role only (admin portal). No public write policy.

-- ── Seed: items currently in project_backlog_priorities.md ───────────────────
insert into public.tasks (title, description, status, priority, category, linked_memory) values
  (
    'Verify v2.66 NYC polygon fix',
    'Test: Bloomfield → Pearl River should route directly north (no GWB detour). Also test Astoria → Bear Mountain still triggers two-phase escape.',
    'todo', 'p1', 'ops',
    array['project_stable_checkpoint_2026_06_10']
  ),
  (
    'Log GraphHopper request bodies',
    'DONE 2026-06-12: v2.67 ships per-leg gh_request capture + admin Route Debug rendering.',
    'done', 'p1', 'feature',
    array['project_backlog_priorities']
  ),
  (
    'Consolidate admin route tabs (Routes / Route Debug / Ride Logs → one)',
    'Unify into "Rides" with progressive disclosure: sessions list → ride detail → expandable pipeline calls → trace. Saved routes and orphan pipeline calls become filter views.',
    'todo', 'p2', 'feature',
    array['project_stable_checkpoint_2026_06_10']
  ),
  (
    'Move routing polygons (NYC, Palisades) to Supabase',
    'Single source of truth so Molly''s GH config and the edge function read the same shape.',
    'todo', 'p2', 'infra',
    array['project_future_routing_polygons_supabase','feedback_nyc_polygon_dual_source']
  ),
  (
    'TestFlight 1.8 upload',
    '1.7 train is closed by App Store Connect. Bump to 1.8 in Xcode, re-archive, re-upload.',
    'in_progress', 'p1', 'paperwork',
    null
  ),
  (
    'Cloudflare Tunnel migration',
    'Replace Tailscale Funnel — funnel session-staleness bit us 2026-06-10. Cloudflare Tunnel + cloudflared daemon is free + more battle-tested. ~30 min migration.',
    'todo', 'p2', 'infra',
    array['project_backlog_priorities']
  ),
  (
    'Cloud GH standby on Hetzner',
    'Real redundancy. Edge function tries Molly first, falls back to cloud on fetchGHWithRetry failure. ~$6/mo. Doubles as green half of blue-green tuning.',
    'todo', 'p3', 'infra',
    array['project_future_blue_green_graphhopper']
  ),
  (
    'Score server (port 8765) back up',
    'Down since at least 2026-06-09. Routes fall back gracefully but lose joy/transit area weights. Install as systemd, enable on boot.',
    'todo', 'p2', 'ops',
    null
  ),
  (
    'App Store full release',
    'Half day of paperwork + two code blockers. Deferred until after TestFlight beta.',
    'todo', 'p3', 'paperwork',
    array['project_future_appstore_release']
  ),
  (
    'Push notifications',
    'APNs + Capacitor plugin work. ~half day.',
    'todo', 'p3', 'feature',
    array['project_future_push_notifications']
  ),
  (
    'SMS OTP signup via Twilio',
    'Phone signup alongside email for lower friction. Half day of code + 3-7 days of A2P 10DLC paperwork. ~$10/mo floor + ~$0.008/SMS.',
    'todo', 'p3', 'feature',
    array['project_future_sms_signup']
  ),
  (
    'Tasks Kanban with drag-drop',
    'Upgrade the read-only Tasks panel to a Kanban with drag-between-columns, +Add buttons, side drawer for editing. ~3 hours.',
    'todo', 'p2', 'feature',
    null
  );
