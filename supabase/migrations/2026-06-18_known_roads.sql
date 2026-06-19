-- known_roads — catalog of motorcycle-iconic roads in the service area.
--
-- Seeded one-shot from Claude Sonnet (his training data already contains
-- the lore: Hawk's Nest, Bear Mountain Bridge, 9W, Storm King, Old Mine
-- Rd, Litchfield Hills, Catskill loops, etc). Used by the corridor planner:
-- Claude emits sequenced scenic_anchors from this catalog, generate-route
-- routes leg-by-leg between the road endpoints. That forces GH through the
-- actual scenic road without the intermediate_waypoints snap-detour problem
-- (see feedback-routing-primitives memory).
--
-- Why this schema shape:
--  - One row per named segment, even if a "road" has multiple famous stretches
--    (Bear Mtn Bridge → Storm King is one segment; Storm King → West Point
--    overlook is another). Keeps anchor sequencing crisp.
--  - start_point/end_point as separate lat/lng cols (not PostGIS geometry)
--    keeps the edge function consumption simple — same shape as routes table.
--  - vibe_tags as text[] so admin can filter/group ("twisty", "iconic",
--    "panoramic", "tight-tech", "fast-sweeper", etc).
--  - state two-letter NOT NULL — every road belongs to a state for regional
--    filtering ("only suggest roads in the rider's state cluster").
--  - approved boolean — rider-facing usage gated on admin review. Same
--    pattern as bug_reports.lesson_approved.
--  - pairs_with uuid[] — graph of which roads naturally chain together
--    ("after Hawk's Nest, riders typically loop back via Bashakill").
--    Claude uses this when sequencing anchors for a loop.

create table if not exists public.known_roads (
  id              uuid primary key default gen_random_uuid(),

  -- Identity
  name            text        not null,                -- "Hawk's Nest", "9W (Palisades)", "Old Mine Rd"
  route_number    text,                                -- "NY-97", "US-9W", "CR-606"
  state           char(2)     not null,                -- "NY", "NJ", "CT", "MA", "PA"
  region          text,                                -- "Catskills", "Hudson Valley", "Lower Berkshires"

  -- Geometry — both endpoints, oriented so start→end is the "canonical" direction
  -- (e.g. Hawk's Nest is typically ridden Port Jervis → Sparrowbush going north).
  start_lat       double precision not null,
  start_lng       double precision not null,
  end_lat         double precision not null,
  end_lng         double precision not null,
  length_km       numeric(6,2),                        -- approximate driving length

  -- Character
  vibe_tags       text[]      not null default '{}',   -- e.g. {twisty,iconic,panoramic,tight-tech}
  difficulty      smallint    check (difficulty between 1 and 5),  -- 1=cruise, 5=expert
  curviness_tier  smallint    check (curviness_tier between 1 and 3),  -- maps to our 1/2/3
  best_for        text[]      not null default '{}',   -- {weekend, sunday-morning, fall-foliage, dawn}
  caveats         text,                                -- "heavy police weekends", "no gas 20mi"
  must_see        text,                                -- "Hawk's Nest overlook at mile 4"

  -- Chaining
  pairs_with      uuid[]      not null default '{}',   -- ids of roads that naturally follow

  -- Workflow
  source          text        not null default 'claude_seed'   -- claude_seed, manual, telemetry_inferred
                  check (source in ('claude_seed', 'manual', 'telemetry_inferred')),
  approved        boolean,                             -- null=pending review, true=use, false=rejected
  approved_at     timestamptz,
  approved_by     uuid references auth.users(id),
  admin_notes     text,

  -- Audit
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists known_roads_state_idx       on public.known_roads (state);
create index if not exists known_roads_approved_idx    on public.known_roads (approved);
create index if not exists known_roads_vibe_tags_idx   on public.known_roads using gin (vibe_tags);

-- updated_at auto-bump
create or replace function public.known_roads_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists known_roads_updated_at on public.known_roads;
create trigger known_roads_updated_at
  before update on public.known_roads
  for each row execute function public.known_roads_set_updated_at();

alter table public.known_roads enable row level security;

-- Reads: any authenticated user can read approved roads (riders' app may
-- surface them in the future as "discover" content). Pending/rejected
-- entries are admin-only via service role.
drop policy if exists "anyone reads approved known roads" on public.known_roads;
create policy "anyone reads approved known roads"
  on public.known_roads for select
  to authenticated
  using (approved = true);

-- Writes: service-role only. Admin portal uses service-role key.
