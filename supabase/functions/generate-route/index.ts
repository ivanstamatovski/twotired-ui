// generate-route edge function — v2.57
// v2.57: ETA calibration. Replaces GH's raw time (built on a generic speed model)
//        with a motorcycle-pace estimate computed per-segment from road_class
//        details. Also adds dwell time per stop (coffee 20min, lunch 45min, etc.)
//        and returns drive_minutes / stop_minutes / total_minutes on the response
//        for the frontend breakdown. duration_str now reflects total (drive + stops).
// v2.56: re-introduces two-phase routing for NYC origins with curviness 2/3.
// v2.55: fixes 9W corridor MOTORWAY penalty scope. Global MOTORWAY:0.1 was hurting
//        city approach legs (Astoria/Queens → GWB) by preventing expressway use.
//        Now scoped to in_nine_w_corridor and in_nine_w_route17_excl zones only,
//        matching the pattern NY-97 and NY-28 already used correctly.
// v2.54: removes NYC two-phase car escape routing. twotired profile has no motorway
//        penalty, so GH finds the best city exit (GWB, Turnpike, etc.) on its own.
//        Boundary waypoints (Fort Lee, New Brunswick) removed from system prompt.
//        Corridor anchor waypoints (Piermont, Nyack, Goshen, etc.) unchanged.
//        Single getRoute call for all curviness levels — no more mergeRoutes() splice.
// Architecture: LLM never produces coordinates.
// Places API geocodes. GraphHopper routes. Claude handles text only.
// v2.1: adds haversine post-filter to findPOI (fixes Joe Bosco / Delaware Water Gap bug)
// v2.2: adds Claude Sonnet 4.6 intent parsing — accepts natural language via body.query
// v2.3: adds Claude Haiku 4.5 ride narrative from GraphHopper turn-by-turn instructions
// v2.43: removes escape_waypoint/escape_via_waypoints. All routing waypoints use intermediate_waypoints.
// v2.44: restores car-profile city exit. escape_waypoint field is GONE (Claude never produces it),
//        but when origin is inside all 5 NYC boroughs AND there are intermediate_waypoints,
//        the code auto-runs a car-profile leg to intermediates[0] then merges with motorcycle scenic leg.
//        This keeps Manhattan/Brooklyn/Queens routing clean without any LLM-specified escape fields.
// v2.45: road scoring integration. After GH returns a route, we query the Molly score server
//        with the route geometry. It returns joy/transit scores for the specific segments
//        the route passes through — not the whole road's average. Scores added to response
//        and passed as hints to the narrative generator.
// v2.50: score-driven routing areas. Replaces static class-only CURVINESS_MODELS with
//        buildCurvinessModel() which fetches joy/transit area polygons from score server
//        at cold start and blends them with infrastructure safety-net rules.
// v2.51: curviness 1 (transit) now uses car profile. Car has no built-in motorway
//        penalty, so NJ Turnpike / interstates are naturally preferred for get-there
//        runs. motorcycle profile's internal motorway penalty can't be overridden by
//        multiply_by (capped at 1.0 in LM mode) so score areas alone weren't enough.
// v2.52: custom 'twotired' GH profile replaces car/motorcycle split. twotired is a
//        flat car-based profile (no road-class biases) with only infrastructure rules
//        baked in (RESIDENTIAL 0.15, LIVING_STREET/SERVICE 0.05, UNPAVED 0.1).
//        All routing preference comes from per-request custom_model: curviness tier
//        rules + joy/transit score area polygons. infra block removed from
//        buildCurvinessModel to avoid double-stacking penalties.
//        Tier 1: no motorway penalty + transit_tier_c 0.4× → highways beat NJ-27
//        Tier 2: class penalties + joy_tier_c 0.4× → boring primaries avoided
//        Tier 3: strong class penalties + joy_tier_c 0.4× → max scenery bias

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const GOOGLE_PLACES_KEY = Deno.env.get('GOOGLE_PLACES_KEY')!;
const GRAPHHOPPER_URL = Deno.env.get('GRAPHHOPPER_URL')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ROAD_SCORE_URL = Deno.env.get('ROAD_SCORE_URL') || ''; // optional — score server on Molly

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Fetch with retry (handles 529 overloaded + 429 rate-limit) ───────────────
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxAttempts = 4,
): Promise<Response> {
  let attempt = 0;
  while (true) {
    attempt++;
    const res = await fetch(url, options);
    // Retry on transient overload / rate-limit errors
    if ((res.status === 529 || res.status === 429) && attempt < maxAttempts) {
      // Exponential backoff: 1s, 2s, 4s
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      console.warn(`[fetchWithRetry] ${res.status} on attempt ${attempt}, retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      continue;
    }
    return res;
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────
type LatLng = { lat: number; lng: number };
type Location = LatLng | { query: string };

interface StopRequest {
  type: string;
  near: Location;
  radius_km?: number;
}

interface RouteRequest {
  origin: Location;
  destination: Location;
  stops?: StopRequest[];
  curviness?: 1 | 2 | 3;
  round_trip?: boolean;
  intermediate_waypoints?: string[]; // Forced visit points GH must pass through. Use ONLY for
                                     // explicit rider-named stops, NEVER for corridor anchoring
                                     // (see triangles in route 124).
  road_corridor?: string;            // Named road to follow (e.g. "9W", "NY-97", "NY-28").
                                     // When set: corridor model biases GH onto that road via
                                     // the data-driven corridors table.
}

// ── Palisades Pkwy avoidance zone ─────────────────────────────────────────────
// v2.25: The Palisades Interstate Pkwy (NJ/NY) is a motorway in OSM data.
// The global motorway penalty (0.1 for tier 2) is sometimes not enough — the Pkwy's
// high speed still makes it win over Route 9W (primary, 0.7 weight) on longer legs.
// This area applies an ADDITIONAL 0.1 multiply_by factor to motorways in the corridor,
// making combined priority 0.1 * 0.1 = 0.01 — effectively impassable for scenic routing.
// Route 9W (primary) is unaffected by this zone → GraphHopper must take 9W.
// Used in curviness tiers 2 and 3 only. Tier 1 (direct/spirited) uses highways lightly.
const PALISADES_ZONE_AREAS = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    id: 'palisades_pkwy',
    properties: {},
    geometry: {
      type: 'Polygon',
      // Rectangle covering NJ Palisades + lower Hudson Valley where Pkwy runs.
      // W edge: -74.050 (past Mahwah), E edge: -73.880 (Hudson River bank).
      // S edge: 40.840 (Fort Lee/GWB), N edge: 41.200 (Bear Mountain area).
      coordinates: [[
        [-74.050, 40.840],
        [-73.880, 40.840],
        [-73.880, 41.200],
        [-74.050, 41.200],
        [-74.050, 40.840],
      ]],
    },
  }],
};

// ── Corridors (data-driven) ──────────────────────────────────────────────────
// Source: supabase table `corridors` (migration 2026-05-28). Each row carries
// a `kind` discriminator (polygon | way_ids) and a `config` jsonb whose shape
// varies per kind. See the migration file for the full shape spec.
//
// Until Molly's GH config exposes `osm_way_id` in graph.encoded_values, all
// active corridors use kind='polygon'. The polygon kind preserves the in-code
// behaviour that lived in NINE_W_CORRIDOR_AREA / NY97_CORRIDOR_AREA / etc.
// before this refactor — same polygons, same road-class multipliers, but
// editable without redeploying.

type CorridorPolygonConfig = {
  geometry: any;                                // GeoJSON Polygon
  global_road_classes?: Record<string, number>; // applied to every edge
  in_corridor_road_classes?: Record<string, number>; // compounded inside polygon
  exclusion_areas?: Array<{                     // optional sidekick polygons
    key: string;
    geometry: any;
    road_class_multipliers: Record<string, number>;
  }>;
};

type CorridorWayIdsConfig = {
  osm_way_ids: number[];
  multiply_by: number;
};

type Corridor = {
  key: string;
  name: string;
  applies_to: string[];
} & (
  | { kind: 'polygon';  config: CorridorPolygonConfig  }
  | { kind: 'way_ids';  config: CorridorWayIdsConfig   }
);

let _corridorsCache: { data: Corridor[]; ts: number } | null = null;
const CORRIDORS_TTL_MS = 30_000;

async function getCorridors(): Promise<Corridor[]> {
  const now = Date.now();
  if (_corridorsCache && (now - _corridorsCache.ts) < CORRIDORS_TTL_MS) {
    return _corridorsCache.data;
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/corridors?select=key,name,kind,config,applies_to&active=eq.true`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      console.warn('[getCorridors] fetch failed:', res.status);
      _corridorsCache = { data: _corridorsCache?.data ?? [], ts: now };
      return _corridorsCache.data;
    }
    const rows = (await res.json()) as Corridor[];
    _corridorsCache = { data: rows, ts: now };
    if (rows.length) {
      const summary = rows.map(r => `${r.name}[${r.kind}]`).join(',');
      console.log('[getCorridors] loaded', rows.length, 'active:', summary);
    }
    return rows;
  } catch (e: any) {
    console.warn('[getCorridors] error:', e?.message);
    _corridorsCache = { data: _corridorsCache?.data ?? [], ts: now };
    return _corridorsCache.data;
  }
}

// Build the corridor-biased custom_model from a polygon-kind config. Mirrors
// the in-code logic that used to live in `if (corridor === '9W') { ... }`:
// global hierarchy rules + per-corridor in-polygon overrides + optional
// exclusion-area rules (e.g. 9W's Route-17 exclusion).
function buildPolygonCorridorModel(base: any, corridor: Corridor & { kind: 'polygon' }): any {
  const cfg = corridor.config;

  const globalRules = Object.entries(cfg.global_road_classes || {}).map(([cls, v]) => ({
    if: `road_class == ${cls}`,
    multiply_by: String(v),
  }));

  const inCorridorRules = Object.entries(cfg.in_corridor_road_classes || {}).map(([cls, v]) => ({
    if: `in_${corridor.key} && road_class == ${cls}`,
    multiply_by: String(v),
  }));

  const exclusionAreas = cfg.exclusion_areas || [];
  const exclusionRules = exclusionAreas.flatMap(ex =>
    Object.entries(ex.road_class_multipliers || {}).map(([cls, v]) => ({
      if: `in_${ex.key} && road_class == ${cls}`,
      multiply_by: String(v),
    })),
  );

  const corridorFeature = {
    type: 'Feature',
    id: corridor.key,
    geometry: cfg.geometry,
    properties: {},
  };
  const exclusionFeatures = exclusionAreas.map(ex => ({
    type: 'Feature',
    id: ex.key,
    geometry: ex.geometry,
    properties: {},
  }));

  return {
    speed: base.speed,
    priority: [...globalRules, ...inCorridorRules, ...exclusionRules],
    areas: {
      type: 'FeatureCollection',
      features: [...(base.areas?.features || []), corridorFeature, ...exclusionFeatures],
    },
    distance_influence: 90,
  };
}

// Build the corridor-biased custom_model from a way_ids-kind config. Requires
// Molly's GH config to expose `osm_way_id` in graph.encoded_values — otherwise
// GH rejects the model and we fall back silently to the base curviness model.
function buildWayIdsCorridorModel(base: any, corridor: Corridor & { kind: 'way_ids' }): any {
  const ids = corridor.config.osm_way_ids;
  if (!ids?.length) return base;
  const predicate = ids.length === 1
    ? `osm_way_id == ${ids[0]}`
    : `osm_way_id in [${ids.join(', ')}]`;
  return {
    speed: base.speed,
    priority: [
      ...(base.priority || []),
      { if: predicate, multiply_by: String(corridor.config.multiply_by) },
    ],
    areas: base.areas || { type: 'FeatureCollection', features: [] },
    distance_influence: 90,
  };
}

// Look up the named corridor in the corridors table and synthesise a
// custom_model. Falls back to the base curviness model if the corridor name
// isn't registered (logs a warning so admins notice a typo or missing seed).
async function buildCorridorModel(corridorName: string, curviness: 1 | 2 | 3): Promise<any> {
  const base = buildCurvinessModel(curviness);
  const corridors = await getCorridors();
  const corridor = corridors.find(c => c.name === corridorName);
  if (!corridor) {
    console.warn(`[buildCorridorModel] no row for corridor "${corridorName}" — falling back to base curviness model`);
    return base;
  }
  if (corridor.kind === 'polygon') return buildPolygonCorridorModel(base, corridor);
  if (corridor.kind === 'way_ids') return buildWayIdsCorridorModel(base, corridor);
  return base;
}

// ── Routing area cache (fetched from score server at cold start) ───────────────
// joy areas   → used for curviness 2 + 3 (scenic / backroads)
// transit areas → used for curviness 1 (get-there routing)
//
// In LM/flexible mode multiply_by is capped at 1.0 — we can only penalise, not
// boost.  The strategy: tier_c (low-scoring) roads get 0.4× penalty; tier_a and
// tier_b roads are untouched.  Net effect: GH routes around low-joy / low-transit
// roads rather than through them.  Combined with class-based safety-net rules
// this cleanly solves NJ-27 vs NJ Turnpike, Goshen interchange, etc.
let _joyAreas:     any | null = null;
let _transitAreas: any | null = null;

async function loadRoutingAreas(): Promise<void> {
  if (!ROAD_SCORE_URL) return;
  try {
    const [jRes, tRes] = await Promise.all([
      fetch(`${ROAD_SCORE_URL}/areas/joy`,     { signal: AbortSignal.timeout(10000) }),
      fetch(`${ROAD_SCORE_URL}/areas/transit`, { signal: AbortSignal.timeout(10000) }),
    ]);
    if (jRes.ok) { _joyAreas     = await jRes.json(); console.log('[loadRoutingAreas] joy areas loaded'); }
    if (tRes.ok) { _transitAreas = await tRes.json(); console.log('[loadRoutingAreas] transit areas loaded'); }
  } catch (e: any) {
    console.warn('[loadRoutingAreas] failed (will route without score areas):', e.message);
  }
}

// Kick off at module load — warm by the time the first request arrives
const _areasPromise = loadRoutingAreas();

// ── Learned corrections (rule-kind discriminated) ────────────────────────────
// Source: supabase table `learned_corrections` (migration 2026-05-28). Each
// row carries a rule_kind and a rule_data jsonb whose shape varies per kind.
// The migration file documents every shape; the types below mirror
// what we actually parse here.

type RoadClassFilter = 'all' | 'surface_only' | 'highways_only';
type Bbox = [number, number, number, number]; // [lon_sw, lat_sw, lon_ne, lat_ne]

type LearnedCorrectionBase = {
  key: string;
  name: string;
  applies_to: string[];
};

type EscapeWaypointRule = LearnedCorrectionBase & {
  rule_kind: 'escape_waypoint';
  rule_data: {
    origin_bbox: Bbox;
    bearing_min: number;
    bearing_max: number;
    destination_bbox?: Bbox | null;
    forced_waypoint: LatLng & { name?: string };
  };
};

type EdgePenaltyRule = LearnedCorrectionBase & {
  rule_kind: 'edge_penalty';
  rule_data: {
    osm_way_ids: number[];
    multiply_by: number;
  };
};

type BannedCrossingRule = LearnedCorrectionBase & {
  rule_kind: 'banned_crossing';
  rule_data: {
    osm_way_id: number;
    from_bbox?: Bbox | null;
    to_bbox?: Bbox | null;
  };
};

type AreaPenaltyRule = LearnedCorrectionBase & {
  rule_kind: 'area_penalty';
  rule_data: {
    geometry: any;
    multiply_by: number;
    road_class_filter?: RoadClassFilter;
  };
};

type LearnedCorrection =
  | EscapeWaypointRule
  | EdgePenaltyRule
  | BannedCrossingRule
  | AreaPenaltyRule;

function pointInBbox(ll: LatLng, b: Bbox): boolean {
  return ll.lng >= b[0] && ll.lat >= b[1] && ll.lng <= b[2] && ll.lat <= b[3];
}

// Bearing range with wraparound (e.g. min=350, max=20 covers 350→360→0→20).
function bearingInRange(bearing: number, min: number, max: number): boolean {
  if (min <= max) return bearing >= min && bearing <= max;
  return bearing >= min || bearing <= max;
}

// Compound `if` predicate for an area_penalty rule, accounting for the
// road-class filter. Without a filter, the polygon would also hit the
// highways that ride the perimeter — almost never what the user meant.
function areaPenaltyPredicate(key: string, filter: RoadClassFilter | undefined): string {
  switch (filter || 'surface_only') {
    case 'highways_only':
      return `in_${key} && (road_class == MOTORWAY || road_class == TRUNK || road_class_link == true)`;
    case 'all':
      return `in_${key}`;
    case 'surface_only':
    default:
      return `in_${key} && road_class != MOTORWAY && road_class != TRUNK && road_class_link == false`;
  }
}
let _learnedCorrectionsCache: { data: LearnedCorrection[]; ts: number } | null = null;
const LEARNED_CORRECTIONS_TTL_MS = 30_000;

async function getLearnedCorrections(): Promise<LearnedCorrection[]> {
  const now = Date.now();
  if (_learnedCorrectionsCache && (now - _learnedCorrectionsCache.ts) < LEARNED_CORRECTIONS_TTL_MS) {
    return _learnedCorrectionsCache.data;
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/learned_corrections?select=key,name,rule_kind,rule_data,applies_to&active=eq.true`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) {
      console.warn('[getLearnedCorrections] fetch failed:', res.status);
      _learnedCorrectionsCache = { data: _learnedCorrectionsCache?.data ?? [], ts: now };
      return _learnedCorrectionsCache.data;
    }
    const rows = (await res.json()) as LearnedCorrection[];
    _learnedCorrectionsCache = { data: rows, ts: now };
    if (rows.length) {
      const summary = rows.map(r => `${r.key}[${r.rule_kind}]`).join(',');
      console.log('[getLearnedCorrections] loaded', rows.length, 'active:', summary);
      const bannedNotImpl = rows.filter(r => r.rule_kind === 'banned_crossing');
      if (bannedNotImpl.length) {
        console.warn('[getLearnedCorrections] banned_crossing not yet enforced; ignoring',
          bannedNotImpl.map(r => r.key).join(','));
      }
    }
    return rows;
  } catch (e: any) {
    console.warn('[getLearnedCorrections] error:', e?.message);
    _learnedCorrectionsCache = { data: _learnedCorrectionsCache?.data ?? [], ts: now };
    return _learnedCorrectionsCache.data;
  }
}

// Filter corrections to those whose applies_to matches the given GH profile.
function relevantTo(profile: string, corrections: LearnedCorrection[]): LearnedCorrection[] {
  return corrections.filter(c => !c.applies_to?.length || c.applies_to.includes(profile));
}

// area_penalty rule_kind → mutate the per-request custom_model. Adds each
// polygon as a Feature in model.areas and a corresponding priority predicate.
function applyAreaPenalties(model: any, profile: string, corrections: LearnedCorrection[]): any {
  if (!model || !corrections.length) return model;
  const relevant = relevantTo(profile, corrections).filter(
    (c): c is AreaPenaltyRule => c.rule_kind === 'area_penalty',
  );
  if (!relevant.length) return model;

  if (!model.areas) model.areas = { type: 'FeatureCollection', features: [] };
  if (!model.areas.features) model.areas.features = [];
  if (!model.priority) model.priority = [];

  for (const c of relevant) {
    if (model.areas.features.some((f: any) => f.id === c.key)) continue;
    model.areas.features.push({
      type: 'Feature',
      id: c.key,
      geometry: c.rule_data.geometry,
      properties: {},
    });
    model.priority.push({
      if: areaPenaltyPredicate(c.key, c.rule_data.road_class_filter),
      multiply_by: String(c.rule_data.multiply_by),
    });
  }
  return model;
}

// edge_penalty rule_kind → custom_model rule on osm_way_id encoded value.
// REQUIRES Molly's GH config to expose `osm_way_id` in graph.encoded_values;
// if it's not, GH rejects the model and the route falls back to the default.
// Logs (does not throw) so an outdated GH config doesn't break routing.
function applyEdgePenalties(model: any, profile: string, corrections: LearnedCorrection[]): any {
  if (!model || !corrections.length) return model;
  const relevant = relevantTo(profile, corrections).filter(
    (c): c is EdgePenaltyRule => c.rule_kind === 'edge_penalty',
  );
  if (!relevant.length) return model;

  if (!model.priority) model.priority = [];
  // GH custom_model `if` expressions use Janino — supports ==, !=, &&, ||,
  // but NOT Python-style `in [list]` (route 141 was rejected for that exact
  // syntax). We emit an OR chain, chunked into 20-ID batches per priority
  // rule so individual expressions stay short and Janino-compilable.
  const CHUNK = 20;
  for (const c of relevant) {
    const ids = c.rule_data.osm_way_ids;
    if (!ids?.length) continue;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const predicate = chunk.map(id => `osm_way_id == ${id}`).join(' || ');
      model.priority.push({ if: predicate, multiply_by: String(c.rule_data.multiply_by) });
    }
  }
  return model;
}

// escape_waypoint rule_kind → if any active rule matches (origin in bbox,
// destination bearing in range, optional destination_bbox match), return the
// forced waypoint. First match wins; admins should keep rules disjoint.
function getEscapeOverride(
  origin: LatLng,
  destination: LatLng,
  corrections: LearnedCorrection[],
): LatLng | null {
  const bearing = bearingDegrees(origin, destination);
  for (const c of corrections) {
    if (c.rule_kind !== 'escape_waypoint') continue;
    const d = c.rule_data;
    if (!pointInBbox(origin, d.origin_bbox)) continue;
    if (!bearingInRange(bearing, d.bearing_min, d.bearing_max)) continue;
    if (d.destination_bbox && !pointInBbox(destination, d.destination_bbox)) continue;
    console.log(`[escape-override] matched rule "${c.key}" → forcing waypoint`,
      JSON.stringify(d.forced_waypoint));
    return { lat: d.forced_waypoint.lat, lng: d.forced_waypoint.lng };
  }
  return null;
}

// banned_crossing rule_kind is parsed but not yet enforced. Implementing it
// requires per-edge osm_way_ids in the merged route — wire `path_details`
// into the GH calls and add a post-route scan when the first such rule is
// actually written. A warning fires from getLearnedCorrections() when one
// is loaded so it doesn't fail silently.

// ── Curviness tier model builder ───────────────────────────────────────────────
// v2.5: replaced static class-based CURVINESS_MODELS array with a function that
// blends infrastructure rules (class-based safety nets) with score-driven area
// penalties from generate_joy_areas.py.
//
// Architecture:
//   Tier 1 (transit)  — no motorway penalty; transit_tier_c penalised 0.4×
//                        → NJ Turnpike beats NJ-27 because 27 is tier_c (signal-heavy)
//   Tier 2 (scenic)   — motorway/trunk penalised by class; joy_tier_c penalised 0.4×
//                        → boring primary roads avoided, twisty secondaries preferred
//   Tier 3 (backroads) — motorway/primary penalised by class; joy_tier_c penalised 0.4×
//                        → maximum scenery, highest-joy roads selected
//
// Infrastructure rules kept in all tiers (not scoring, just topology hygiene):
//   RESIDENTIAL: 0.15  — motorcycles are not neighbourhood crawlers
//   LIVING_STREET/SERVICE: 0.05 — effectively banned
function buildCurvinessModel(curviness: 1 | 2 | 3): any {
  // NOTE: RESIDENTIAL (0.15), LIVING_STREET/SERVICE (0.05), and UNPAVED (0.1) rules
  // live in twotired.json (the GH base profile). Do NOT repeat them here — GH merges
  // per-request custom_model on top of the profile model multiplicatively, so repeating
  // them would double-stack the penalties (e.g. RESIDENTIAL → 0.15 × 0.15 = 0.02).

  // Palisades zone is always included so the Pkwy motorway is penalised for scenic tiers.
  const baseAreaFeatures: any[] = [...(PALISADES_ZONE_AREAS.features)];

  if (curviness === 1) {
    // Transit: flat base (all road classes at 1.0 from twotired profile — motorways fine).
    // Only score-area penalty applied: avoid transit-poor roads.
    const priority: any[] = [
      ...(_transitAreas ? [{ if: 'in_transit_tier_c', multiply_by: '0.4' }] : []),
    ];
    const areaFeatures = [
      ...baseAreaFeatures,
      ...(_transitAreas?.features ?? []),
    ];
    return {
      speed: [],
      priority,
      areas: { type: 'FeatureCollection', features: areaFeatures },
      distance_influence: 90,
    };
  }

  if (curviness === 2) {
    // Scenic: penalise big fast roads + joy_tier_c penalty for boring/congested roads.
    const priority: any[] = [
      { if: 'road_class == MOTORWAY', multiply_by: '0.1'  },
      { if: 'road_class == TRUNK',    multiply_by: '0.2'  },
      { if: 'road_class == PRIMARY',  multiply_by: '0.7'  },
      { if: 'in_palisades_pkwy && road_class == MOTORWAY', multiply_by: '0.1' },
      ...(_joyAreas ? [{ if: 'in_joy_tier_c', multiply_by: '0.4' }] : []),
    ];
    const areaFeatures = [
      ...baseAreaFeatures,
      ...(_joyAreas?.features ?? []),
    ];
    return {
      speed: [],
      priority,
      areas: { type: 'FeatureCollection', features: areaFeatures },
      distance_influence: 90,
    };
  }

  // Curviness 3: backroads — maximum scenery bias, motorways effectively banned.
  const priority: any[] = [
    { if: 'road_class == MOTORWAY', multiply_by: '0.05' },
    { if: 'road_class == TRUNK',    multiply_by: '0.1'  },
    { if: 'road_class == PRIMARY',  multiply_by: '0.5'  },
    { if: 'in_palisades_pkwy && road_class == MOTORWAY', multiply_by: '0.1' },
    ...(_joyAreas ? [{ if: 'in_joy_tier_c', multiply_by: '0.4' }] : []),
  ];
  const areaFeatures = [
    ...baseAreaFeatures,
    ...(_joyAreas?.features ?? []),
  ];
  return {
    speed: [],
    priority,
    areas: { type: 'FeatureCollection', features: areaFeatures },
    distance_influence: 90,
  };
}

// ── Score-only routing model (variant === 'scoring') ──────────────────────────
// No road-class penalties at all. Joy area weights drive all route preference:
//   tier_a (1.5×) keeps GH lingering in scenic zones.
//   tier_c (0.4×) creates natural escape pressure from urban/boring areas —
//   GH exits red zones via whatever road is fastest (often a motorway), no
//   explicit penalty needed and no looping artefacts from the exit waypoint.
function buildScoringModel(curviness: 2 | 3): any {
  const priority: any[] = [
    ...(_joyAreas ? [
      { if: 'in_joy_tier_a', multiply_by: '1.5' },
      { if: 'in_joy_tier_c', multiply_by: '0.4' },
    ] : []),
  ];
  const areaFeatures = [...(_joyAreas?.features ?? [])];
  return {
    speed: [],
    priority,
    areas: { type: 'FeatureCollection', features: areaFeatures },
    distance_influence: 90,
  };
}

// Keep CURVINESS_MODELS as a lazy getter so corridor builder can still reference it
// (corridor builder calls buildCorridorModel which needs the base speed array)
const CURVINESS_MODELS = [1, 2, 3].map((c) => buildCurvinessModel(c as 1 | 2 | 3));

// ── Haversine distance (km) ────────────────────────────────────────────────────
function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371, toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ── ETA calibration (v2.57) ────────────────────────────────────────────────────
// GH's raw time field uses a generic motorcycle speed model — accurate enough for
// route choice but consistently optimistic for actual ride time. Real riders go
// SLOWER than GH expects on twisty backroads (savoring the ride) and roughly
// the same on motorways. We re-compute drive time per-segment from a sustained-
// pace model keyed on OSM road_class. Speeds are average sustained motorcycle
// pace in m/s — not posted speed limits. Tune from rider logs over time.
const PACE_MS: Record<string, number> = {
  motorway:        30.0,  // ~108 km/h, ~67 mph — slab cruising
  motorway_link:   18.0,
  trunk:           27.0,  // ~97 km/h
  trunk_link:      15.0,
  primary:         22.0,  // ~80 km/h — 9W open sections
  primary_link:    13.0,
  secondary:       18.0,  // ~65 km/h — typical scenic curvy
  secondary_link:  11.0,
  tertiary:        15.0,  // ~54 km/h — backroads
  tertiary_link:    9.0,
  unclassified:    12.0,  // ~43 km/h — small country roads
  residential:     10.0,  // ~36 km/h — through town
  living_street:    6.0,
  service:          7.0,
  track:            8.0,
  path:             6.0,
  road:            18.0,  // fallback
};
const DEFAULT_PACE_MS = 18.0;

// Walk path.details.road_class with the geometry to produce a calibrated total
// drive time. Each detail tuple is [from_idx, to_idx, road_class_str] indexing
// into the coordinate array. Returns ms. Falls back to a 1.15× scalar on GH's
// raw time if the road_class detail is missing (e.g. GH config doesn't expose it).
function calibrateDriveTimeMs(path: any): number {
  const coords: number[][] = path?.points?.coordinates;
  const detailRows: any[] = path?.details?.road_class;
  if (!coords?.length || !Array.isArray(detailRows) || !detailRows.length) {
    return Math.round((path?.time ?? 0) * 1.15);
  }
  let totalMs = 0;
  for (const row of detailRows) {
    const from = row[0], to = row[1];
    const cls = String(row[2] || '').toLowerCase();
    const pace = PACE_MS[cls] ?? DEFAULT_PACE_MS;
    let segMeters = 0;
    for (let i = from; i < to && i + 1 < coords.length; i++) {
      const a = { lat: coords[i][1],     lng: coords[i][0] };
      const b = { lat: coords[i + 1][1], lng: coords[i + 1][0] };
      segMeters += haversineKm(a, b) * 1000;
    }
    totalMs += (segMeters / pace) * 1000;
  }
  return Math.round(totalMs);
}

// ── Stop dwell time (v2.57) ────────────────────────────────────────────────────
// Riders don't just drive — they stop. Adding actual dwell time per stop is the
// single biggest improvement to perceived ETA accuracy. Defaults are conservative
// (riders pace themselves on the bike) and can be tuned from real ride logs.
const STOP_DWELL_MIN: Record<string, number> = {
  coffee:           20,
  'coffee shop':    20,
  cafe:             20,
  breakfast:        30,
  lunch:            45,
  dinner:           60,
  restaurant:       45,
  food:             45,
  diner:            45,
  bar:              45,
  pub:              45,
  brewery:          60,
  gas:               8,
  fuel:              8,
  'gas station':     8,
  rest:             10,
  'rest stop':      10,
  'rest area':      10,
  scenic:           10,
  viewpoint:        10,
  overlook:         10,
  lookout:          10,
  park:             20,
  museum:           60,
  attraction:       45,
  shopping:         30,
  shop:             20,
  bathroom:          5,
  restroom:          5,
};
const DEFAULT_DWELL_MIN = 15;

function dwellMinutesForStop(type: string): number {
  const key = (type || '').toLowerCase().trim();
  if (STOP_DWELL_MIN[key] != null) return STOP_DWELL_MIN[key];
  // Substring match — e.g. "lunch spot", "coffee shop downtown", "gas station near 9W"
  for (const [k, v] of Object.entries(STOP_DWELL_MIN)) {
    if (key.includes(k)) return v;
  }
  return DEFAULT_DWELL_MIN;
}

// ── Compass bearing (degrees, clockwise from north) ───────────────────────────
// Used to supply heading hints to GraphHopper intermediate waypoints.
// Prevents waypoint U-turns: a northbound route told to pass through a point
// heading north cannot dip south to reach the town center then return north.
function bearingDegrees(from: LatLng, to: LatLng): number {
  const toRad = (d: number) => d * Math.PI / 180;
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat), lat2 = toRad(to.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}

// ── Hardcoded coordinate table for known escape / intermediate waypoints ───────
// v2.23: bypass Places API geocoding for fixed routing infrastructure.
// Places API returns wrong things for bridges and highway ramps (e.g. parking lots).
// Coordinates are snapped to the road surface at each named point.
// Claude outputs one of these names → we use the exact coordinate → no geocoding error.
// Fall back to Places API only for names not in this table.
// v2.26: all coordinates sourced from real OSM node data via Overpass API.
// Each coord is a confirmed node on the named road way — not a town centroid.
// OSM way IDs are cited for auditability.
const KNOWN_WAYPOINTS: Record<string, LatLng> = {
  // ── GWB corridor — NJ side ──
  'fort lee, nj':                       { lat: 40.851206, lng: -73.970859 }, // Main St / Lemoine Ave, Fort Lee — just across GWB on NJ side
  'alpine, nj':                         { lat: 40.956668, lng: -73.921224 }, // US 9W / Palisades Blvd — OSM way 1297483038
  'mahwah, nj':                         { lat: 41.091303, lng: -74.154417 }, // NJ-17 / Route 17 South — OSM way 60972489
  'milford, nj':                        { lat: 40.572300, lng: -75.094800 }, // NJ-29 / River Road at Milford Borough
  // Englewood Cliffs: kept for edge cases — no longer a primary routing waypoint
  'englewood cliffs, nj':               { lat: 40.882243, lng: -73.950588 }, // US 9W / Sylvan Ave — OSM way 46613631
  // ── GWB corridor — NY side ──
  'gwb ny approach':                    { lat: 40.853310, lng: -73.960688 }, // Trans-Manhattan Expy / GWB on-ramp, upper Manhattan — steers Queens/Brooklyn traffic via Triborough, not midtown
  'piermont, ny':                       { lat: 41.036665, lng: -73.923354 }, // US 9W / Highland Ave, Piermont — OSM way 24168303
  'nyack, ny':                          { lat: 41.081355, lng: -73.924058 }, // US 9W through Nyack — OSM way 8082568
  // ── Mario Cuomo Bridge (Tappan Zee) — Westchester escape ──
  'mario cuomo bridge, tarrytown, ny':  { lat: 41.070867, lng: -73.877595 }, // I-87/I-287 Tarrytown approach — OSM way 549576862
  // ── Harriman (NY Thruway exit 16 area) — far north escape ──
  'harriman, ny':                       { lat: 41.230961, lng: -74.182529 }, // NY-17 / State Hwy 17 — OSM way 45974941
  // ── Far north / Catskill intermediates ──
  'middletown, ny':                     { lat: 41.439491, lng: -74.420791 }, // NY-17M / Academy Ave — OSM way 20667484
  'goshen, ny':                         { lat: 41.395158, lng: -74.333064 }, // NY-17M — OSM way 20657580
  'ellenville, ny':                     { lat: 41.717875, lng: -74.394670 }, // US-209 / N Main St — OSM way 20223282
  'kingston, ny':                       { lat: 41.932782, lng: -74.011393 }, // NY-28 / Colonel Chandler Dr — OSM way 44036320
  // ── 9W scenic corridor ──
  'haverstraw, ny':                     { lat: 41.197694, lng: -73.962861 }, // US 9W / Broadway, Haverstraw — OSM way 20693452
  'bear mountain, ny':                  { lat: 41.320894, lng: -73.991726 }, // US 9W at Bear Mountain circle — OSM way 20691455
  'bear mountain state park, ny':       { lat: 41.320894, lng: -73.991726 },
  'cornwall, ny':                       { lat: 41.439746, lng: -73.999997 }, // NY-218 / Bay View Ave — OSM way 605157171
  'cornwall-on-hudson, ny':             { lat: 41.439746, lng: -73.999997 },
  'newburgh, ny':                       { lat: 41.499076, lng: -74.021556 }, // US 9W / S Robinson Ave — OSM way 20666000
  // ── Staten Island crossings ──
  'goethals bridge, staten island, ny': { lat: 40.636037, lng: -74.182515 }, // I-278 Goethals on-ramp, SI side (Howland Hook) — was previously 40.6436,-74.2098 which is actually Elizabeth NJ past the bridge, causing SW escape legs from Brooklyn/Queens to route through Manhattan→Holland Tunnel→NJ instead of via Verrazano
  'verrazano-narrows bridge, staten island, ny': { lat: 40.601958, lng: -74.058808 }, // I-278 SI Expressway — OSM way 5680111
  'perth amboy, nj':                    { lat: 40.514965, lng: -74.286347 }, // NJ-35 / Convery Blvd — OSM way 11663261
  // ── Long Island boundary ──
  'garden city, ny':                    { lat: 40.726944, lng: -73.633611 }, // Nassau County — first major town east of Queens border
  // ── Shore / SW NJ intermediates ──
  'freehold, nj':                       { lat: 40.266728, lng: -74.293930 }, // US-9 / US Highway 9 — OSM way 46499952
  'toms river, nj':                     { lat: 39.963559, lng: -74.204741 }, // NJ-37 / Route 37 West — OSM way 11742469
  'new brunswick, nj':                  { lat: 40.486966, lng: -74.444523 }, // US-1 / Albany St, New Brunswick — SW corridor anchor
  // ── Escape via waypoints (city highways — car profile only) ──
  'i-278/bqe, brooklyn, ny':           { lat: 40.692734, lng: -73.999541 }, // I-278 BQE Brooklyn — OSM way 38182028
  'belt parkway/flatbush ave, brooklyn, ny': { lat: 40.584807, lng: -73.946343 }, // Belt Pkwy — OSM way 219685090
  'fdr drive/96th st, manhattan, ny':  { lat: 40.781524, lng: -73.944267 }, // FDR Drive — OSM way 5670186
};

function lookupWaypoint(name: string): LatLng | null {
  const key = name.toLowerCase().trim().replace(/\s+/g, ' ');
  if (KNOWN_WAYPOINTS[key]) {
    console.log(`[waypoint] "${name}" → hardcoded coords (no geocode)`);
    return KNOWN_WAYPOINTS[key];
  }
  // Partial match for minor naming variations
  for (const [k, v] of Object.entries(KNOWN_WAYPOINTS)) {
    if (key === k || key.startsWith(k) || k.startsWith(key)) {
      console.log(`[waypoint] "${name}" → hardcoded coords via partial match "${k}"`);
      return v;
    }
  }
  return null;
}

// Resolve a routing waypoint: check hardcoded table first, fall back to Places API.
// Used for intermediate_waypoints — not for user destinations/stops.
async function resolveWaypoint(name: string): Promise<LatLng> {
  return lookupWaypoint(name) ?? await geocode(name);
}

// ── Geocode a place name via Places API (New) ─────────────────────────────────
// v2.8: added locationBias rectangle covering the Northeast US.
// Prevents Places from returning far-away namesakes (e.g. "Hawks Nest" → DC).
// Rectangle covers NY/NJ/CT/MA/VT/NH/ME/PA. Circle radius is capped at 50km by Places API.
// This is a bias (preference), not a hard restriction — queries with a state abbreviation
// (e.g. "Hawks Nest, NY") will always win regardless.
const NORTHEAST_BBOX = {
  low:  { latitude: 38.5, longitude: -80.0 }, // SW corner: SW Pennsylvania
  high: { latitude: 47.5, longitude: -66.5 }, // NE corner: Maine coast
};

async function geocode(query: string): Promise<LatLng> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': 'places.location',
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: 1,
      locationBias: { rectangle: NORTHEAST_BBOX },
    }),
  });
  if (!res.ok) throw new Error(`Places geocode failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const loc = data.places?.[0]?.location;
  if (!loc) throw new Error(`No geocode result for: ${query}`);
  return { lat: loc.latitude, lng: loc.longitude };
}

// ── Resolve Location → LatLng ─────────────────────────────────────────────────
// Check hardcoded KNOWN_WAYPOINTS first so destinations like "Bear Mountain"
// snap to a known road-adjacent coord rather than Google Places' off-road
// geocode (e.g. parking lot or trail head 250m from any routable road).
async function resolveLocation(loc: Location): Promise<LatLng> {
  if ('lat' in loc) return loc;
  const hardcoded = lookupWaypoint(loc.query);
  if (hardcoded) return hardcoded;
  return await geocode(loc.query);
}

// ── Find a POI near a location via Places API (New) ───────────────────────────
// v2.1: added haversine post-filter — locationBias is a preference, not a restriction.
// Without this filter, Places can return a prominent result 60km outside the radius.
async function findPOI(type: string, near: LatLng, radius_km = 25): Promise<any | null> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': GOOGLE_PLACES_KEY,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.internationalPhoneNumber,places.regularOpeningHours,places.currentOpeningHours,places.priceLevel,places.primaryTypeDisplayName,places.googleMapsUri,places.photos',
    },
    body: JSON.stringify({
      textQuery: type,
      maxResultCount: 10,
      locationBias: {
        circle: {
          center: { latitude: near.lat, longitude: near.lng },
          radius: radius_km * 1000,
        },
      },
    }),
  });
  if (!res.ok) {
    console.error('[findPOI] Places error:', res.status, await res.text());
    return null;
  }
  const data = await res.json();

  // haversine post-filter: drop anything outside the actual radius
  const nearby = (data.places || []).filter((p: any) => {
    if (!p.location) return false;
    const dist = haversineKm(near, { lat: p.location.latitude, lng: p.location.longitude });
    return dist <= radius_km;
  });

  if (nearby.length === 0) {
    console.log(`[findPOI] No "${type}" within ${radius_km}km of ${near.lat},${near.lng} (Places returned ${(data.places||[]).length} results, all outside radius)`);
    return null;
  }

  // Pick highest-rated result within radius
  nearby.sort((a: any, b: any) => (b.rating || 0) - (a.rating || 0));
  const best = nearby[0];

  console.log(`[findPOI] "${type}" → ${best.displayName?.text} (${best.rating}★, ${haversineKm(near, {lat: best.location.latitude, lng: best.location.longitude}).toFixed(1)}km away)`);
  return {
    name: best.displayName?.text || type,
    address: best.formattedAddress || '',
    lat: best.location.latitude,
    lng: best.location.longitude,
    rating: best.rating || null,
    ratingCount: best.userRatingCount || 0,
    website: best.websiteUri || null,
    placeId: best.id || null,
    phone: best.internationalPhoneNumber || null,
    priceLevel: best.priceLevel || null,
    primaryType: best.primaryTypeDisplayName?.text || null,
    googleMapsUri: best.googleMapsUri || null,
    openNow: best.currentOpeningHours?.openNow ?? null,
    hours: best.regularOpeningHours?.weekdayDescriptions || null,
    // First 5 photo resource names (e.g. "places/ChIJ.../photos/AeJbb3y...").
    // Client constructs the actual media URL via Place Photos API on demand.
    photos: Array.isArray(best.photos)
      ? best.photos.slice(0, 5).map((p: any) => p?.name).filter(Boolean)
      : [],
  };
}

