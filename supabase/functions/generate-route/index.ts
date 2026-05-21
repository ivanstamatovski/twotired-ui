// generate-route edge function — v2.45
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
  intermediate_waypoints?: string[]; // Named places along the corridor to anchor GH on the right road
  road_corridor?: string;            // Named road to follow (e.g. "9W", "NY-97", "NY-28").
                                     // When set: corridor custom_model biases GH to stay on that road.
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

// ── Route 17 / parallel-roads primary exclusion zone ──────────────────────────
// v2.35: Both 9W and Route 17 are PRIMARY roads in OSM. The main corridor zone penalizes
// secondary/tertiary, but when two primaries exist GraphHopper picks the shorter one.
// Within this zone: PRIMARY and TRUNK are penalized an additional 0.1×.
//
// v2.36: Stepped polygon — east edge extended to -73.95 in the Sparkill/Orangeburg band
// (lat 40.90–41.10) to capture Route 303 / Palisades Pkwy connectors that run at
// lng -73.97–74.00 and were previously east of the old -74.03 edge (i.e., unpenalized).
// 9W at Sparkill sits at lng -73.931 — east of the -73.95 edge, unaffected.
// At lat 41.10 the east edge steps back to -74.03 (9W curves west to -73.94 by that lat,
// still safely east of both edges).
//
//   Route 17 (primary, inside zone):             0.7 × 0.1 = 0.07× — ruled out
//   Route 303 / Palisades ramps (south section): 0.7 × 0.1 = 0.07× — ruled out
//   9W (primary, outside zone throughout):       0.7×           — unchanged, wins
const NINE_W_ROUTE17_EXCL_AREA = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    id: 'nine_w_route17_excl',
    properties: {},
    geometry: {
      type: 'Polygon',
      // Stepped polygon:
      // South (lat 40.90–41.10): W -74.25 → E -73.95  (wider — covers Sparkill parallel roads)
      // North (lat 41.10–41.35): W -74.25 → E -74.03  (original — 9W curves west here, keep clear)
      coordinates: [[
        [-74.25, 40.90],
        [-73.95, 40.90],
        [-73.95, 41.10],
        [-74.03, 41.10],
        [-74.03, 41.35],
        [-74.25, 41.35],
        [-74.25, 40.90],
      ]],
    },
  }],
};

// ── NY-97 / Delaware River Canyon corridor area ───────────────────────────────
// NY-97 is a NY state highway — SECONDARY in OSM. Hawks Nest switchbacks are 2 miles
// north of Sparrow Bush: tight cliff-face bends above the Delaware gorge, then 18 miles
// of sweeping curves north to Narrowsburg.
// INVERTED logic vs 9W: NY-97 is SECONDARY, so we penalize PRIMARY/TRUNK in the canyon
// to prevent GraphHopper from routing via US-6 (PRIMARY) which runs parallel to the north.
const NY97_CORRIDOR_AREA = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    id: 'ny97_corridor',
    properties: {},
    geometry: {
      type: 'Polygon',
      // Delaware River canyon from Port Jervis north to Narrowsburg + approach roads.
      // Wide enough to capture US-6 (PRIMARY) which bypasses the canyon.
      coordinates: [[
        [-74.55, 41.28],
        [-75.10, 41.28],
        [-75.10, 41.72],
        [-74.55, 41.72],
        [-74.55, 41.28],
      ]],
    },
  }],
};

// ── NY-28 / Catskills corridor area ───────────────────────────────────────────
// NY-28 is a NY state highway — SECONDARY in OSM. Runs east-west through the Catskill
// peaks: Kingston → Woodstock → Phoenicia → Shandaken → Margaretville.
// Same inverted logic as NY-97: penalize PRIMARY/TRUNK to keep route on the mountain
// secondary instead of jumping to US-209 or I-87 bypasses.
const NY28_CORRIDOR_AREA = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    id: 'ny28_corridor',
    properties: {},
    geometry: {
      type: 'Polygon',
      // Catskills corridor: Kingston west to Margaretville/Delhi. Wide N/S to capture
      // competing US-209 (E side) and I-86/NY-17 (S side).
      coordinates: [[
        [-73.95, 41.80],
        [-74.80, 41.80],
        [-74.80, 42.25],
        [-73.95, 42.25],
        [-73.95, 41.80],
      ]],
    },
  }],
};

