-- Store the LLM resolver's road identification (resolve-known-road) so the OSM
-- tracer can follow the ACTUAL scenic road(s) rather than the route number in
-- the name. { primary_roads:[{name,ref}], avoid_roads:[...], waypoints:[...],
-- confidence, reasoning, resolved_at }.
alter table public.known_roads
  add column if not exists resolved_roads jsonb;
