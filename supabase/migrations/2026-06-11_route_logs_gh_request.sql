-- Capture the actual JSON body sent to GraphHopper per route generation.
--
-- Until now, route_logs stored the LLM intent (raw_intent) and the result
-- (route_geometry, route_result) but NOT the intermediate step: what
-- exactly the edge function asked GH to do. Without it, the admin Route
-- Debug view can show "what the user asked" and "what the route turned
-- out to be" but can't show "the custom_model + points + headings we
-- submitted" — which is where most routing decisions actually happen.
--
-- Stored as an array of leg requests because two-phase NYC escape sends
-- two separate calls (car-profile escape + motorcycle scenic). Reroutes
-- also generate their own row with their own gh_request.

alter table public.route_logs add column if not exists gh_request jsonb;
