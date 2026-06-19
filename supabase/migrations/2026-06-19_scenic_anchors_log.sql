-- Phase 2A observability: log which catalog roads Claude picked as scenic
-- anchors and how big the catalog was on that request. Routing doesn't yet
-- consume scenic_anchors_chosen (that's Phase 2B) — for now we're observing
-- to confirm Claude makes sensible picks before wiring routing through them.

alter table public.route_logs
  add column if not exists scenic_anchors_chosen        jsonb,
  add column if not exists scenic_anchors_offered_count int;