// ── 9W corridor area ──────────────────────────────────────────────────────────
// v2.33: Used when rider requests "via 9W" or similar named-road routing.
// The corridor covers the Hudson River west bank from Alpine/Fort Lee to Newburgh,
// including the Harriman area where GraphHopper normally cuts shortcuts.
// Within this zone: secondary/tertiary roads are heavily penalized so the
// primary road (US Route 9W) becomes the highest-scoring option for the optimizer.
// distance_influence stays at 90 (LM mode minimum). The 0.15x secondary penalty
// creates a 4.67× preference for primary (9W) over secondary roads in the zone.
const NINE_W_CORRIDOR_AREA = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    id: 'nine_w_corridor',
    properties: {},
    geometry: {
      type: 'Polygon',
      // Rectangle: Hudson River (E) to well past Harriman (W), Alpine to Newburgh (N/S).
      // Wide enough that any Harriman shortcut falls inside and gets penalized.
      coordinates: [[
        [-74.20, 40.94],
        [-73.88, 40.94],
        [-73.88, 41.52],
        [-74.20, 41.52],
        [-74.20, 40.94],
      ]],
    },
  }],
};

// ── Build corridor-biased custom_model ─────────────────────────────────────────
// v2.37: ARCHITECTURAL CHANGE — corridor routes no longer inherit the curviness-seeking
// base.priority from the motorcycle profile.
//
// Root cause of neighborhood zigzag: GraphHopper motorcycle profile assigns RESIDENTIAL
// roads the HIGHEST base priority (1.0) because they're curvy. PRIMARY roads are only 0.7.
// So a curvy residential street in West Haverstraw beat 9W even inside the corridor.
//
// Fix: for named corridors, replace curviness-seeking with a clean road-hierarchy model:
//   - MOTORWAY: 0.1 (avoid interstates)
//   - TRUNK/PRIMARY: ~0.7 default (backbone roads — preferred)
//   - SECONDARY/TERTIARY: globally 0.6 (minor roads OK outside corridor)
//   - RESIDENTIAL: globally 0.15 (motorcycles are NOT neighborhood crawlers)
//   - LIVING_STREET/SERVICE: globally 0.05 (essentially banned)
//
// The scenic quality of 9W comes from the road itself (Hudson River, Palisades cliffs,
// Bear Mountain) — not from GraphHopper seeking curviness. Curviness-seeking is only
// appropriate for open-ended "twisty ride" requests, not named corridor routes.
function buildCorridorModel(corridor: string, curviness: 1 | 2 | 3): any {
  const base = CURVINESS_MODELS[curviness - 1];

  if (corridor === '9W') {
    return {
      speed: base.speed, // keep motorcycle speed model
      priority: [
        // ── Global road hierarchy (replaces curviness-seeking base.priority) ──────
        // Motorcycles want flow: highways and primary roads, NOT neighborhood streets.
        { if: 'road_class == MOTORWAY',       multiply_by: '0.1'  }, // avoid interstates
        { if: 'road_class == RESIDENTIAL',    multiply_by: '0.15' }, // no neighborhood crawling
        { if: 'road_class == LIVING_STREET',  multiply_by: '0.05' }, // nearly banned
        { if: 'road_class == SERVICE',        multiply_by: '0.05' }, // nearly banned
        { if: 'road_class == SECONDARY',      multiply_by: '0.6'  }, // minor roads: lower but OK
        { if: 'road_class == TERTIARY',       multiply_by: '0.5'  }, // discouraged globally
        // TRUNK and PRIMARY get ~0.7 motorcycle base (no rule = no change) — preferred

        // ── 9W corridor zone: enforce PRIMARY wins hard ───────────────────────────
        // Inside the corridor, secondary/tertiary/residential all get crushed further.
        // PRIMARY (0.7 base) must dominate everything. Combined penalties:
        //   SECONDARY in corridor:    0.6 × 0.15 = 0.09  << PRIMARY 0.7
        //   TERTIARY in corridor:     0.5 × 0.15 = 0.075 << PRIMARY 0.7
        //   RESIDENTIAL in corridor:  0.15 × 0.1 = 0.015 << PRIMARY 0.7
        { if: 'in_nine_w_corridor && road_class == SECONDARY',    multiply_by: '0.15' },
        { if: 'in_nine_w_corridor && road_class == TERTIARY',     multiply_by: '0.15' },
        { if: 'in_nine_w_corridor && road_class == UNCLASSIFIED', multiply_by: '0.15' },
        { if: 'in_nine_w_corridor && road_class == RESIDENTIAL',  multiply_by: '0.1'  },
        { if: 'in_nine_w_corridor && road_class == LIVING_STREET',multiply_by: '0.05' },
        { if: 'in_nine_w_corridor && road_class == SERVICE',      multiply_by: '0.05' },

        // ── Route 17 / Route 303 exclusion zone ───────────────────────────────────
        // Stepped polygon (v2.36) prevents competing PRIMARY roads west of 9W.
        { if: 'in_nine_w_route17_excl && road_class == PRIMARY',  multiply_by: '0.1'  },
        { if: 'in_nine_w_route17_excl && road_class == TRUNK',    multiply_by: '0.1'  },
      ],
      areas: {
        type: 'FeatureCollection',
        features: [
          ...(base.areas?.features || []),
          ...NINE_W_CORRIDOR_AREA.features,
          ...NINE_W_ROUTE17_EXCL_AREA.features,
        ],
      },
      distance_influence: 90,
    };
  }

  if (corridor === 'NY-97') {
    return {
      speed: base.speed, // keep motorcycle speed model
      priority: [
        // ── Global road hierarchy (same anti-residential penalties as 9W) ──────────
        { if: 'road_class == MOTORWAY',       multiply_by: '0.1'  }, // avoid interstates
        { if: 'road_class == RESIDENTIAL',    multiply_by: '0.15' }, // no neighborhood crawling
        { if: 'road_class == LIVING_STREET',  multiply_by: '0.05' }, // nearly banned
        { if: 'road_class == SERVICE',        multiply_by: '0.05' }, // nearly banned
        { if: 'road_class == SECONDARY',      multiply_by: '0.6'  }, // minor roads: lower but OK
        { if: 'road_class == TERTIARY',       multiply_by: '0.5'  }, // discouraged globally

        // ── NY-97 corridor: INVERTED logic vs 9W ─────────────────────────────────
        // NY-97 is a SECONDARY road. US-6 (PRIMARY) runs parallel north of the canyon
        // and is shorter/faster — GraphHopper would prefer it without penalty.
        // Fix: in the corridor, PRIMARY/TRUNK get crushed so SECONDARY (NY-97) wins.
        //   PRIMARY in corridor:  no global rule, combined: 0.15 alone
        //   SECONDARY in corridor: 0.6 global × 1.0 here = 0.6 >> PRIMARY 0.15 ✓
        { if: 'in_ny97_corridor && road_class == PRIMARY',  multiply_by: '0.15' },
        { if: 'in_ny97_corridor && road_class == TRUNK',    multiply_by: '0.15' },
        { if: 'in_ny97_corridor && road_class == MOTORWAY', multiply_by: '0.05' },
        // TERTIARY/RESIDENTIAL already penalized globally; corridor doesn't need extra push
      ],
      areas: {
        type: 'FeatureCollection',
        features: [
          ...(base.areas?.features || []),
          ...NY97_CORRIDOR_AREA.features,
        ],
      },
      distance_influence: 90,
    };
  }

  if (corridor === 'NY-28') {
    return {
      speed: base.speed, // keep motorcycle speed model
      priority: [
        // ── Global road hierarchy (same as other corridors) ───────────────────────
        { if: 'road_class == MOTORWAY',       multiply_by: '0.1'  },
        { if: 'road_class == RESIDENTIAL',    multiply_by: '0.15' },
        { if: 'road_class == LIVING_STREET',  multiply_by: '0.05' },
        { if: 'road_class == SERVICE',        multiply_by: '0.05' },
        { if: 'road_class == SECONDARY',      multiply_by: '0.6'  },
        { if: 'road_class == TERTIARY',       multiply_by: '0.5'  },

        // ── NY-28 corridor: INVERTED logic — NY-28 is SECONDARY ──────────────────
        // Competitors: I-87 (MOTORWAY, already penalized), US-209 (PRIMARY, east side),
        // I-86/NY-17 (MOTORWAY/PRIMARY, south of corridor).
        // Penalize PRIMARY/TRUNK so SECONDARY (NY-28) wins through the Catskill spine.
        //   PRIMARY in corridor:   combined 0.15  (0.15 penalty only)
        //   SECONDARY in corridor: combined 0.6   (0.6 global, no extra penalty) >> 0.15 ✓
        { if: 'in_ny28_corridor && road_class == PRIMARY',  multiply_by: '0.15' },
        { if: 'in_ny28_corridor && road_class == TRUNK',    multiply_by: '0.15' },
        { if: 'in_ny28_corridor && road_class == MOTORWAY', multiply_by: '0.05' },
      ],
      areas: {
        type: 'FeatureCollection',
        features: [
          ...(base.areas?.features || []),
          ...NY28_CORRIDOR_AREA.features,
        ],
      },
      distance_influence: 90,
    };
  }

  return base; // unknown corridor — fall back to standard curviness model
}

