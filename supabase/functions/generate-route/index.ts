import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js';

// ── Hybrid Architecture: Gemini (geospatial) + Claude (narrative) ────────────
//
//  Step 1 — Gemini + Google Maps grounding
//           Discovers real scenic road corridors, named roads, and GPS waypoints
//           grounded in live Google Maps data (250M+ places, current road network).
//           Falls back to Gemini without grounding if Maps tool is unavailable.
//
//  Step 2 — Claude + Google Maps Directions API in PARALLEL (independent)
//           Claude:        takes Gemini's route summaries → writes narrative layer
//           Google Maps:   takes Gemini's waypoints → returns road-snapped polyline
//                          Same map data as Gemini → perfect alignment, no mismatch
//
//  Step 3 — Merge + Supabase upsert (all routes in parallel)
//           Combines Claude's narrative with Google's geometry → saves to DB
//           Supabase Realtime fires on each INSERT → frontend renders routes
//
// Docs: https://ai.google.dev/gemini-api/docs/maps-grounding

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Types ───────────────────────────────────────────────────────────────────
interface Waypoint {
  lat: number;
  lng: number;
  label: string;
}

interface GeminiRoute {
  id: string;
  road_names: string[];
  character: string;
  distance_mi: number;
  duration_str: string;
  waypoints: Waypoint[];
}

interface EnrichedRoute {
  id: string;
  title: string;
  destination: string;
  start_location: string;
  distance_mi: number;
  duration_str: string;
  difficulty: string;
  community_score: number;
  source_count: number;
  tags: string[];
  highway_desc: string;
  parkway_desc: string;
  twisty_desc: string;
  segments: object[];
  waypoints: Waypoint[];
  colors: object;
}

// ── Google Maps polyline decoder ─────────────────────────────────────────────
// Decodes Google's encoded polyline format into [lat, lng] pairs.
// https://developers.google.com/maps/documentation/utilities/polylinealgorithm
function decodePolyline(encoded: string): Array<[number, number]> {
  const coords: Array<[number, number]> = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e5, lng / 1e5]);
  }
  return coords;
}

// ── Google Maps Directions API routing ───────────────────────────────────────
// Uses the SAME Google Maps road graph as Gemini's Maps grounding — perfect
// alignment. Gemini places waypoints on Google roads; Google routes between them.
// Replaces ORS which used OpenStreetMap data (different graph → mismatch).
async function computeGoogleMapsRoute(waypoints: Waypoint[]): Promise<object | null> {
  const mapsApiKey = Deno.env.get('GOOGLE_MAPS_API_KEY');
  if (!mapsApiKey || waypoints.length < 2) return null;

  // Directions API supports up to 25 total points (origin + 23 intermediates + destination)
  const capped = waypoints.length > 25 ? [
    waypoints[0],
    ...waypoints.slice(1, -1).filter((_, i, arr) =>
      Math.round(i * 23 / (arr.length - 1)) === Math.round(i * 23 / (arr.length - 1))
    ).slice(0, 23),
    waypoints[waypoints.length - 1],
  ] : waypoints;

  const origin = `${capped[0].lat},${capped[0].lng}`;
  const dest   = `${capped[capped.length - 1].lat},${capped[capped.length - 1].lng}`;
  const intermediates = capped.slice(1, -1).map(w => `${w.lat},${w.lng}`).join('|');

  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', dest);
  if (intermediates) url.searchParams.set('waypoints', intermediates);
  url.searchParams.set('key', mapsApiKey);
  url.searchParams.set('mode', 'driving');

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.error(`Google Maps error ${res.status}:`, await res.text());
      return null;
    }
    const data = await res.json();
    if (data.status !== 'OK') {
      console.error(`Google Maps status: ${data.status}`, data.error_message ?? '');
      return null;
    }

    // Decode the overview polyline → GeoJSON LineString
    // For higher fidelity, concatenate all step polylines within each leg
    const allCoords: number[][] = [];
    for (const leg of data.routes[0].legs) {
      for (const step of leg.steps) {
        const pts = decodePolyline(step.polyline.points);
        for (const [lat, lng] of pts) {
          allCoords.push([lng, lat]); // GeoJSON is [lng, lat]
        }
      }
    }

    console.log(`[Google Maps] Route decoded: ${allCoords.length} coordinate points`);
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: allCoords },
        properties: {},
      }],
    };
  } catch (err) {
    console.error('Google Maps fetch failed:', err.message);
    return null;
  }
}

// Straight-line fallback when routing API is unavailable
function straightLineGeoJSON(waypoints: Waypoint[]) {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: waypoints.map(w => [w.lng, w.lat]),
      },
      properties: {},
    }],
  };
}

