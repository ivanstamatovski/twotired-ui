-- learned_corrections: human-reviewed routing rules produced by the bug-report
-- pipeline. Replaces learned_areas (polygon-only) with a discriminated table
-- that supports multiple rule shapes — polygons were too coarse for road
-- networks (they couldn't distinguish "avoid Manhattan grid" from "don't
-- transit Manhattan on highways" from "don't use Holland Tunnel").
--
-- rule_kind discriminator + rule_data jsonb lets each rule shape live in one
-- table. Shape per rule_kind (validated in the edge function, not the DB):
--
--   'escape_waypoint' — "from this origin region heading this direction,
--                        force routing through this waypoint."
--     {
--       "origin_bbox": [lon_sw, lat_sw, lon_ne, lat_ne],
--       "bearing_min": 270,                       -- inclusive, degrees 0–360
--       "bearing_max": 360,                       -- inclusive, wraps if max < min
--       "destination_bbox": null,                 -- optional second filter
--       "forced_waypoint": { "lat": 40.7770, "lng": -73.9240, "name": "..." }
--     }
--
--   'edge_penalty'    — "penalise / prefer these OSM ways."
--     {
--       "osm_way_ids": [123456, 789012],
--       "multiply_by": 0.05
--     }
--     Requires Molly's GH config to expose `osm_way_id` in graph.encoded_values.
--
--   'banned_crossing' — "if the merged route uses this edge, reject and
--                        retry with it excluded." Post-route check, not a
--                        custom_model rule.
--     {
--       "osm_way_id": 123456,
--       "from_bbox": [lon_sw, lat_sw, lon_ne, lat_ne],     -- optional directionality
--       "to_bbox":   null
--     }
--
--   'area_penalty'    — legacy polygon avoidance. Use only when no narrower
--                        rule fits (rare).
--     {
--       "geometry":          { GeoJSON Polygon },
--       "multiply_by":       0.05,
--       "road_class_filter": "surface_only"   -- 'all' | 'surface_only' | 'highways_only'
--     }

drop table if exists public.learned_areas;

create table if not exists public.learned_corrections (
  id                 uuid primary key default gen_random_uuid(),
  key                text not null unique check (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  name               text not null,
  description        text,
  rule_kind          text not null check (rule_kind in (
                       'escape_waypoint', 'edge_penalty', 'banned_crossing', 'area_penalty'
                     )),
  rule_data          jsonb not null,
  applies_to         text[] not null default array['motorcycle','car','twotired'],
  active             boolean not null default true,
  source_report_id   uuid references public.bug_reports(id) on delete set null,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists learned_corrections_active_kind_idx
  on public.learned_corrections (rule_kind) where active;

alter table public.learned_corrections enable row level security;

create policy "auth can read"
  on public.learned_corrections for select
  to authenticated using (true);

-- Writes are done by the admin portal via service-role; no public write policies.