// ── Curviness tiers ───────────────────────────────────────────────────────────
// distance_influence minimum is 90 in LM/flexible mode. All tiers use 90.
// Differentiation comes from priority penalty weights only.
const CURVINESS_MODELS = [
  // Tier 1: Direct + Spirited — fastest transit route, highway-friendly
  // v2.41: added full road hierarchy to stop secondary roads (Saint Georges Ave) beating PRIMARY.
  // v2.42: raised MOTORWAY from 0.5 → 0.85. At 0.5, I-95 (MOTORWAY) lost to NJ-27 (PRIMARY 0.9)
  //        by a 2:1 margin, so GraphHopper took NJ-27 — a strip-mall crawl full of red lights.
  //        For a transit/city ride, the rider WANTS the highway. 0.85 makes I-95 competitive:
  //        PRIMARY (0.9) ≈ MOTORWAY (0.85) — GraphHopper picks I-95 when it's genuinely faster.
  //        Motorway avoidance (0.1–0.5) only makes sense for curviness 2–3 (scenic/backroads).
  {
    speed: [],
    priority: [
      { if: 'road_class == MOTORWAY',    multiply_by: '0.85' },
      { if: 'road_class == PRIMARY',     multiply_by: '0.9'  },
      { if: 'road_class == SECONDARY',   multiply_by: '0.7'  },
      { if: 'road_class == TERTIARY',    multiply_by: '0.5'  },
      { if: 'road_class == RESIDENTIAL', multiply_by: '0.2'  },
      { if: 'road_class == LIVING_STREET', multiply_by: '0.05' },
      { if: 'road_class == SERVICE',     multiply_by: '0.05' },
    ],
    distance_influence: 90,
  },
  // Tier 2: Scenic — avoids highways, prefers secondary/tertiary
  // Note: multiply_by max is 1.0 in LM mode. Preference via relative penalties only.
  // Palisades zone: in_palisades_pkwy && MOTORWAY → extra 0.1 factor → combined 0.01.
  {
    speed: [],
    priority: [
      { if: 'road_class == MOTORWAY', multiply_by: '0.1' },
      { if: 'road_class == TRUNK', multiply_by: '0.2' },
      { if: 'road_class == PRIMARY', multiply_by: '0.7' },
      { if: 'road_class == SECONDARY', multiply_by: '1.0' },
      { if: 'road_class == TERTIARY', multiply_by: '1.0' },
      { if: 'in_palisades_pkwy && road_class == MOTORWAY', multiply_by: '0.1' },
    ],
    areas: PALISADES_ZONE_AREAS,
    distance_influence: 90,
  },
  // Tier 3: Backroads — maximally avoids highways, strongly prefers small roads
  // Palisades zone: in_palisades_pkwy && MOTORWAY → extra 0.1 factor → combined 0.005.
  {
    speed: [],
    priority: [
      { if: 'road_class == MOTORWAY', multiply_by: '0.05' },
      { if: 'road_class == TRUNK', multiply_by: '0.1' },
      { if: 'road_class == PRIMARY', multiply_by: '0.5' },
      { if: 'road_class == SECONDARY', multiply_by: '1.0' },
      { if: 'road_class == TERTIARY', multiply_by: '1.0' },
      { if: 'road_class == UNCLASSIFIED', multiply_by: '1.0' },
      { if: 'in_palisades_pkwy && road_class == MOTORWAY', multiply_by: '0.1' },
    ],
    areas: PALISADES_ZONE_AREAS,
    distance_influence: 90,
  },
];