// ── Route via GraphHopper ─────────────────────────────────────────────────────
// curviness 0 = city escape mode: car profile + CH routing, highways naturally preferred
// curviness 1–3 = motorcycle profile + LM flexible mode with scenic custom_model
// headings: optional per-point compass bearing array (degrees, -1 = unconstrained).
//   For scenic legs, pass the overall route bearing at each via-point to prevent
//   U-turn excursions into town centers. E.g. northbound 9W → heading ≈ 0 at Nyack
//   means GraphHopper must pass through Nyack traveling north — it cannot dip south
//   to reach the town center and backtrack, because that would require a U-turn.
async function getRoute(points: LatLng[], curviness: 0 | 1 | 2 | 3 = 2, headings?: number[], modelOverride?: any): Promise<any> {
  // Fetch human-reviewed routing corrections up front. Two reasons we need
  // them this early: (1) the car-leg branch below has to know whether to
  // switch from CH to LM mode (it does whenever any custom_model rule applies
  // to the car profile), and (2) we inject the matching rules into the
  // custom_model just before sending to GH. escape_waypoint rules are
  // consumed upstream in pickExitPoint, not here.
  const learnedCorrections = await getLearnedCorrections();
  const profile = curviness === 0 ? 'car' : 'twotired';
  const profileLearned = relevantTo(profile, learnedCorrections).filter(
    c => c.rule_kind === 'area_penalty' || c.rule_kind === 'edge_penalty',
  );

  let body: any;
  if (curviness === 0) {
    // Car profile.
    // - No learned areas → fast CH path (default behaviour, motorways preferred).
    // - With learned areas → switch to flexible LM mode so we can carry a
    //   custom_model whose `priority` rules + area polygons force the route
    //   to steer around the avoidance shapes.
    if (profileLearned.length === 0) {
      body = {
        points: points.map(p => [p.lng, p.lat]),
        profile: 'car',
        points_encoded: false,
        instructions: true,
        locale: 'en',
        details: ['road_class'],
      };
    } else {
      const carModel: any = { speed: [], priority: [], areas: { type: 'FeatureCollection', features: [] }, distance_influence: 90 };
      body = {
        points: points.map(p => [p.lng, p.lat]),
        profile: 'car',
        custom_model: carModel,
        'ch.disable': true,
        points_encoded: false,
        instructions: true,
        locale: 'en',
        details: ['road_class'],
      };
    }
  } else {
    // Motorcycle profile — LM flexible mode with scenic custom_model
    // v2.25: snap_prevention stops waypoints from snapping to motorways/motorway_links.
    // This ensures e.g. Alpine, NJ snaps to Route 9W (primary) not Palisades Pkwy (motorway).
    // Combined with the PALISADES_ZONE_AREAS penalty in custom_model, motorways in the
    // Palisades corridor are effectively ruled out for all scenic routing tiers (2 and 3).
    // v2.33: modelOverride allows corridor-specific custom_model (buildCorridorModel).
    const model = modelOverride || CURVINESS_MODELS[curviness - 1];
    body = {
      points: points.map(p => [p.lng, p.lat]),
      // v2.52: single 'twotired' profile for all curviness tiers. Flat car-based base
      // (no road-class biases) — all routing preference comes from the per-request
      // custom_model (curviness tier rules + joy/transit score area polygons).
      profile: 'twotired',
      custom_model: model,
      'ch.disable': true,
      snap_prevention: ['motorway', 'motorway_link'],
      points_encoded: false,
      instructions: true,
      locale: 'en',
      details: ['road_class'],
    };
    // v2.30: heading hints prevent via-point U-turn excursions.
    // Only applied to scenic (motorcycle) legs — car escape uses highways where
    // snapping direction is unambiguous. heading_penalty amplifies the preference.
    if (headings && headings.length === points.length) {
      body.heading = headings;
      body.heading_penalty = 300; // seconds: strong preference, not a hard block
    }
  }
  // Inject human-reviewed corrections (lessons from approved bug reports)
  // into the custom_model right before sending. Bridges Claude's intent
  // layer to GraphHopper's cost function — once an admin approves a
  // correction, every subsequent route applies it automatically. Each
  // rule_kind has its own dispatcher; escape_waypoint is handled upstream.
  if (body.custom_model && profileLearned.length) {
    applyAreaPenalties(body.custom_model, body.profile, profileLearned);
    applyEdgePenalties(body.custom_model, body.profile, profileLearned);
  }

  const callGH = async (b: any) => {
    return await fetch(`${GRAPHHOPPER_URL}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });
  };

  let res = await callGH(body);

  // Resilience pass: when GraphHopper rejects a request because a point is too
  // far from the routable graph (`PointNotFoundException` — happens routinely
  // when Google Places geocodes to a parking lot, trail head, or building
  // centroid that's 200m+ from any road), call /nearest to find the closest
  // road and retry. Bounded re-snap distance (600m) so we don't silently
  // teleport users to a road in the next county.
  if (!res.ok && res.status === 400) {
    const errBody = await res.clone().text();
    const pointMatch = errBody.match(/Cannot find point (\d+):/);
    if (pointMatch) {
      const idx = Number(pointMatch[1]);
      const orig = body.points[idx];
      if (orig) {
        try {
          const nearestRes = await fetch(`${GRAPHHOPPER_URL}/nearest?point=${orig[1]},${orig[0]}`);
          if (nearestRes.ok) {
            const nearest = await nearestRes.json();
            const snapDist = nearest?.distance ?? Infinity;
            const snappedLng = nearest?.coordinates?.[0];
            const snappedLat = nearest?.coordinates?.[1];
            if (snappedLng != null && snappedLat != null && snapDist <= 600) {
              console.log(`[getRoute] re-snapping point ${idx} from [${orig[0]},${orig[1]}] to [${snappedLng},${snappedLat}] (${snapDist.toFixed(0)}m off-road)`);
              body.points[idx] = [snappedLng, snappedLat];
              // Heading hints become invalid after re-snap; drop the one for the moved point.
              if (body.heading && body.heading[idx] != null) body.heading[idx] = -1;
              res = await callGH(body);
            } else {
              console.warn(`[getRoute] cannot re-snap point ${idx}: nearest road is ${snapDist.toFixed(0)}m away`);
            }
          }
        } catch (e: any) {
          console.warn('[getRoute] re-snap attempt failed:', e?.message);
        }
      }
    }
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GraphHopper error: ${res.status} ${err}`);
  }
  const data = await res.json();
  const path = data.paths?.[0];
  if (!path) throw new Error('GraphHopper returned no paths');
  const calibratedMs = calibrateDriveTimeMs(path);
  const rawMs = path.time ?? 0;
  if (rawMs > 0) {
    const ratio = (calibratedMs / rawMs).toFixed(2);
    console.log(`[getRoute] drive time: GH raw=${Math.round(rawMs/60000)}min → calibrated=${Math.round(calibratedMs/60000)}min (×${ratio})`);
  }
  return {
    distance_miles: Math.round((path.distance / 1609.34) * 10) / 10,
    time_minutes: Math.round(calibratedMs / 60000),
    raw_time_minutes: Math.round(rawMs / 60000),
    details: path.details || {},
    geometry: path.points, // GeoJSON LineString, points_encoded: false
    instructions: path.instructions || [],
  };
}