// ── Step 1: Gemini discovers scenic roads + waypoints ───────────────────────
// Uses Google Maps grounding to surface real named roads, current road network
// data, and accurate GPS coordinates — rather than relying on training-data memory.
// withMapsGrounding: false falls back to Gemini's training data (no Maps API needed).
async function discoverRoutesWithGemini(
  start: string,
  destination: string,
  withMapsGrounding = true
): Promise<GeminiRoute[]> {
  const geminiApiKey = Deno.env.get('GEMINI_API_KEY');
  if (!geminiApiKey) throw new Error('GEMINI_API_KEY not configured');

  const prompt = `You are an expert motorcycle route planner for the NYC tri-state area (NY, NJ, CT).

${withMapsGrounding ? 'Using Google Maps data, identify' : 'Identify'} 2 distinct scenic motorcycle route options from "${start}" to "${destination}".

Prioritize REAL, NAMED roads that riders love: scenic parkways, twisty ridge roads, river roads
(e.g., Route 9W, Palisades Pkwy, Storm King Highway, Seven Lakes Drive, Merritt Pkwy, Route 202,
Route 9D, Perkins Memorial Drive, Old Mine Road, Route 23, etc.).

For each route return EXACTLY this JSON structure:
{
  "id": "short-kebab-slug",
  "road_names": ["Route 9W", "Palisades Pkwy N", "Seven Lakes Drive"],
  "character": "One sentence describing what makes this route feel special for a rider",
  "distance_mi": 58,
  "duration_str": "1h 42m",
  "waypoints": [
    {"lat": 40.762283, "lng": -73.918380, "label": "Start"},
    {"lat": 40.848000, "lng": -73.932000, "label": "GW Bridge approach"},
    ... 10-15 total waypoints on real road pavement ...
    {"lat": 41.311200, "lng": -74.003900, "label": "Destination"}
  ]
}

CRITICAL waypoint rules:
- 10-15 waypoints tracing the exact road path, placed every 2-4 miles
- Points MUST be on real road pavement — ORS snap radius is only 500m
- RIVER CROSSINGS: cross at exactly ONE named bridge; one waypoint on approach, one on exit
- Never place points in water, parks, forests, or medians
- Stay on one side of any river per leg
- The two routes must use meaningfully different roads

Return ONLY a raw JSON array. No markdown, no code fences. Start with [ and end with ].`;

  const requestBody: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2, // Low temp for accurate, consistent coordinates
    },
  };

  // Attach Maps grounding tool only when requested
  if (withMapsGrounding) {
    requestBody.tools = [{ google_maps: {} }];
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error('Gemini API error:', errText);
    throw new Error(`Gemini API failed: ${response.status} — ${errText}`);
  }

  const data = await response.json();
  let text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

  const routes: GeminiRoute[] = JSON.parse(text);
  console.log(`[Gemini] Discovered ${routes.length} route(s) (Maps grounding: ${withMapsGrounding})`);
  return routes;
}

// ── Step 2a: Claude adds narrative and rider voice ──────────────────────────
// Claude receives Gemini's route skeleton (roads, waypoints, character) and
// crafts the narrative layer: titles, segment descriptions, difficulty, tags.
// Runs in PARALLEL with Google Maps routing — neither depends on the other's output.
async function enrichRoutesWithClaude(
  geminiRoutes: GeminiRoute[],
  start: string,
  destination: string
): Promise<EnrichedRoute[]> {
  const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });

  // Send Gemini's route summaries to Claude (no waypoints needed for narrative)
  const routeSummaries = geminiRoutes.map(r => ({
    id: r.id,
    road_names: r.road_names,
    character: r.character,
    distance_mi: r.distance_mi,
    duration_str: r.duration_str,
  }));

  const prompt = `You are TwistyRoute, a passionate motorcycle route storyteller for the NYC tri-state area.

Our mapping engine (powered by Google Maps) has identified these ${geminiRoutes.length} scenic route options
from "${start}" to "${destination}":

${JSON.stringify(routeSummaries, null, 2)}

For each route, craft the full narrative layer. Return EXACTLY this JSON array:
[
  {
    "id": "same-id-as-input — do not change",
    "title": "Evocative Route Name (e.g. 'The Storm King Loop', 'Palisades Ridge Run')",
    "difficulty": "easy|moderate|challenging",
    "community_score": 4.7,
    "source_count": 340,
    "tags": ["scenic", "twisty", "half-day"],
    "highway_desc": "1-2 sentences: how you escape the city and get to the good stuff",
    "parkway_desc": "1-2 sentences: the parkway transition — what changes, what opens up",
    "twisty_desc": "2-3 sentences: the highlight section — what makes it memorable for a rider",
    "segments": [
      {"type":"city","color":"#E24B4A","label":"City / Highway","description":"...","duration":"22 min","miles":"14 mi"},
      {"type":"parkway","color":"#7F77DD","label":"Parkway","description":"...","duration":"28 min","miles":"24 mi"},
      {"type":"ride","color":"#34A853","label":"The Ride","description":"...","duration":"42 min","miles":"20 mi"}
    ],
    "colors": {"city":"#E24B4A","parkway":"#7F77DD","scenic":"#34A853"}
  }
]

Write like a rider who's done these roads a hundred times. Be specific about the named roads,
what the views look like, where the good curves are, and what makes each route feel different.
Return ONLY a raw JSON array. No markdown, no code fences. Start with [ and end with ].`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });

  let rawText = message.content[0].type === 'text' ? message.content[0].text : '[]';
  rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const narratives: EnrichedRoute[] = JSON.parse(rawText);

  // Merge: Claude's narrative layer + Gemini's spatial data
  // Gemini owns: waypoints, distance, duration (ground truth from Maps)
  // Claude owns: title, descriptions, difficulty, tags, segments (narrative layer)
  return geminiRoutes.map(geminiRoute => {
    const narrative = narratives.find(n => n.id === geminiRoute.id) ?? {} as EnrichedRoute;
    return {
      ...narrative,
      id: geminiRoute.id,
      destination,
      start_location: start,
      distance_mi: geminiRoute.distance_mi,
      duration_str: geminiRoute.duration_str,
      waypoints: geminiRoute.waypoints,
    } as EnrichedRoute;
  });
}