// ── Haversine distance (km) ────────────────────────────────────────────────────
function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371, toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
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
  'goethals bridge, staten island, ny': { lat: 40.643592, lng: -74.209789 }, // I-278 SI approach — OSM way 38071038
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
async function resolveLocation(loc: Location): Promise<LatLng> {
  return 'lat' in loc ? loc : await geocode(loc.query);
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
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri',
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
  let body: any;
  if (curviness === 0) {
    // Car profile — CH routing (no ch.disable), no custom_model needed.
    // Car profile prefers motorways and primary roads by default.
    body = {
      points: points.map(p => [p.lng, p.lat]),
      profile: 'car',
      points_encoded: false,
      instructions: true,
      locale: 'en',
    };
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
      profile: 'motorcycle',
      custom_model: model,
      'ch.disable': true,
      snap_prevention: ['motorway', 'motorway_link'],
      points_encoded: false,
      instructions: true,
      locale: 'en',
    };
    // v2.30: heading hints prevent via-point U-turn excursions.
    // Only applied to scenic (motorcycle) legs — car escape uses highways where
    // snapping direction is unambiguous. heading_penalty amplifies the preference.
    if (headings && headings.length === points.length) {
      body.heading = headings;
      body.heading_penalty = 300; // seconds: strong preference, not a hard block
    }
  }
  const res = await fetch(`${GRAPHHOPPER_URL}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GraphHopper error: ${res.status} ${err}`);
  }
  const data = await res.json();
  const path = data.paths?.[0];
  if (!path) throw new Error('GraphHopper returned no paths');
  return {
    distance_miles: Math.round((path.distance / 1609.34) * 10) / 10,
    time_minutes: Math.round(path.time / 60000),
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
      signal: AbortSignal.timeout(5000), // 5s max — never block the response
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
Your job is simple: give it the right destination, the right stops, and — for corridor routes —
one or two intermediate_waypoints that are real towns ON the named road.
Do NOT try to control which bridge GH crosses or how it exits the city. GH knows the road network.
Trust it. Overspecifying waypoints is what causes loops, spurs, and double-backs.

━━ NYC ORIGIN — EFFICIENT CITY EXIT ━━
THE CITY = all 5 boroughs: Manhattan, Brooklyn, Queens, Bronx, Staten Island.
The boundary waypoint must be OUTSIDE all 5 boroughs — in NJ, Westchester, Nassau County, or Rockland.
Staten Island is still the city. "Freehold, NJ" is outside. "Jamaica, NY" is NOT — it's Queens.

By destination direction — pick ONE boundary intermediate that is geographically outside all 5 boroughs:

  NORTH / NORTHWEST (Bear Mountain, Harriman, Catskills, Hawk's Nest, Hudson Valley):
    → "Fort Lee, NJ" — just across GWB in NJ. GH finds the best borough path to GWB naturally.
    → Exception: Bronx origin — no boundary needed, Bronx connects directly to GWB and I-87.

  SOUTH / JERSEY SHORE (Asbury Park, Cape May, Seaside Heights):
    → "Freehold, NJ" — first real NJ corridor town south of the city.
      GH crosses via Verrazzano + Goethals (through Staten Island is fine — it's the natural path,
      not a detour, even though SI is a borough).

  SOUTHWEST (Philadelphia, Trenton, Delaware):
    → "New Brunswick, NJ" — anchors onto US-1 south corridor.

  EAST (Long Island, Nassau/Suffolk):
    → "Garden City, NY" — first major town in Nassau County, outside the city.
      GH exits Queens heading east naturally to reach it.

  NORTH OF GWB (Westchester, Yonkers, Tarrytown, White Plains):
    → No boundary needed — already outside all 5 boroughs.

RULE: If rider has a stop already outside the city, that stop IS the boundary — skip the boundary intermediate.
RULE: If a road_corridor already has intermediate_waypoints (e.g. Piermont + Nyack for 9W), those replace the boundary — do NOT add Fort Lee on top.

━━ INTERMEDIATE WAYPOINTS — WHEN AND HOW ━━
intermediate_waypoints are named places GH must pass through, in order.
Use them for: (1) NYC boundary exit, (2) corridor road anchoring.
Keep the list short — 1–2 waypoints maximum.

RULE: If the rider specified any stops (coffee, lunch, etc.) that are outside the city,
set intermediate_waypoints: [] — let the stops anchor the route.

NEVER use "Florida, NY" as an intermediate — causes west-then-east zigzag.

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
→ The routing engine applies a geographic area model that biases GH to stay on the named road.
→ Use intermediate_waypoints (1–2 real towns ON the road) to anchor GH onto the corridor from the start.
→ No escape_waypoint — GH handles city exit natively with the motorcycle profile.

road_corridor values + intermediate_waypoints:
  "9W"    — Hudson River west bank (Piermont, Nyack, Haverstraw, Bear Mountain, Cornwall, Newburgh)
            NYC/Queens origin: intermediate_waypoints: ["Piermont, NY", "Nyack, NY"]
            North-of-GWB origin (Westchester, Yonkers): intermediate_waypoints: ["Nyack, NY"]
  "NY-97" — Delaware River canyon (Hawks Nest, Sparrowbush, Port Jervis)
            Any origin: intermediate_waypoints: ["Goshen, NY"]
  "NY-28" — Catskills spine (Woodstock, Phoenicia, Margaretville)
            Any origin: intermediate_waypoints: ["Woodstock, NY"]
  "NY-218" — Storm King Highway (Cornwall to West Point)
            Any origin: intermediate_waypoints: ["Piermont, NY", "Nyack, NY"]

Examples (NYC/Queens origin):
"take me to Hawks Nest via 9W"      → road_corridor: "9W", intermediate_waypoints: ["Piermont, NY", "Nyack, NY"], destination: "Sparrowbush, NY"
"take me to Bear Mountain along 9W" → road_corridor: "9W", intermediate_waypoints: ["Piermont, NY", "Nyack, NY"], destination: "Bear Mountain State Park, NY"
"go to Woodstock taking NY-28"      → road_corridor: "NY-28", intermediate_waypoints: ["Woodstock, NY"], destination: "Woodstock, NY"
"ride 9W to Newburgh"               → road_corridor: "9W", intermediate_waypoints: ["Piermont, NY", "Nyack, NY"], destination: "Newburgh, NY"

━━ REFINEMENT INTERPRETATION ━━
When the query starts with "[Refining existing route —...]" you are modifying an existing route.
The bracket section describes the CURRENT route. Read it before applying the rider's feedback.

There are three and only three kinds of refinement. Identify which one applies:

CORRIDOR REPLACEMENT — rider names a road, highway, or route they want to travel:
  Trigger phrases: "take the [road]", "go via [road]", "ride [road]", "use [road]", "along the [road]"
  → DISCARD current road_corridor and current corridor intermediates entirely
  → Replace with ONE entry waypoint that puts the route onto the named road — then stop.
    GraphHopper's motorcycle profile will follow the road from there. Do NOT add every landmark
    or town along the road as waypoints — they become forced detours.
  → Keep destination, stops, curviness unchanged unless explicitly mentioned
  Example: current corridor [Harriman, Middletown], rider says "take the 9W to Newburgh"
    → Remove Harriman, Middletown
    → Add ONE entry waypoint: "Nyack, NY" (gets route onto 9W via Tappan Zee bridge)
    → Keep Newburgh as destination — GraphHopper follows 9W there naturally
    → Do NOT add Bear Mountain, Cornwall, etc. — rider passes through them, not to them

STOP ADDITION — rider adds a specific place or category along the way:
  Trigger phrases: "add a [stop]", "stop at [place]", "find [thing] along the way", "with a [stop]"
  → Keep all existing intermediates and destination unchanged
  → Add the new stop to stops array at the logically correct position in the route

STYLE CHANGE — rider changes the character of the ride, not the places:
  Trigger phrases: "more twisty", "less highway", "faster", "take it easy", "avoid tolls"
  → Keep all existing waypoints, intermediates, destination, and stops unchanged
  → Only adjust curviness or other parameters

WHEN AMBIGUOUS: default to CORRIDOR REPLACEMENT. Riders think in roads, not waypoints.
Never stack intermediates from the old route on top of new ones — that creates impossible geometry.

━━ RIDER VOCABULARY — WHAT RIDERS ACTUALLY MEAN ━━
Riders name ROADS and EXPERIENCES, not tourist attractions or venues.
Interpret these before geocoding anything. These override generic Places results.

"Storm King" or "Storm King Highway"
  → destination: "Cornwall-on-Hudson, NY" (south end of NY-218)
  → intermediate: "Cornwall, NY" to anchor onto NY-218
  → NOT Storm King Art Center (a sculpture park — irrelevant to riders)
  WHY: NY-218 is a legendary cliff-side road. Narrow, technical, Hudson River 1000ft below. Every rider knows it.

"Hawks Nest" or "Hawks Nest overlook" or "Hawks Nest highway"
  → destination: "Sparrowbush, NY" — the hamlet directly at the NY-97 scenic overlook and switchbacks.
    NOT Port Jervis (that's miles past the overlook, in a city center).
    NOT a wildlife area or generic viewpoint.
  → intermediate: ONLY add "Middletown, NY" if there are NO user stops. If the rider requested
    any stop (coffee, food, etc.), set intermediate_waypoints: [] — the stop anchors the route.
    WHY: Middletown + a Newburgh coffee stop forces a north-then-south Z-shape that adds 45 minutes.
    The FAR NORTH corridor rule already handles this correctly — do not override it here.

"The Gap" or "Water Gap"
  → destination: "Delaware Water Gap, PA"
  → use NORTHWEST corridor (GWB → Mahwah, NJ → NJ-23 → NJ-94)

"9W" or "Route 9W" or "riding 9W" or "via 9W" or "along 9W"
  → the road itself. User wants to FOLLOW 9W as a corridor.
  → destination: "Bear Mountain, NY" unless they say otherwise.
  → road_corridor: "9W", intermediate_waypoints: ["Piermont, NY", "Nyack, NY"] for NYC/Queens origins.
  → road_corridor: "9W", intermediate_waypoints: ["Nyack, NY"] for north-of-GWB origins.

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
  → 9W approach: use "Nyack, NY" for north-of-GWB origins, "Piermont, NY" for NYC origins (same rule as 9W above)

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
    → intermediate_waypoints: ["Piermont, NY", "Nyack, NY"] for NYC/Queens origins
    → intermediate_waypoints: ["Nyack, NY"] for north-of-GWB origins (Westchester, Yonkers)
    → The corridor model biases GraphHopper to stay on 9W throughout
  Character: primary road hugging the Hudson's west bank, dramatic river views, sweeping curves.

PALISADES INTERSTATE PKWY — ridge road above Hudson (NJ side, Bear Mountain approach):
  Default Bear Mountain approach (no "9W" mention) — no corridor needed, GH handles naturally.
  No trucks. Spectacular ridge road. GraphHopper avoids Palisades motorway via Palisades zone model.

NY-97 / HAWKS NEST — Delaware River canyon switchbacks:
  When user says "via NY-97", "take 97", "Hawks Nest", "Hawks Nest via 97", "the canyon road":
    → road_corridor: "NY-97"
    → intermediate_waypoints: ["Goshen, NY"] for any origin
    → If rider has a stop (e.g. Sloatsburg coffee): intermediate_waypoints: [] — stop anchors the route
  Character: switchbacks carved into cliff face above the Delaware River gorge. One of the best roads in the Northeast.
  Road class: SECONDARY (NY state route). Corridor logic penalizes PRIMARY/TRUNK so NY-97 wins over US-6.

NY-218 — Storm King Highway (Cornwall, West Point approach):
  When user says "Storm King Highway", "Storm King", or "via 218":
    → road_corridor: "NY-218"
    → intermediate_waypoints: ["Piermont, NY", "Nyack, NY"]
    → destination: "Cornwall-on-Hudson, NY"
  Character: narrow cliff-side road above the Hudson. Technical riding, historically significant.

NY-28 — Catskills spine (Woodstock, Phoenicia, Margaretville, Delhi):
  When user says "via NY-28", "take 28", "NY-28 to Woodstock", "Catskills", "Phoenicia":
    → road_corridor: "NY-28"
    → intermediate_waypoints: ["Woodstock, NY"]
  Character: wide mountain sweepers through Catskill peaks. Flowing rhythm, great scenery.

NJ-94 / NJ-23 — NJ Highlands backroads (High Point, Delaware Water Gap from NJ):
  No road_corridor needed. intermediate_waypoints: ["Mahwah, NJ"] to anchor onto NJ Highlands.

NJ Route 29 — Delaware River road (Milford NJ, Frenchtown, Lambertville):
  intermediate_waypoints: ["Milford, NJ"] to anchor onto the river road.

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

Route response — standard (no corridor, NYC origin heading north):
{
  "origin": "Rider GPS location or named place if no GPS provided",
  "intermediate_waypoints": ["Fort Lee, NJ"],
  "stops": [{ "type": "coffee shop", "near": "town name, State", "radius_km": 15 }],
  "destination": "Town or Park Name, State",
  "curviness": 2,
  "round_trip": false,
  "reasoning": "one sentence: why this route"
}

Route response — named road corridor:
{
  "origin": "Rider GPS location or named place if no GPS provided",
  "road_corridor": "9W",
  "intermediate_waypoints": ["Piermont, NY", "Nyack, NY"],
  "stops": [],
  "destination": "Bear Mountain State Park, NY",
  "curviness": 2,
  "round_trip": false,
  "reasoning": "rider asked for 9W — intermediates anchor GH onto the corridor"
}

IMPORTANT: Never include escape_waypoint or escape_via_waypoints — those fields no longer exist.
If rider has stops AND a corridor, set intermediate_waypoints: [] and let stops anchor the route.

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
    rawIntent.round_trip && `round trip: yes`,
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

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  if (!GRAPHHOPPER_URL || !GOOGLE_PLACES_KEY) {
    return new Response(JSON.stringify({ error: 'Missing required secrets: GRAPHHOPPER_URL, GOOGLE_PLACES_KEY' }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  try {
    const rawBody = await req.json();

    // v2.19: fetch routing lessons from bug reports in parallel with body parse
    const lessonsPromise = fetchRoutingLessons();

    // v2.17: extract rider GPS if provided by client
    const userLat: number | undefined = typeof rawBody.userLat === 'number' ? rawBody.userLat : undefined;
    const userLng: number | undefined = typeof rawBody.userLng === 'number' ? rawBody.userLng : undefined;
    const gpsTag = userLat !== undefined ? ` [Rider GPS: ${userLat.toFixed(5)}, ${userLng!.toFixed(5)}]` : '';
    if (gpsTag) console.log('[generate-route] rider GPS:', userLat, userLng);

    // v2.10: detect mode — new query, refinement, or raw RouteRequest
    let body: RouteRequest;
    let rawIntent: any = null;

    if (rawBody.refine === true && rawBody.intent && typeof rawBody.feedback === 'string') {
      // Conversational refinement: rider saw a route and wants to change something
      console.log('[generate-route] refine mode, feedback:', rawBody.feedback);
      const refineQuery = await buildRefineQuery(rawBody.feedback, rawBody.intent);
      console.log('[generate-route] refine query:', refineQuery);
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

    // Override origin with actual GPS coords — skip Places geocode, use exact position
    if (userLat !== undefined) {
      body.origin = { lat: userLat, lng: userLng! };
      console.log('[generate-route] origin overridden with GPS:', userLat, userLng);
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

    // v2.43: single-phase routing — resolve intermediate waypoints only (no escape logic)
    const intermediateWPs: LatLng[] = [];
    for (const wp of (body.intermediate_waypoints || [])) {
      const ll = await resolveWaypoint(wp);
      intermediateWPs.push(ll);
    }
    if (intermediateWPs.length) console.log('[generate-route] intermediates:', JSON.stringify(intermediateWPs));

    // Find POI stops
    const stops: any[] = [];
    if (body.stops?.length) {
      for (const stop of body.stops) {
        const nearLL = await resolveLocation(stop.near);
        const poi = await findPOI(stop.type, nearLL, stop.radius_km ?? 15);
        if (poi) stops.push({ ...poi, type: stop.type }); // include type for emoji picker in App.jsx
      }
    }

    // Build scenic waypoint chain: [escape] → intermediates → stops → destination
    const stopLLs: LatLng[] = stops.map(s => ({ lat: s.lat, lng: s.lng }));
    const curviness = (body.curviness ?? 2) as 1 | 2 | 3;
    const corridor = body.road_corridor || undefined;

    // v2.44 — Hybrid routing: car-profile city exit + motorcycle scenic leg
    //
    // When origin is inside all 5 NYC boroughs AND there are intermediate_waypoints:
    //   Phase 1 (escape): car profile, curviness=0, origin → intermediates[0]
    //     Car profile has no motorway penalty → picks bridges and expressways naturally.
    //     This is what prevents the Queensboro Bridge → Manhattan surface streets routing.
    //   Phase 2 (scenic): motorcycle profile, origin=intermediates[0] → rest of route
    //     Normal scenic/corridor routing takes over once outside the city.
    //   Merged with mergeRoutes() into a single geometry for the frontend.
    //
    // When origin is outside NYC OR no intermediates: single-phase motorcycle (unchanged).
    let route: any;
    let allWaypoints: LatLng[];
    const nycOrigin = isInNYC(originLL) && intermediateWPs.length > 0;

    if (nycOrigin) {
      const boundaryLL = intermediateWPs[0];
      console.log('[generate-route] NYC origin — car escape to', JSON.stringify(boundaryLL));
      const escapeLeg = await getRoute([originLL, boundaryLL], 0);

      const scenicWPs = [boundaryLL, ...intermediateWPs.slice(1), ...stopLLs, destinationLL];
      if (body.round_trip) scenicWPs.push(originLL);

      let scenicLeg: any;
      if (corridor) {
        const corridorModel = buildCorridorModel(corridor, curviness);
        const overallBearing = Math.round(bearingDegrees(boundaryLL, destinationLL));
        const headings = scenicWPs.map((_, i) =>
          (i === 0 || i === scenicWPs.length - 1) ? -1 : overallBearing
        );
        scenicLeg = await getRoute(scenicWPs, curviness, headings, corridorModel);
        console.log('[generate-route] corridor routing via', corridor, '— scenic phase,', scenicWPs.length, 'waypoints');
      } else {
        scenicLeg = await getRoute(scenicWPs, curviness);
        console.log('[generate-route] scenic routing —', scenicWPs.length, 'waypoints');
      }

      route = mergeRoutes(escapeLeg, scenicLeg);
      allWaypoints = [originLL, ...intermediateWPs, ...stopLLs, destinationLL];
      if (body.round_trip) allWaypoints.push(originLL);
      console.log('[generate-route] merged route:', route.distance_miles, 'mi,', route.time_minutes, 'min');
    } else {
      // Single-phase motorcycle profile — non-NYC origin or no boundary intermediates
      allWaypoints = [originLL, ...intermediateWPs, ...stopLLs, destinationLL];
      if (body.round_trip) allWaypoints.push(originLL);

      if (corridor) {
        const corridorModel = buildCorridorModel(corridor, curviness);
        const overallBearing = Math.round(bearingDegrees(originLL, destinationLL));
        const headings = allWaypoints.map((_, i) =>
          (i === 0 || i === allWaypoints.length - 1) ? -1 : overallBearing
        );
        route = await getRoute(allWaypoints, curviness, headings, corridorModel);
        console.log('[generate-route] corridor routing via', corridor, '— single phase,', allWaypoints.length, 'waypoints');
      } else {
        route = await getRoute(allWaypoints, curviness);
        console.log('[generate-route] standard routing —', allWaypoints.length, 'waypoints');
      }
    }

    // Save to Supabase (best-effort)
    const destName = 'query' in body.destination ? body.destination.query : `${destinationLL.lat},${destinationLL.lng}`;

    // Road scores + narrative run in parallel with DB save (v2.45)
    const originalQuery = typeof (rawBody as any).query === 'string'
      ? (rawBody as any).query
      : ('query' in body.destination ? body.destination.query : 'route');
    const scoresPromise = fetchRouteScores(route.geometry);
    const narrativePromise = scoresPromise.then(scores =>
      generateNarrative(
        route.instructions,
        stops,
        route.distance_miles,
        route.time_minutes,
        originalQuery,
        scores,
      )
    );
    try {
      const record = {
        title: `Route to ${destName}`,
        destination: destName,
        duration_str: `${Math.floor(route.time_minutes / 60)}h ${route.time_minutes % 60}min`,
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

    return new Response(JSON.stringify({ success: true, route: { ...route, waypoints: allWaypoints, stops, destination: destName, title: `Route to ${destName}`, duration_str: `${Math.floor(route.time_minutes / 60)}h ${route.time_minutes % 60}min`, distance_mi: route.distance_miles, intent: rawIntent, narrative, road_scores: scores ?? undefined } }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  } catch (err: any) {
    console.error('[generate-route] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
