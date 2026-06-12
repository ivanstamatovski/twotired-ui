-- Per-leg simplified geometries for two-phase routes.
--
-- mergeRoutes() in the edge function joins the escape leg (car profile
-- through NYC) and the scenic leg (motorcycle profile beyond) into a single
-- polyline stored as route_geometry. That makes the admin map draw both
-- legs as one color, which loses the "where does the city exit happen?"
-- signal the user wants.
--
-- route_legs stores each leg separately, simplified to ~50 pts each, so the
-- admin can color them distinctly. Single-call routes leave this column
-- null and fall back to route_geometry.

alter table public.route_logs add column if not exists route_legs jsonb;
