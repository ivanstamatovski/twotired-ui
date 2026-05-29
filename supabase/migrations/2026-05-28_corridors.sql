-- corridors: named scenic-road preferences that bias GH onto specific corridors
-- (9W, NY-97, NY-28, etc.) without forcing the route through specific waypoints.
--
-- Replaces the in-code NINE_W_CORRIDOR_AREA / NY97_CORRIDOR_AREA / NY28_CORRIDOR_AREA
-- constants and the `if (corridor === '9W') { ... }` branches in buildCorridorModel.
-- Same routing behaviour, but data-driven so corridors can be added/edited without
-- redeploying the edge function.
--
-- `kind` discriminator supports today's polygon corridors and the planned
-- OSM-way-id corridors. Switching a corridor to kind='way_ids' requires Molly's
-- graphhopper.yml to expose osm_way_id in graph.encoded_values and a graph
-- rebuild — until then, kind='polygon' is the working format.
--
-- Config shapes:
--
--   kind='polygon'
--     {
--       "geometry":              { GeoJSON Polygon defining the corridor area },
--       "global_road_classes":   { "MOTORWAY": 0.1, "RESIDENTIAL": 0.15, ... },
--                                  // applied to EVERY edge (global hierarchy)
--       "in_corridor_road_classes": { "PRIMARY": 0.15, "MOTORWAY": 0.05, ... },
--                                  // applied to edges INSIDE the polygon, compounded with global
--       "exclusion_areas": [       // optional — additional polygons that suppress
--                                  //   parallel competing roads
--         {
--           "key":               "nine_w_route17_excl",
--           "geometry":          { GeoJSON Polygon },
--           "road_class_multipliers": { ... }
--         }
--       ]
--     }
--
--   kind='way_ids'
--     {
--       "osm_way_ids": [123456, ...],
--       "multiply_by": 2.0
--     }

