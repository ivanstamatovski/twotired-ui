-- v2.83 anchor-detour-gate observability columns.
-- Per [[feedback-edge-fn-log-field-needs-migration]]: every log.foo assignment
-- in the edge function needs a matching ALTER TABLE, or PostgREST silently
-- drops the field and the admin trace can't show why a catalog ride
-- unexpectedly fell back to default routing.

alter table public.route_logs
  add column if not exists anchor_detour_check          jsonb,
  add column if not exists anchor_detour_dropped        boolean,
  add column if not exists anchor_actual_check          jsonb,
  add column if not exists anchor_detour_dropped_reason text;
