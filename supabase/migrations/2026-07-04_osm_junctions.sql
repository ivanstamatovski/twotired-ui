-- Cached OSM motorway-junction nodes so generate-route can tag exit numbers
-- WITHOUT calling public Overpass on the hot path (v2.96 → v2.97). Each row is
-- a highway=motorway_junction node whose `ref` is the exit number. Seeded once
-- from Overpass for the GH graph's coverage bbox (~11k rows, CT/MA/NJ/NY/PA +
-- surrounds); refresh occasionally with scripts/seed_osm_junctions.py.
create table if not exists osm_junctions (
  osm_id     bigint primary key,          -- OSM node id
  lat        double precision not null,
  lng        double precision not null,
  ref        text not null,               -- exit number, e.g. "8", "17B", "1A-B"
  name       text,
  updated_at timestamptz not null default now()
);

-- Exit lookup is a small bbox scan around each maneuver — index lat+lng.
create index if not exists osm_junctions_latlng on osm_junctions (lat, lng);

-- Service-role only (the edge fn queries with the service key, which bypasses
-- RLS). No public policies → anon/authenticated clients can't read it.
alter table osm_junctions enable row level security;

comment on table osm_junctions is
  'Cached OSM highway=motorway_junction nodes (ref = exit number) for exit-number tagging in generate-route. Seeded from Overpass; refresh with scripts/seed_osm_junctions.py.';