create table if not exists public.corridors (
  id                 uuid primary key default gen_random_uuid(),
  key                text not null unique check (key ~ '^[a-z][a-z0-9_-]{0,40}$'),
  name               text not null,                           -- "9W" / "NY-97" / "NY-28"
  description        text,
  kind               text not null check (kind in ('polygon', 'way_ids')),
  config             jsonb not null,
  applies_to         text[] not null default array['twotired'],
  active             boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists corridors_active_name_idx
  on public.corridors (name) where active;

alter table public.corridors enable row level security;

create policy "auth can read"
  on public.corridors for select
  to authenticated using (true);

-- ── Seed: 9W ──
-- Notes (from buildCorridorModel comments):
--   • 9W is PRIMARY; in-corridor penalties crush MOTORWAY (Palisades Pkwy),
--     SECONDARY/TERTIARY/RESIDENTIAL so PRIMARY wins.
--   • No global MOTORWAY penalty — Astoria→GWB approach uses expressways.
--   • Route-17 exclusion polygon suppresses parallel PRIMARY/MOTORWAY west of 9W.
insert into public.corridors (key, name, description, kind, config) values (
  'nine_w_corridor',
  '9W',
  'Hudson River west bank corridor (Alpine/Fort Lee to Newburgh).',
  'polygon',
  jsonb_build_object(
    'geometry', jsonb_build_object(
      'type', 'Polygon',
      'coordinates', jsonb_build_array(jsonb_build_array(
        jsonb_build_array(-74.20, 40.94),
        jsonb_build_array(-73.88, 40.94),
        jsonb_build_array(-73.88, 41.52),
        jsonb_build_array(-74.20, 41.52),
        jsonb_build_array(-74.20, 40.94)
      ))
    ),
    'global_road_classes', jsonb_build_object(
      'RESIDENTIAL',   0.15,
      'LIVING_STREET', 0.05,
      'SERVICE',       0.05,
      'SECONDARY',     0.6,
      'TERTIARY',      0.5
    ),
    'in_corridor_road_classes', jsonb_build_object(
      'MOTORWAY',     0.05,
      'SECONDARY',    0.15,
      'TERTIARY',     0.15,
      'UNCLASSIFIED', 0.15,
      'RESIDENTIAL',  0.1,
      'LIVING_STREET',0.05,
      'SERVICE',      0.05
    ),
    'exclusion_areas', jsonb_build_array(jsonb_build_object(
      'key', 'nine_w_route17_excl',
      'geometry', jsonb_build_object(
        'type', 'Polygon',
        'coordinates', jsonb_build_array(jsonb_build_array(
          jsonb_build_array(-74.25, 40.90),
          jsonb_build_array(-73.95, 40.90),
          jsonb_build_array(-73.95, 41.10),
          jsonb_build_array(-74.03, 41.10),
          jsonb_build_array(-74.03, 41.35),
          jsonb_build_array(-74.25, 41.35),
          jsonb_build_array(-74.25, 40.90)
        ))
      ),
      'road_class_multipliers', jsonb_build_object(
        'MOTORWAY', 0.05,
        'PRIMARY',  0.1,
        'TRUNK',    0.1
      )
    ))
  )
);

-- ── Seed: NY-97 ──
-- INVERTED logic: NY-97 is SECONDARY; in-corridor rules crush competing
-- PRIMARY (US-6) and TRUNK so SECONDARY wins through the Delaware canyon.
insert into public.corridors (key, name, description, kind, config) values (
  'ny97_corridor',
  'NY-97',
  'Delaware River canyon (Hawks Nest, Sparrowbush, Port Jervis).',
  'polygon',
  jsonb_build_object(
    'geometry', jsonb_build_object(
      'type', 'Polygon',
      'coordinates', jsonb_build_array(jsonb_build_array(
        jsonb_build_array(-74.55, 41.28),
        jsonb_build_array(-75.10, 41.28),
        jsonb_build_array(-75.10, 41.72),
        jsonb_build_array(-74.55, 41.72),
        jsonb_build_array(-74.55, 41.28)
      ))
    ),
    'global_road_classes', jsonb_build_object(
      'MOTORWAY',      0.1,
      'RESIDENTIAL',   0.15,
      'LIVING_STREET', 0.05,
      'SERVICE',       0.05,
      'SECONDARY',     0.6,
      'TERTIARY',      0.5
    ),
    'in_corridor_road_classes', jsonb_build_object(
      'PRIMARY',  0.15,
      'TRUNK',    0.15,
      'MOTORWAY', 0.05
    )
  )
);

-- ── Seed: NY-28 ──
-- Same inverted logic as NY-97. Catskills spine; suppress US-209 (PRIMARY)
-- and I-87 / I-86 / NY-17 (MOTORWAY) so NY-28 (SECONDARY) wins.
insert into public.corridors (key, name, description, kind, config) values (
  'ny28_corridor',
  'NY-28',
  'Catskills spine (Kingston west to Margaretville/Delhi).',
  'polygon',
  jsonb_build_object(
    'geometry', jsonb_build_object(
      'type', 'Polygon',
      'coordinates', jsonb_build_array(jsonb_build_array(
        jsonb_build_array(-73.95, 41.80),
        jsonb_build_array(-74.80, 41.80),
        jsonb_build_array(-74.80, 42.25),
        jsonb_build_array(-73.95, 42.25),
        jsonb_build_array(-73.95, 41.80)
      ))
    ),
    'global_road_classes', jsonb_build_object(
      'MOTORWAY',      0.1,
      'RESIDENTIAL',   0.15,
      'LIVING_STREET', 0.05,
      'SERVICE',       0.05,
      'SECONDARY',     0.6,
      'TERTIARY',      0.5
    ),
    'in_corridor_road_classes', jsonb_build_object(
      'PRIMARY',  0.15,
      'TRUNK',    0.15,
      'MOTORWAY', 0.05
    )
  )
);