// ── Fetch routing lessons from approved bug reports (v2.20) ──────────────────
// Only fetches lessons that have been reviewed and approved by the admin.
// Uses proposed_lesson (Claude's curated version) not raw comment.
// Best-effort — empty string on any error, never blocks routing.
async function fetchRoutingLessons(): Promise<string> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/bug_reports?select=proposed_lesson,page_context,admin_notes&lesson_approved=eq.true&order=created_at.desc&limit=20`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      },
    );
    if (!res.ok) {
      console.warn('[fetchRoutingLessons] fetch failed:', res.status);
      return '';
    }
    const reports: any[] = await res.json();
    const valid = reports.filter((r) => r.proposed_lesson && r.proposed_lesson.trim().length > 10);
    if (valid.length === 0) return '';

    const lines = valid.map((r, i) => {
      // Admin notes (if any) are appended as context for Claude
      const notes = r.admin_notes ? ` [Admin note: ${r.admin_notes.trim()}]` : '';
      return `${i + 1}. ${r.proposed_lesson.trim()}${notes}`;
    }).join('\n');

    console.log(`[fetchRoutingLessons] injecting ${valid.length} approved lessons`);
    return `\n\n━━ ROUTING LESSONS FROM REVIEWED RIDER FEEDBACK ━━
These lessons were extracted from real rider complaints and reviewed by the TwoTired team.
Each one describes a specific routing mistake that actually happened. Do not repeat these patterns.

