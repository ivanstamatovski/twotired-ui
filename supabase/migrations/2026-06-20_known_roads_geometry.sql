-- Cache the GraphHopper route geometry between each catalog road's endpoints.
-- Populated at validate-known-road approval time (we already call GH there to
-- check routability — saving the geometry is free). Lets the admin map view
-- render real road shapes instead of straight lines between endpoints, and
-- later lets the rider map color the catalog segment with high-fidelity.
--
-- Shape: GeoJSON LineString { type, coordinates: [[lng,lat], ...] }.
-- Pending/unvalidated roads keep geometry=null; the admin map falls back to
-- straight-line rendering until they're approved.

alter table public.known_roads
  add column if not exists geometry          jsonb,
  add column if not exists geometry_fetched_at timestamptz;
