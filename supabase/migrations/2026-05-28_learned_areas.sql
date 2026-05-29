-- learned_areas: polygons that the routing pipeline should bias away from
-- (or toward), produced by the human-reviewed bug-report → lesson pipeline.
--
-- Lifecycle:
--   1. User reports a bug ("don't go through the city")
--   2. Admin opens the report in admin.twotired.net, draws a polygon on the
--      map, gives it a name + penalty
--   3. Row is inserted here with active=true, linked to the source bug report
--   4. generate-route fetches all active=true rows on every route generation
--      and synthesises them into GraphHopper's custom_model:
--        custom_model.areas      ← FeatureCollection of all the polygons
--        custom_model.priority   ← one `if: in_<key>` rule per area with the
--                                  saved multiply_by value
--
-- Notes:
--   - geometry is GeoJSON Polygon (single ring or multi-polygon both fine
--     because we store as-is and pass through to GraphHopper)
--   - multiply_by < 1.0 = avoid (e.g. 0.05 = treat ~20× less attractive)
--   - multiply_by > 1.0 = prefer (rarely needed, but supported)
--   - key is the identifier GraphHopper uses (must match `in_<key>`); we
--     enforce lowercase letters/digits/underscores so it's always valid

create table if not exists public.learned_areas (
  id                 uuid primary key default gen_random_uuid(),
  key                text not null unique check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  name               text not null,                    -- human-readable label
  description        text,                             -- why it exists / what it solves
  geometry           jsonb not null,                   -- GeoJSON Polygon / MultiPolygon
  multiply_by        double precision not null default 0.05 check (multiply_by > 0 and multiply_by <= 100),
  applies_to         text[] not null default array['motorcycle','car','twotired'],  -- which profiles
  active             boolean not null default true,
  source_report_id   uuid references public.bug_reports(id) on delete set null,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists learned_areas_active_idx on public.learned_areas(active) where active;

alter table public.learned_areas enable row level security;

-- Read access for anyone authenticated — the edge function uses service role
-- but a logged-in admin viewing the table should be able to see it.
create policy "auth can read"
  on public.learned_areas for select
  to authenticated using (true);

-- Writes go through the admin portal (service-role), so no public write
-- policies. The portal already authenticates via its admin password gate.
