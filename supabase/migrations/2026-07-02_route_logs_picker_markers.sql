-- Picker/seeded-ride markers on route_logs so the admin Rides list can flag
-- which rides came from the visual road picker (rider explicitly picked seeded
-- roads) vs a typed query, and name the ride after the seeded road(s).
--
-- Pairs with generate-route logging (log.title / log.phased / log.force_anchors)
-- and admin/index.html renderRides badge + lazy full-geometry fetch.
--
--   title         friendly ride name (v2.88): "Route 97 loop", "Hawk's Nest + 9W".
--                 Already returned to the client; now persisted for the admin list.
--   phased        v2.89 phased picker routing was used (transit + fun legs).
--   force_anchors v2.87 the rider EXPLICITLY picked these roads in the visual
--                 picker (the detour gates were bypassed). This is the reliable
--                 "picker ride" signal — scenic_anchors_resolved alone also fires
--                 for Claude auto-anchored typed queries.
alter table route_logs add column if not exists title         text;
alter table route_logs add column if not exists phased        boolean;
alter table route_logs add column if not exists force_anchors boolean;