${lines}

Apply any relevant lessons to the current route before generating waypoints.`;
  } catch (e: any) {
    console.warn('[fetchRoutingLessons] error:', e.message);
    return '';
  }
}

// ── Road scoring (v2.45) ──────────────────────────────────────────────────────
// Queries the Molly score server with the route's GeoJSON geometry.
// Returns aggregate scores for the specific road segments the route passes through.
// Best-effort — returns null on any error, never blocks routing.
interface RouteScores {
  score_joy: number | null;
  score_transit: number | null;
  avg_curvature: number | null;
  avg_scenic: number | null;
  avg_elevation: number | null;
  avg_signals_per_km: number | null;
  segment_count: number;
}

async function fetchRouteScores(geometry: any): Promise<RouteScores | null> {
  if (!ROAD_SCORE_URL) return null;
  try {
    const res = await fetch(`${ROAD_SCORE_URL}/score-route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geometry }),
      signal: AbortSignal.timeout(20000), // 20s max — long routes (90+ mi) need 6-8s for ST_DWithin
    });
    if (!res.ok) {
      console.warn('[fetchRouteScores] score server error:', res.status);
      return null;
    }
    const data = await res.json();
    if (!data.score_joy) return null; // no scored segments found
    console.log(`[fetchRouteScores] joy=${data.score_joy} transit=${data.score_transit} segments=${data.segment_count}`);
    return data as RouteScores;
  } catch (e: any) {
    console.warn('[fetchRouteScores] error:', e.message);
    return null;
  }
}