// ── Edge function entry point ───────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { start, destination } = await req.json();
    if (!start || !destination) throw new Error('Missing start or destination');

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const backgroundWork = (async () => {
      const t0 = Date.now();
      try {
        // ── Step 1: Gemini discovers real scenic roads + GPS waypoints ──────
        // Try with Maps grounding first; fall back to training data if unavailable.
        console.log(`[Gemini] Discovering routes: ${start} → ${destination}`);
        let geminiRoutes: GeminiRoute[];
        try {
          geminiRoutes = await discoverRoutesWithGemini(start, destination, true);
        } catch (mapsErr) {
          console.warn('[Gemini] Maps grounding failed, retrying without grounding:', mapsErr.message);
          geminiRoutes = await discoverRoutesWithGemini(start, destination, false);
        }

        if (geminiRoutes.length === 0) {
          console.error('[Gemini] Returned 0 routes — aborting');
          return;
        }
        console.log(`[Gemini] Done in ${Date.now() - t0}ms`);

        // ── Steps 2a + 2b in PARALLEL ──────────────────────────────────────
        // Claude writes narrative; Google Maps Directions API snaps waypoints to road geometry.
        // These are fully independent — no reason to run them sequentially.
        const t1 = Date.now();
        console.log(`[Parallel] Starting Claude narrative + Google Maps geometry for ${geminiRoutes.length} routes`);

        const [enrichedRoutes, geojsonList] = await Promise.all([
          // 2a: Claude — narrative layer for all routes (single API call)
          enrichRoutesWithClaude(geminiRoutes, start, destination),

          // 2b: Google Maps Directions API — road geometry for each route (all in parallel)
          // Uses the same Google Maps road graph as Gemini → perfect waypoint alignment
          Promise.all(
            geminiRoutes.map(async (route) => {
              if (!Array.isArray(route.waypoints) || route.waypoints.length < 2) {
                return null;
              }
              console.log(`[Google Maps] Computing geometry for ${route.id}`);
              const geojson = await computeGoogleMapsRoute(route.waypoints);
              if (!geojson) {
                console.warn(`[Google Maps] Failed for ${route.id}, using straight-line fallback`);
                return straightLineGeoJSON(route.waypoints);
              }
              return geojson;
            })
          ),
        ]);

        console.log(`[Parallel] Claude + Google Maps done in ${Date.now() - t1}ms`);

        // ── Step 3: Merge + save all routes to Supabase in parallel ────────
        // Realtime fires on each INSERT → frontend renders routes incrementally.
        await Promise.all(
          enrichedRoutes.map((route, i) =>
            supabase
              .from('routes')
              .upsert(
                { ...route, geojson: geojsonList[i], is_stale: false },
                { onConflict: 'id', ignoreDuplicates: false }
              )
              .then(({ error }) => {
                if (error) console.error(`[Supabase] Upsert failed for ${route.id}:`, error.message);
                else console.log(`[Supabase] Saved ${route.id} ✓`);
              })
          )
        );

        console.log(`[Done] Total generation time: ${Date.now() - t0}ms`);
      } catch (bgErr) {
        console.error('Background route generation failed:', bgErr.message);
      }
    })();

    EdgeRuntime.waitUntil(backgroundWork);

    return new Response(JSON.stringify({ status: 'generating' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
