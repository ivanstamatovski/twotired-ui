-- announcements: in-app banner messages shown to riders.
--
-- Pattern: app fetches active rows on auth + subscribes to realtime inserts.
-- For each row that hasn't been dismissed locally (localStorage), the highest-
-- severity / newest one renders as a banner at the top of the screen.
--
-- `kind` controls visual treatment:
--   info       — blue, default. Feature releases, neutral updates.
--   warning    — yellow. Service degraded but still usable.
--   maintenance— amber. Scheduled downtime window.
--   critical   — red. Service-affecting now, AND non-dismissible.
--
-- `starts_at` + `ends_at` let you schedule and auto-expire announcements
-- without touching the DB again. `dismissible=false` overrides the X button —
-- use sparingly, only for critical notices the rider has to acknowledge.

create table if not exists public.announcements (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null
                  check (kind in ('info', 'warning', 'maintenance', 'critical')),
  title         text not null,
  body          text,
  url           text,                              -- optional "Learn more" link
  url_label     text default 'Learn more',
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,                       -- null = no expiry
  dismissible   boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Index on starts_at for the "newest first" query order. We can't include
-- a `where ends_at > now()` predicate because Postgres requires index
-- predicates to use only IMMUTABLE functions, and now() is STABLE. Not a
-- meaningful issue — this table will have at most a few dozen rows ever.
create index if not exists announcements_starts_at_idx
  on public.announcements (starts_at desc);

alter table public.announcements enable row level security;

-- Any authenticated rider can read announcements. We only ever show them
-- post-auth so this is the right boundary; if we later want pre-auth banners
-- (e.g., "service is down, you can't sign in right now") we'll add an
-- anonymous policy or move them to an edge function.
create policy "auth can read announcements"
  on public.announcements for select
  to authenticated using (true);

-- Writes go through the admin portal (service role only). No public write
-- policy — the admin's gated password flow + service role key is the trust
-- boundary.