// ── Claude intent parser (v2.10) ─────────────────────────────────────────────
// Claude is the route DIRECTOR. It plans the full journey including city escape.
// GraphHopper only connects the dots Claude specifies.
// Claude produces ONLY text (JSON). It never produces coordinates.
// Returns both the RouteRequest (for routing) and rawIntent (for conversational refinement).
async function parseIntent(query: string, lessons = ''): Promise<{ routeRequest: RouteRequest; rawIntent: any }> {
  const systemPrompt = `You are the route director for TwoTired, a motorcycle ride planning app.
You plan the complete journey — GraphHopper just connects your waypoints.

The rider's starting location is provided in the query as a [Rider GPS: lat, lng] tag.
If no GPS tag is present, assume the rider is starting from Astoria, Queens, NYC.

━━ ROUTING PHILOSOPHY ━━
GraphHopper routes between the points you give it using the motorcycle profile (curviness 1–3).
Your job is simple: give it the right destination, the right stops, and — for scenic
corridor routes — the right road_corridor name. The corridor system biases GH onto
the named road via geographic + road-class rules; you do NOT need to add waypoints
to "anchor" the route. Doing so causes the loops, spurs, and triangles around forced
visit points (see route 124: Goshen waypoint caused an interchange triangle).
Do NOT try to control which bridge GH crosses or how it exits the city either.

━━ INTERMEDIATE WAYPOINTS — WHEN AND HOW ━━
intermediate_waypoints are FORCED visit points: GH must pass through each, in order.
Use them ONLY when the rider explicitly named a place they want to ride to as part
of the journey (e.g. "ride to Bear Mountain, then to Cold Spring" — Bear Mountain
is an intermediate). Do NOT use them for:
  • Corridor anchoring — set road_corridor instead.
  • Boundary / city-exit waypoints (Fort Lee, New Brunswick, Goethals, GWB) — the
    routing pipeline handles NYC escape automatically.
  • "Real towns ON the named road" — the corridor zone already biases GH onto it.

RULE: For corridor routes (road_corridor is set), intermediate_waypoints MUST be []
unless the rider named a specific stop. Adding redundant corridor anchors creates
interchange triangles where the snap point is on a side street.

RULE: If the rider specified any stops (coffee, lunch, etc.), intermediate_waypoints: []
— let the stops anchor the route naturally.

━━ CURVINESS ━━
1 = direct/spirited: fastest non-highway, light motorway avoidance. Use when:
  - Destination is a city or urban area (Philadelphia, Trenton, Atlantic City, Newark, etc.)
  - The route is primarily transit (no scenic corridor exists between origin and destination)
  - User says "fastest", "quickest", or destination implies getting there efficiently
  Why: curviness 2-3 forces secondary/tertiary roads in NJ and PA which are saturated with traffic lights. For city routes, primary roads and highways are correct.
2 = scenic: secondary and tertiary roads. Default for rural/park destinations (Bear Mountain, Hawks Nest, Catskills, Hudson Valley, Delaware Water Gap, etc.).
3 = backroads/twisty: maximum. Use when rider says "twisty", "no traffic lights", "back roads", "no highways".

━━ EXPLICIT ROAD SPECIFICATION ("via [road]", "take [road]", "through [tunnel]") ━━
When a rider names a specific road, highway, bridge, or tunnel they want to use — in EITHER a fresh
query OR a refinement — apply these rules. This overrides any default corridor.

NOTE: If the rider names a specific bridge or tunnel (GWB, Verrazzano, Holland Tunnel, etc.),
acknowledge it in the reasoning but do NOT add it as a waypoint — GH will cross whatever bridge
makes sense for the motorcycle profile. Trying to force a specific bridge via waypoints causes loops.

── SCENIC / RURAL ROADS — road_corridor field ──
(9W, NY-97, NY-218, NY-28, NJ-94, NJ-23, Route 6, Route 44, Route 209, etc.)
→ "Via [road]" means FOLLOW that road. Set road_corridor to the road name.
→ The routing engine applies a corridor model (geographic + road-class rules)
  that biases GH onto the named road. NO waypoint anchoring needed.
→ intermediate_waypoints MUST be [] for corridor routes (unless the rider named
  an explicit stop). The corridor model is the anchor; redundant waypoints
  cause interchange triangles.
→ No escape_waypoint — the pipeline handles NYC city exit automatically.

Currently registered corridors (others fall back to default scenic routing):
  "9W"    — Hudson River west bank (Piermont, Nyack, Haverstraw, Bear Mountain, Cornwall, Newburgh)
  "NY-97" — Delaware River canyon (Hawks Nest, Sparrowbush, Port Jervis)
  "NY-28" — Catskills spine (Woodstock, Phoenicia, Margaretville)
  "NY-218" — Storm King Highway (Cornwall to West Point) — uses 9W corridor

Examples:
"take me to Hawks Nest via 9W"      → road_corridor: "9W",    intermediate_waypoints: [], destination: "Sparrowbush, NY"
"take me to Bear Mountain along 9W" → road_corridor: "9W",    intermediate_waypoints: [], destination: "Bear Mountain State Park, NY"
"go to Woodstock taking NY-28"      → road_corridor: "NY-28", intermediate_waypoints: [], destination: "Woodstock, NY"
"ride 9W to Newburgh"               → road_corridor: "9W",    intermediate_waypoints: [], destination: "Newburgh, NY"
"NY-97 to Hawks Nest, stop in Goshen for coffee"
                                    → road_corridor: "NY-97", stops: [{type:"coffee", area:"Goshen, NY"}],
                                      intermediate_waypoints: []   ← the stop is the anchor

━━ REFINEMENT INTERPRETATION ━━
When the query starts with "[Refining existing route —...]" you are modifying an existing route.
The bracket section describes the CURRENT route. Read it before applying the rider's feedback.

There are three and only three kinds of refinement. Identify which one applies:

CORRIDOR REPLACEMENT — rider names a road, highway, or route they want to travel:
  Trigger phrases: "take the [road]", "go via [road]", "ride [road]", "use [road]", "along the [road]"
  → DISCARD current road_corridor and current intermediate_waypoints entirely
  → Set the new road_corridor to the named road. Do NOT add waypoints to "anchor"
    the route — the corridor model is the anchor.
  → Keep destination, stops, curviness unchanged unless explicitly mentioned
  Example: current corridor "FAR_NORTH" with intermediates ["Harriman", "Middletown"],
    rider says "take the 9W to Newburgh":
    → road_corridor: "9W"
    → intermediate_waypoints: []
    → destination: "Newburgh, NY"
    → Do NOT add Nyack/Piermont/Bear Mountain/Cornwall — the 9W corridor model
      handles routing onto and along 9W.

STOP ADDITION — rider adds a specific place or category along the way:
  Trigger phrases: "add a [stop]", "stop at [place]", "find [thing] along the way", "with a [stop]"
  → Keep all existing intermediates and destination unchanged
  → Add the new stop to stops array at the logically correct position in the route

STYLE CHANGE — rider changes the character of the ride, not the places:
  Trigger phrases: "more twisty", "less highway", "faster", "take it easy", "avoid tolls"
  → Keep all existing waypoints, intermediates, destination, and stops unchanged
  → Only adjust curviness or other parameters

DESTINATION CHANGE — rider names a completely different destination unrelated to the current route:
  Trigger: feedback contains a new place name that clearly replaces the current destination
  (e.g. current: Bear Mountain, feedback: "take me to the Catskills" / "go to Hawks Nest instead")
  → Replace destination with the new place
  → Reset ALL stops and ALL intermediate_waypoints — they were positioned for the old destination
  → Keep curviness if it still makes sense, otherwise pick a sensible default
  → Do NOT carry over any stops from the old route

WHEN AMBIGUOUS: default to CORRIDOR REPLACEMENT. Riders think in roads, not waypoints.
Never stack intermediates from the old route on top of new ones — that creates impossible geometry.

━━ RIDER VOCABULARY — WHAT RIDERS ACTUALLY MEAN ━━
Riders name ROADS and EXPERIENCES, not tourist attractions or venues.
Interpret these before geocoding anything. These override generic Places results.

"Storm King" or "Storm King Highway"
  → destination: "Cornwall-on-Hudson, NY" (south end of NY-218)
  → road_corridor: "NY-218" (falls back to 9W corridor model until NY-218 is registered)
  → intermediate_waypoints: [] — corridor model is the anchor, no forced waypoints
  → NOT Storm King Art Center (a sculpture park — irrelevant to riders)
  WHY: NY-218 is a legendary cliff-side road. Narrow, technical, Hudson River 1000ft below. Every rider knows it.

"Hawks Nest" or "Hawks Nest overlook" or "Hawks Nest highway"
  → destination: "Sparrowbush, NY" — the hamlet directly at the NY-97 scenic overlook and switchbacks.
    NOT Port Jervis (that's miles past the overlook, in a city center).
    NOT a wildlife area or generic viewpoint.
  → road_corridor: "NY-97"
  → intermediate_waypoints: [] — the NY-97 corridor model anchors GH; no Goshen/Middletown forcing.

"The Gap" or "Water Gap"
  → destination: "Delaware Water Gap, PA"
  → use NORTHWEST corridor (GWB → Mahwah, NJ → NJ-23 → NJ-94)

"9W" or "Route 9W" or "riding 9W" or "via 9W" or "along 9W"
  → the road itself. User wants to FOLLOW 9W as a corridor.
  → destination: "Bear Mountain, NY" unless they say otherwise.
  → road_corridor: "9W", intermediate_waypoints: [] — the corridor model anchors GH onto 9W.

"Bear Mountain" or "Bear"
  → destination: "Bear Mountain State Park, NY"
  → No corridor needed — GH routes there naturally with motorcycle profile.
  → intermediate_waypoints: [] — let GH find the best path.

"The Gunks" or "Gunks" or "Shawangunks"
  → destination: "New Paltz, NY"
  → FAR NORTH corridor. The Shawangunk Ridge has dramatic cliff-top roads near Minnewaska State Park.

"Catskills" (no specific town)
  → destination: "Woodstock, NY" — gateway to NY-28 and the Catskill peaks
  → FAR NORTH corridor

"The Highlands" or "Hudson Highlands"
  → destination: "Cold Spring, NY" — heart of the Hudson Highlands
  → road_corridor: "9W", intermediate_waypoints: [] — corridor model handles 9W approach

"Palisades" (as destination, not corridor)
  → destination: "Bear Mountain, NY" via Palisades Pkwy
  → CLOSE NORTH corridor

"The Shore" or "Jersey Shore" (vague)
  → destination: "Asbury Park, NJ" as default unless specified
  → SOUTH corridor (Goethals → Freehold, NJ)

━━ KNOWN MOTORCYCLE ROUTES DATABASE ━━
These are real, well-known biker routes in the NYC region. Use this knowledge when the user asks
for recommendations, mentions a destination, or names a road. This is curated route quality data —
trust it over general mapping logic.

BEAR MOUNTAIN (most popular NYC-area moto destination):
  Best approach from NYC: 9W north from the GWB. Continuous, sweeping road with Hudson River views,
  no stop lights for long stretches, drama at the bridge approaches. 9W is the "correct" biker road.
  Palisades Pkwy approach: also excellent — ridge road, no trucks, no lights, but a parkway (motorway OSM class).
  Both converge at the Bear Mountain Bridge or at Perkins Memorial Drive.
  Avoid: 9W south of Alpine has more suburban traffic. Always escape city before engaging corridor.
  Avoid: Route 303, I-87, Route 17 — parallel roads with no character, just traffic.

HAWKS NEST / NY-97 (Delaware River canyon):
  The road: NY-97 from Port Jervis north to Narrowsburg / Pond Eddy area.
  The famous section: "Hawks Nest" — 2 miles of tight switchbacks carved into cliffs directly above
  the Delaware River gorge, just north of Sparrow Bush. Like an eastern version of Angeles Crest.
  Continuation: after Hawks Nest, NY-97 opens into 18+ miles of sweeping curves north along the river.
  Best approach from NYC: GWB → Harriman (NY-17 west) → Middletown → Sparrow Bush / Port Jervis area.
  OSM road class: SECONDARY. US-6 (PRIMARY) runs north of the canyon — routing must penalize PRIMARY
  in the corridor or GraphHopper takes the boring shortcut.
  Why riders go: cliff-face road, no guardrails in places, tight blind corners, dramatic river views.
  Best stop: Barryville, NY area for gas. The road has limited services once you're in the canyon.

NY-28 / CATSKILLS SPINE:
  The road: NY-28 from Kingston west through Woodstock → Phonecia → Shandaken → Margaretville → Delhi.
  Character: long, flowing mountain sweepers through the Catskill high peaks. Less technical than Hawks Nest,
  more about sustained rhythm and mountain scenery.
  Famous stop: Phoenicia Diner (Phoenicia, NY) — legendary biker gathering spot, excellent food.
  The "Catskill loop" classic: NY-28 west, then NY-30 north, then back via NY-23 or return on 28.
  Best approach: Harriman → NY-17W → Catskill area OR 9W north → Kingston → NY-28 west.
  OSM road class: SECONDARY. Competing roads: I-87 (Thruway, motorway) on the east, US-209 south.
  Corridor logic must penalize PRIMARY/TRUNK inside the Catskills to prevent shortcuts.

NY-218 / STORM KING HIGHWAY:
  The road: NY-218 from Vails Gate north to Cornwall-on-Hudson, along the Hudson.
  Character: narrow, cliff-hugging, dramatic Hudson River views. Originally blasted from solid rock.
  Technical riding: tight corners, some blind curves, 1.5 lanes in places. Not for beginners.
  Context: often combined with 9W — Storm King is the dramatic final push to West Point / Cold Spring area.
  Avoid on weekends (tourist foot traffic near Storm King Art Center).

NJ-94 / NJ HIGHLANDS (High Point, Delaware Water Gap):
  Best roads: NJ-94 north from Vernon, NJ-23 northwest. Farmland, rolling hills, open views.
  Delaware Water Gap: approach via I-80 to Blairstown area, then Old Mine Road for riverside riding.
  Character: more open and agricultural vs the Hudson Valley. Better in spring/fall for foliage.

NJ-29 / DELAWARE RIVER ROAD (Milford, Frenchtown, Lambertville):
  The road: NJ-29 south from Milford along the Delaware River.
  Character: flat river road, charming towns every 10 miles, antique shops, good lunch stops.
  Milford, Frenchtown, Stockton, New Hope (PA side), Lambertville: all classic biker towns.
  Approach from NYC: GWB → Mahwah → US-202 west → Milford.
  Good day trip loop: ride out via Mahwah/Highlands, ride south on NJ-29, return via I-78.

GENERAL QUALITY RULES (what makes a great motorcycle road):
  ✓ Long stretches without stop lights or stop signs
  ✓ Continuous flowing curves — not zigzag intersections
  ✓ Primary or secondary roads — NOT residential streets or local roads
  ✓ Dramatic scenery: river, mountain, cliff, ridge
  ✗ Neighborhood streets: stop signs every block, low speed limits, no flow
  ✗ Parallel interstates: fast but soul-crushing
  ✗ Zigzag through towns when a bypass exists

━━ PREFERRED ROAD CORRIDORS ━━
These are the signature motorcycle roads for each destination type. When the user explicitly
names one of these roads, output road_corridor (NOT intermediate_waypoints — those create detours).

US-9W — Hudson River west bank (Bear Mountain, Storm King, West Point, Cold Spring, Newburgh):
  When user says "via 9W", "take 9W", "along 9W", "ride 9W":
    → road_corridor: "9W"
    → intermediate_waypoints: []   ← corridor model anchors GH onto 9W; no waypoints needed
  Character: primary road hugging the Hudson's west bank, dramatic river views, sweeping curves.

PALISADES INTERSTATE PKWY — ridge road above Hudson (NJ side, Bear Mountain approach):
  Default Bear Mountain approach (no "9W" mention) — no corridor needed, GH handles naturally.
  No trucks. Spectacular ridge road. GraphHopper avoids Palisades motorway via Palisades zone model.

NY-97 / HAWKS NEST — Delaware River canyon switchbacks:
  When user says "via NY-97", "take 97", "Hawks Nest", "Hawks Nest via 97", "the canyon road":
    → road_corridor: "NY-97"
    → intermediate_waypoints: []   ← the corridor zone is the anchor (no Goshen forcing → no triangle)
  Character: switchbacks carved into cliff face above the Delaware River gorge. One of the best roads in the Northeast.
  Road class: SECONDARY (NY state route). Corridor logic penalizes PRIMARY/TRUNK so NY-97 wins over US-6.

NY-218 — Storm King Highway (Cornwall, West Point approach):
  When user says "Storm King Highway", "Storm King", or "via 218":
    → road_corridor: "NY-218"
    → intermediate_waypoints: []
    → destination: "Cornwall-on-Hudson, NY"
  Character: narrow cliff-side road above the Hudson. Technical riding, historically significant.

NY-28 — Catskills spine (Woodstock, Phoenicia, Margaretville, Delhi):
  When user says "via NY-28", "take 28", "NY-28 to Woodstock", "Catskills", "Phoenicia":
    → road_corridor: "NY-28"
    → intermediate_waypoints: []
  Character: wide mountain sweepers through Catskill peaks. Flowing rhythm, great scenery.

NJ-94 / NJ-23 — NJ Highlands backroads (High Point, Delaware Water Gap from NJ):
  No road_corridor registered for these yet; let GH route naturally with curviness 2.
  intermediate_waypoints: [] — do NOT force "Mahwah, NJ" or similar anchors.

NJ Route 29 — Delaware River road (Milford NJ, Frenchtown, Lambertville):
  No road_corridor registered yet; let GH route naturally with curviness 2.
  intermediate_waypoints: [] — do NOT force a "Milford, NJ" anchor.

━━ STOPS ━━
Only add stops the rider explicitly requests. Never invent them.
near: a specific town or area name (not coordinates).
radius_km: 4 for specific towns (tight — prevents results crossing rivers or mountains to the wrong side), 12 for general areas ("somewhere in the Catskills").

━━ WHEN TO CLARIFY ━━
If the request is genuinely ambiguous — two valid interpretations that produce meaningfully different routes — output a clarification request INSTEAD of a route.

Clarify when:
- Destination could be two very different places ("the shore" = Jersey Shore vs. Connecticut shore?)
- A refinement conflicts with the current route direction ("go via the Gap" on a northbound Hawks Nest route — that's southwest, contradicts the plan)
- Rider names a road but it's unclear which section or direction ("take Route 22" — heading where, how far?)

Do NOT clarify when:
- RIDER VOCABULARY has a clear mapping — use it, don't second-guess
- Request is vague but a sensible default exists — pick the default
- It's a style change (more twisty, faster, etc.)
- The conversation context already answers the ambiguity

Keep clarifications short. Max 2–3 options. No over-explaining.

${lessons}

━━ OUTPUT FORMAT ━━
Respond ONLY with valid JSON, no markdown, no explanation.

Route response — standard (no corridor):
{
  "origin": "Rider GPS location or named place if no GPS provided",
  "intermediate_waypoints": [],
  "stops": [{ "type": "coffee shop", "near": "town name, State", "radius_km": 15 }],
  "destination": "Town or Park Name, State",
  "curviness": 2,
  "round_trip": false,
  "reasoning": "one sentence: why this route"
}

round_trip RULE: Set to true ONLY if the rider explicitly says "round trip", "loop", "there and back",
"return home", "circle back", or "come back the same way". Default is ALWAYS false.
A scenic ride to a destination is NOT assumed to be a loop. Most riders end at the destination
and plan their own return. Never infer a round trip from the nature of the destination.

Route response — named road corridor:
{
  "origin": "Rider GPS location or named place if no GPS provided",
  "road_corridor": "9W",
  "intermediate_waypoints": [],
  "stops": [],
  "destination": "Bear Mountain State Park, NY",
  "curviness": 2,
  "round_trip": false,
  "reasoning": "rider asked for 9W — corridor model anchors GH onto 9W; no waypoints needed"
}

IMPORTANT: Never include escape_waypoint or escape_via_waypoints — those fields no longer exist.
ALWAYS set intermediate_waypoints: [] when road_corridor is set (unless the rider named an
explicit stop). The corridor model is the anchor; redundant waypoints cause interchange triangles.

Clarification response (only when genuinely ambiguous per rules above):
{
  "clarify": true,
  "question": "Short question to the rider — one sentence",
  "options": ["Option A", "Option B"]
}

CRITICAL: Always include the US state abbreviation in destination and stops.near.
Examples: "Hawks Nest, NY" not "Hawks Nest". "Middletown, NY" not "Middletown".
Ambiguous place names (Hawks Nest, Liberty, Chester, Monroe, etc.) exist in many states — the geocoder needs the state to find the right one.`;

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: query }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude intent parse failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  const text: string = data.content?.[0]?.text || '';
  console.log('[parseIntent] Claude raw:', text);

  // Extract JSON from response (handles any stray whitespace or markdown fences)
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`Claude returned no JSON: ${text}`);
  const intent = JSON.parse(text.slice(start, end + 1));

  // Clarification response — Claude isn't sure, needs rider input
  if (intent.clarify === true) {
    console.log('[parseIntent] clarification requested:', intent.question);
    return { clarify: true as const, question: intent.question as string, options: (intent.options || []) as string[] };
  }

  console.log('[parseIntent] reasoning:', intent.reasoning);

  const routeRequest: RouteRequest = {
    origin: { query: intent.origin || 'Astoria, Queens, NY' },
    destination: { query: intent.destination },
    stops: (intent.stops || []).map((s: any) => ({
      type: s.type,
      near: { query: s.near },
      radius_km: s.radius_km ?? 15,
    })),
    curviness: (intent.curviness as 1 | 2 | 3) || 2,
    round_trip: intent.round_trip || false,
    intermediate_waypoints: intent.intermediate_waypoints || [],
    road_corridor: intent.road_corridor || undefined,
  };

  return { routeRequest, rawIntent: intent };
}

// ── Conversational refinement ─────────────────────────────────────────────────
// When a rider wants to change something about a generated route, we build a
// compound query that describes the current route and the rider's feedback, then
// run it through parseIntent so all routing rules and vocabulary apply automatically.
// Key design: label current corridor clearly as replaceable so Claude knows to
// DISCARD it (not stack onto it) when the rider names a new road.
async function buildRefineQuery(feedback: string, rawIntent: any): Promise<string> {
  const parts = [
    rawIntent.destination && `destination: ${rawIntent.destination}`,
    rawIntent.road_corridor
      ? `current road corridor (replaceable): ${rawIntent.road_corridor}`
      : null,
    rawIntent.intermediate_waypoints?.length
      ? `current corridor intermediates (replaceable): [${rawIntent.intermediate_waypoints.join(', ')}]`
      : null,
    rawIntent.stops?.length && `current stops (keep unless changed): ${rawIntent.stops.map((s: any) => `${s.type} near ${s.near}`).join(', ')}`,
    rawIntent.curviness && `current curviness (keep unless changed): ${rawIntent.curviness}`,
    // NOTE: round_trip intentionally omitted — never carry it over from previous intent.
    // Claude evaluates it fresh from the rider's current message only.
  ].filter(Boolean);

  return `[Refining existing route — ${parts.join(' | ')}] Rider feedback: "${feedback}". Identify whether this is a CORRIDOR REPLACEMENT, STOP ADDITION, or STYLE CHANGE per the REFINEMENT INTERPRETATION rules, then apply only that change.`;
}

// ── Claude Haiku 4.5 ride narrative (v2.3) ───────────────────────────────────
// Generates a 2–3 paragraph human-readable ride description from GraphHopper
// turn-by-turn instructions. Haiku keeps latency low (~1s). Claude produces
// ONLY text — never coordinates or structured data.
async function generateNarrative(
  instructions: any[],
  stops: any[],
  distanceMiles: number,
  timeMinutes: number,
  query: string,
  scores?: RouteScores | null,
): Promise<string> {
  // Distill instructions to road names only — drop intervals/distances to save tokens
  const roadSteps = instructions
    .map((i: any) => i.text)
    .filter((t: string) => t && !t.toLowerCase().startsWith('arrive'))
    .slice(0, 30); // cap at 30 steps

  const stopNames = stops.map(s => `${s.name} (${s.address})`).join(', ') || 'none';
  const hours = Math.floor(timeMinutes / 60);
  const mins = timeMinutes % 60;
  const durationStr = hours > 0 ? `${hours}h ${mins}min` : `${mins}min`;

  const scoreHint = scores?.score_joy != null
    ? `\nRoad quality scores (from live road database, based on the specific segments this route uses):
  Joy score: ${scores.score_joy}/5.0 (curvature, scenery, low signals, elevation)
  Transit score: ${scores.score_transit}/5.0 (flow, speed, efficiency)
  Avg curvature: ${scores.avg_curvature} | Scenic: ${(scores.avg_scenic! * 100).toFixed(0)}% scenic proximity | Signals: ${scores.avg_signals_per_km}/km
Use these scores to add one specific sentence about the road character — e.g. high curvature = "expect tight technical bends", high scenic = "forest and river views throughout", low signals = "barely a traffic light for 40 miles". Don't list the numbers directly.`
    : '';

  const userMessage = `Ride request: "${query}"
Distance: ${distanceMiles} miles | Duration: ${durationStr}
Stops: ${stopNames}${scoreHint}
Turn-by-turn (abbreviated):
${roadSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;

  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: `You are a motorcycle ride storyteller for TwoTired, a ride planning app focused on the Hudson Valley and Northeast US.
Given a ride's turn-by-turn directions and metadata, write a vivid 2–3 paragraph description of the route as if briefing a rider before they leave.

Rules:
- Write in second person ("You'll", "The route takes you")
- Mention specific road names and towns from the directions — but NEVER any coordinates or GPS numbers
- Describe the character of the riding: twisty river roads, ridge views, open farmland, etc.
- If there are stops, weave them naturally into the narrative
- Keep it under 200 words — evocative but tight
- No lists, no headers — flowing prose only`,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!res.ok) {
    console.error('[generateNarrative] Haiku error:', res.status, await res.text());
    return ''; // narrative is best-effort — never fail the whole request
  }

  const data = await res.json();
  // Strip any leading markdown title Haiku may add despite instructions
  return (data.content?.[0]?.text?.trim() || '').replace(/^#[^\n]*\n+/, '').trim();
}

// ── Merge two GraphHopper legs into one route (v2.4) ─────────────────────────
// Used for two-phase routing: escape leg (curviness=1) + scenic leg (curviness=N)
function mergeRoutes(leg1: any, leg2: any): any {
  // Concatenate coordinates — skip first point of leg2 (duplicate of leg1's last point)
  const coords1: number[][] = leg1.geometry.coordinates;
  const coords2: number[][] = leg2.geometry.coordinates.slice(1);
  return {
    distance_miles: Math.round((leg1.distance_miles + leg2.distance_miles) * 10) / 10,
    time_minutes: leg1.time_minutes + leg2.time_minutes,
    raw_time_minutes: (leg1.raw_time_minutes ?? 0) + (leg2.raw_time_minutes ?? 0),
    geometry: { type: 'LineString', coordinates: [...coords1, ...coords2] },
    instructions: [...leg1.instructions, ...leg2.instructions],
  };
}

// ── NYC 5-borough boundary check ──────────────────────────────────────────────
// Returns true if the point is inside the approximate bounding box of all 5 NYC boroughs.
// Manhattan, Brooklyn, Queens, Bronx, Staten Island are all "the city" for routing purposes.
// Used to trigger two-phase routing: car profile (highway-preferring) to the first boundary
// intermediate, then motorcycle profile for the scenic leg beyond the city.
// Why: GH motorcycle profile penalises motorways but also deprioritises TRUNK/PRIMARY slightly,
// so from Queens it routes via Queensboro Bridge → Manhattan surface streets → GWB instead
// of via the Bronx expressways → GWB. Car profile has no scenic penalties → picks highways.
function isInNYC(ll: LatLng): boolean {
  // Bounding box covers all 5 boroughs with a small margin.
  // Eastern limit -73.70 clips to just past JFK; western -74.27 covers western SI tip.
  return ll.lat >= 40.49 && ll.lat <= 40.92 && ll.lng >= -74.27 && ll.lng <= -73.70;
}

// ── Pipeline logger (v2.45) ───────────────────────────────────────────────────
// Writes a full trace of every route generation to route_logs table.
// Best-effort — never throws, never blocks the response.
async function logPipeline(record: Record<string, any>): Promise<void> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/route_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(record),
    });
    if (!res.ok) console.warn('[logPipeline] insert failed:', res.status);
  } catch (e: any) {
    console.warn('[logPipeline] error:', e.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (!GRAPHHOPPER_URL || !GOOGLE_PLACES_KEY) {
    return new Response(JSON.stringify({ error: 'Missing required secrets: GRAPHHOPPER_URL, GOOGLE_PLACES_KEY' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const requestStart = Date.now();
  const log: Record<string, any> = {}; // pipeline trace — populated throughout

  try {
    const rawBody = await req.json();

    // v2.5: ensure routing areas are loaded (no-op on warm invocations)
    await _areasPromise;

    // v2.19: fetch routing lessons from bug reports in parallel with body parse
    const lessonsPromise = fetchRoutingLessons();

    // v2.17: extract rider GPS if provided by client
    const userLat: number | undefined = typeof rawBody.userLat === 'number' ? rawBody.userLat : undefined;
    const userLng: number | undefined = typeof rawBody.userLng === 'number' ? rawBody.userLng : undefined;
    const gpsTag = userLat !== undefined ? ` [Rider GPS: ${userLat.toFixed(5)}, ${userLng!.toFixed(5)}]` : '';
    if (gpsTag) console.log('[generate-route] rider GPS:', userLat, userLng);

    log.query = typeof rawBody.query === 'string' ? rawBody.query : null;
    log.user_lat = userLat ?? null;
    log.user_lng = userLng ?? null;

    // v2.10: detect mode — new query, refinement, or raw RouteRequest
    let body: RouteRequest;
    let rawIntent: any = null;

    const parseStart = Date.now();
    if (rawBody.refine === true && rawBody.intent && typeof rawBody.feedback === 'string') {
      console.log('[generate-route] refine mode, feedback:', rawBody.feedback);
      log.query = `[refine] ${rawBody.feedback}`;
      const refineQuery = await buildRefineQuery(rawBody.feedback, rawBody.intent);
      const parsed = await parseIntent(refineQuery + gpsTag, await lessonsPromise);
      if ('clarify' in parsed) {
        return new Response(JSON.stringify({ success: true, clarify: true, question: parsed.question, options: parsed.options }), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
      body = parsed.routeRequest;
      rawIntent = parsed.rawIntent;
    } else if (typeof rawBody.query === 'string' && rawBody.query.trim()) {
      console.log('[generate-route] natural language query:', rawBody.query);
      const parsed = await parseIntent(rawBody.query + gpsTag, await lessonsPromise);
      if ('clarify' in parsed) {
        return new Response(JSON.stringify({ success: true, clarify: true, question: parsed.question, options: parsed.options }), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        });
      }
      body = parsed.routeRequest;
      rawIntent = parsed.rawIntent;
      console.log('[generate-route] parsed intent:', JSON.stringify(rawIntent));
    } else {
      body = rawBody as RouteRequest;
    }
    log.parse_ms = Date.now() - parseStart;
    log.raw_intent = rawIntent;

    // Override origin with actual GPS coords
    if (userLat !== undefined) {
      body.origin = { lat: userLat, lng: userLng! };
    }

    if (!body.origin || !body.destination) {
      return new Response(JSON.stringify({ error: 'origin and destination are required' }), {
        status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // Resolve origin + destination in parallel
    const [originLL, destinationLL] = await Promise.all([
      resolveLocation(body.origin),
      resolveLocation(body.destination),
    ]);
    console.log('[generate-route] origin:', JSON.stringify(originLL), 'dest:', JSON.stringify(destinationLL));

    log.resolved_origin = {
      ...originLL,
      source: userLat !== undefined ? 'gps' : ('lat' in body.origin ? 'coords' : 'places'),
    };
    log.resolved_dest = {
      ...destinationLL,
      query: 'query' in body.destination ? body.destination.query : null,
      source: 'lat' in body.destination ? 'coords' : 'places',
    };

    // Resolve intermediate waypoints
    const intermediateWPs: LatLng[] = [];
    const resolvedWaypoints: any[] = [];
    for (const wp of (body.intermediate_waypoints || [])) {
      const hardcoded = lookupWaypoint(wp);
      const ll = hardcoded ?? await geocode(wp);
      intermediateWPs.push(ll);
      resolvedWaypoints.push({ name: wp, ...ll, source: hardcoded ? 'hardcoded' : 'places' });
    }
    log.resolved_waypoints = resolvedWaypoints;
    if (intermediateWPs.length) console.log('[generate-route] intermediates:', JSON.stringify(intermediateWPs));

    // Find POI stops
    const stops: any[] = [];
    if (body.stops?.length) {
      for (const stop of body.stops) {
        const nearLL = await resolveLocation(stop.near);
        const poi = await findPOI(stop.type, nearLL, stop.radius_km ?? 15);
        if (poi) stops.push({ ...poi, type: stop.type });
      }
    }
    log.resolved_stops = stops.map(s => ({ name: s.name, lat: s.lat, lng: s.lng, type: s.type }));

    // Build waypoint chain
    const stopLLs: LatLng[] = stops.map(s => ({ lat: s.lat, lng: s.lng }));
    const curviness = (body.curviness ?? 2) as 1 | 2 | 3;
    const variant   = (body.variant   ?? 'classic') as 'classic' | 'scoring';
    const corridor = body.road_corridor || undefined;

    let route: any;
    let allWaypoints: LatLng[];

    // Fetch learned corrections once per request — getRoute() also calls
    // getLearnedCorrections() but its 30s cache makes the second call free.
    // We need them here so pickExitPoint can apply any escape_waypoint rules.
    const reqCorrections = await getLearnedCorrections();

    // ── City-exit point selection ─────────────────────────────────────────────
    // v2.56: re-introduce two-phase routing for NYC origins with curviness 2/3.
    //
    // Root cause of v2.54 regression: buildCurvinessModel(2) and (3) include
    // MOTORWAY: 0.1 penalty to keep GH on scenic roads. Correct for the Hudson Valley
    // leg — but the same penalty hits the GWB (a motorway) on the Queens→GWB approach,
    // causing GH to route via Manhattan surface streets or convoluted non-highway paths.
    //
    // Fix: when origin is in NYC AND curviness >= 2, use car profile (curviness 0,
    // no motorway penalty) for the first leg to the exit point, then merge with the
    // scenic profile for the rest. Curviness 1 (transit) has no motorway penalty → fine.
    //
    // Exit point priority:
    //   1. Learned escape_waypoint rule matching origin + bearing + (optional) dest bbox
    //   2. First intermediate waypoint (already the "on-ramp" to the corridor)
    //   3. Bearing-based fallback: Alpine NJ (GWB, north/NW/W) or Goethals (SW)
    //   4. Destination is east (Long Island) → no exit needed, single-phase fine
    function pickExitPoint(): LatLng | null {
      // Two-phase exists to handle curviness 2/3's MOTORWAY penalty (which would
      // otherwise prevent the route from using GWB/Goethals etc. on the city-exit
      // leg). Curviness 1 has no motorway penalty, so a single-leg route from
      // NYC naturally uses highways — provided GH's cost model accurately
      // penalises Manhattan-grid transit. That penalisation comes from the
      // edge_penalty rules in learned_corrections (Queensboro / Williamsburg /
      // Manhattan / Brooklyn Bridge / Holland / Lincoln / Brooklyn-Battery).
      // Without those rules active, expect SW routes from Queens/Brooklyn to
      // cut through Manhattan — that's the Molly Phase 2 work, not a code bug.
      if (!isInNYC(originLL) || curviness < 2) return null;
      const override = getEscapeOverride(originLL, destinationLL, reqCorrections);
      if (override) return override;
      if (intermediateWPs.length > 0) return intermediateWPs[0];
      // No intermediates — pick based on destination direction
      const destLng = destinationLL.lng;
      if (destLng > -73.80) return null; // Long Island — no bridge exit needed
      const bearing = bearingDegrees(originLL, destinationLL);
      // SW (Jersey Shore, Philly, South NJ): Goethals Bridge.
      // For Queens/Brooklyn origins this only routes via Verrazano-SI when the
      // edge_penalty rules on Manhattan crossings are active — otherwise GH
      // finds Manhattan→Holland Tunnel→NJ Turnpike→Goethals (route 135). Verifying
      // that penalisation is the "Phase 2 / Manhattan-crossing edge_penalty" work.
      if (bearing > 150 && bearing < 270) return KNOWN_WAYPOINTS['goethals bridge, staten island, ny'];
      // North / NW / W (Hudson Valley, Catskills, Bear Mountain): GWB via upper-Manhattan approach.
      // Using the Trans-Manhattan Expy on-ramp rather than Alpine NJ (NJ side) so that GH
      // routes Queens/Brooklyn traffic via Triborough Bridge → Harlem → GWB, not through midtown.
      return KNOWN_WAYPOINTS['gwb ny approach'];
    }

    const routeStart = Date.now();
    allWaypoints = [originLL, ...intermediateWPs, ...stopLLs, destinationLL];
    if (body.round_trip) allWaypoints.push(originLL);

    if (variant === 'scoring' && curviness >= 2) {
      // ── Score-only variant: single GH call, no exit waypoint, no two-phase ──
      // Joy area weights handle everything: tier_c repels GH from urban zones
      // (it exits via fastest road), tier_a keeps it on scenic roads beyond.
      console.log('[generate-route] variant=scoring, single-phase score model');
      const scoringModel = buildScoringModel(curviness as 2 | 3);
      if (corridor) {
        const corridorModel = await buildCorridorModel(corridor, curviness);
        const overallBearing = Math.round(bearingDegrees(originLL, destinationLL));
        const headings = allWaypoints.map((_, i) =>
          (i === 0 || i === allWaypoints.length - 1) ? -1 : overallBearing
        );
        route = await getRoute(allWaypoints, curviness, headings, scoringModel);
      } else {
        route = await getRoute(allWaypoints, curviness, undefined, scoringModel);
      }
    } else {
      // ── Classic variant: existing two-phase pickExitPoint logic ──────────────
      const exitPoint = pickExitPoint();

      if (exitPoint) {
        // Two-phase: car profile city exit → scenic profile from exit onward
        const remainingIntermediates = intermediateWPs.length > 0 ? intermediateWPs.slice(1) : [];
        const scenicPoints = [exitPoint, ...remainingIntermediates, ...stopLLs, destinationLL];
        if (body.round_trip) scenicPoints.push(originLL);

        console.log('[generate-route] two-phase: car escape to', JSON.stringify(exitPoint), '→ scenic from there');

        // headings=[-1,-1] disables GH's default U-turn-avoidance on the snap:
        // without it, an origin that snaps to (say) an eastbound GCP service road forces
        // the route to drive east to the next intersection before it can head back NW,
        // producing the Astoria loop seen in route 123.
        const escapeLegPromise = getRoute([originLL, exitPoint], 0, [-1, -1]); // car profile — no motorway penalty

        let scenicLegPromise: Promise<any>;
        if (corridor) {
          const corridorModel = await buildCorridorModel(corridor, curviness);
          const overallBearing = Math.round(bearingDegrees(exitPoint, destinationLL));
          const headings = scenicPoints.map((_, i) =>
            (i === 0 || i === scenicPoints.length - 1) ? -1 : overallBearing
          );
          scenicLegPromise = getRoute(scenicPoints, curviness, headings, corridorModel);
        } else {
          scenicLegPromise = getRoute(scenicPoints, curviness);
        }

        const [escapeLeg, scenicLeg] = await Promise.all([escapeLegPromise, scenicLegPromise]);
        route = mergeRoutes(escapeLeg, scenicLeg);
      } else if (corridor) {
        const corridorModel = await buildCorridorModel(corridor, curviness);
        const overallBearing = Math.round(bearingDegrees(originLL, destinationLL));
        const headings = allWaypoints.map((_, i) =>
          (i === 0 || i === allWaypoints.length - 1) ? -1 : overallBearing
        );
        route = await getRoute(allWaypoints, curviness, headings, corridorModel);
      } else {
        route = await getRoute(allWaypoints, curviness);
      }
    }
    log.route_ms = Date.now() - routeStart;
    log.routing_config = {
      profile: 'twotired',
      curviness,
      variant,
      corridor: corridor ?? null,
      waypoint_count: allWaypoints.length,
    };
    log.route_result = { distance_miles: route.distance_miles, time_minutes: route.time_minutes };
    // v2.53: store simplified geometry (≤100 pts) for Route Debug map in admin portal
    if (route.geometry?.coordinates?.length > 1) {
      const coords: [number, number][] = route.geometry.coordinates;
      const step = Math.ceil(coords.length / 100);
      const sampled = coords.filter((_: any, i: number) => i % step === 0);
      if (sampled[sampled.length - 1] !== coords[coords.length - 1]) sampled.push(coords[coords.length - 1]);
      log.route_geometry = { type: 'LineString', coordinates: sampled };
    }

    const destName = 'query' in body.destination ? body.destination.query : `${destinationLL.lat},${destinationLL.lng}`;
    const originalQuery = typeof (rawBody as any).query === 'string'
      ? (rawBody as any).query
      : ('query' in body.destination ? body.destination.query : 'route');

    // Scores + narrative in parallel
    const scoreStart = Date.now();
    const scoresPromise = fetchRouteScores(route.geometry);
    const narrativePromise = scoresPromise.then(scores => {
      log.score_ms = Date.now() - scoreStart;
      log.road_scores = scores;
      const narrativeStart = Date.now();
      return generateNarrative(route.instructions, stops, route.distance_miles, route.time_minutes, originalQuery, scores)
        .then(n => { log.narrative_ms = Date.now() - narrativeStart; return n; });
    });

    // v2.57: ETA breakdown — drive (calibrated) + stop dwell time = total trip duration
    const driveMinutes = route.time_minutes;
    const stopMinutes = stops.reduce((sum, s) => sum + dwellMinutesForStop(s.type || ''), 0);
    const totalMinutes = driveMinutes + stopMinutes;
    const fmtDur = (m: number) => {
      const h = Math.floor(m / 60), mm = m % 60;
      return h > 0 ? `${h}h ${mm}m` : `${mm}m`;
    };

    // Save route to Supabase (best-effort)
    try {
      const record = {
        title: `Route to ${destName}`,
        destination: destName,
        duration_str: fmtDur(totalMinutes),
        distance_mi: route.distance_miles,
        waypoints: allWaypoints,
        geojson: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: route.geometry, properties: {} }] },
        segments: [],
        group_name: 'AI Generated',
        is_stale: false,
        community_score: 0,
      };
      const dbRes = await fetch(`${SUPABASE_URL}/rest/v1/routes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify(record),
      });
      if (!dbRes.ok) console.error('[generate-route] DB insert failed:', dbRes.status);
    } catch (dbErr: any) {
      console.error('[generate-route] DB insert exception:', dbErr.message);
    }

    const [narrative, scores] = await Promise.all([narrativePromise, scoresPromise]);
    log.narrative = narrative;
    log.total_ms = Date.now() - requestStart;

    log.eta_breakdown = {
      drive_minutes: driveMinutes,
      raw_gh_minutes: route.raw_time_minutes ?? null,
      stop_minutes: stopMinutes,
      total_minutes: totalMinutes,
    };

    // Write pipeline log (fire and forget)
    logPipeline(log);

    return new Response(JSON.stringify({ success: true, route: {
      ...route,
      waypoints: allWaypoints,
      stops,
      destination: destName,
      title: `Route to ${destName}`,
      // v2.57: ETA breakdown — clients can render the full picture or fall back to duration_str
      drive_minutes: driveMinutes,
      stop_minutes: stopMinutes,
      total_minutes: totalMinutes,
      duration_str: fmtDur(totalMinutes),
      drive_duration_str: fmtDur(driveMinutes),
      stop_duration_str: stopMinutes > 0 ? fmtDur(stopMinutes) : null,
      distance_mi: route.distance_miles,
      intent: rawIntent,
      narrative,
      road_scores: scores ?? undefined,
    } }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[generate-route] error:', err.message);
    log.error = err.message;
    log.total_ms = Date.now() - requestStart;
    logPipeline(log);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
