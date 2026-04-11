import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── OpenRouteService routing ────────────────────────────────────────────────
// Takes Claude-generated lat/lng waypoints, returns a road-following GeoJSON.
// No avoid_features: scenic character comes from Claude's waypoints themselves.
// Large radiuses let ORS snap slightly off-road points to the nearest road.
async function computeORSRoute(
  waypoints: Array<{ lat: number; lng: number }>
): Promise<object | null> {
  const orsApiKey = Deno.env.get('ORS_API_KEY');
  if (!orsApiKey || waypoints.length < 2) return null;

  // ORS expects [lng, lat] pairs (GeoJSON order)
  const coordinates = waypoints.map(wp => [wp.lng, wp.lat]);
  // 500m snap radius — tight enough to prevent snapping across a river to the
  // wrong bank, loose enough to handle waypoints slightly off the road surface.
  const radiuses = waypoints.map(() => 500);

  try {
    const res = await fetch(
      'https://api.openrouteservice.org/v2/directions/driving-car/geojson',
      {
        method: 'POST',
        headers: {
          Authorization: orsApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json, application/geo+json',
        },
        body: JSON.stringify({
          coordinates,
          radiuses,
          continue_straight: true,  // prevent U-turns and backtracking at junctions
        }),
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error(`ORS error ${res.status}:`, errText);
      return null;
    }

    return await res.json(); // already a GeoJSON FeatureCollection
  } catch (err) {
    console.error('ORS fetch failed:', err.message);
    return null;
  }
}

// Straight-line fallback when ORS is unavailable
function straightLineGeoJSON(waypoints: Array<{ lat: number; lng: number }>) {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: waypoints.map(w => [w.lng, w.lat]),
        },
        properties: {},
      },
    ],
  };
}

// ── Edge function entry point ───────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { start, destination } = await req.json();
    if (!start || !destination) throw new Error('Missing start or destination');

    const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const prompt = `You are TwistyRoute, an expert motorcycle route planner for the NYC tri-state area (NY, NJ, CT).
Generate 2 distinct scenic motorcycle routes from "${start}" to "${destination}".

For each route return EXACTLY this JSON structure:
{
  "id": "short-kebab-slug",
  "title": "Evocative Route Name",
  "destination": "${destination}",
  "start_location": "${start}",
  "distance_mi": 58,
  "duration_str": "1h 42m",
  "difficulty": "moderate",
  "community_score": 4.7,
  "source_count": 340,
  "tags": ["scenic","twisty","half-day"],
  "highway_desc": "City streets escape description",
  "parkway_desc": "Parkway transition description",
  "twisty_desc": "The scenic twisty ride description",
  "segments": [
    {"type":"city","color":"#E24B4A","label":"City / Highway","description":"...","duration":"22 min","miles":"14 mi"},
    {"type":"parkway","color":"#7F77DD","label":"Parkway","description":"...","duration":"28 min","miles":"24 mi"},
    {"type":"ride","color":"#34A853","label":"The Ride","description":"...","duration":"42 min","miles":"20 mi"}
  ],
  "waypoints": [
    {"lat":40.762283,"lng":-73.918380,"label":"Start"},
    {"lat":40.8480,"lng":-73.9320,"label":"GW Bridge approach"},
    {"lat":40.8780,"lng":-73.9120,"label":"Palisades Pkwy entrance"},
    {"lat":40.9320,"lng":-73.9440,"label":"Palisades Pkwy N mile 10"},
    {"lat":41.0100,"lng":-73.9650,"label":"Rockland County"},
    {"lat":41.0850,"lng":-74.0120,"label":"Harriman area"},
    {"lat":41.1500,"lng":-73.9800,"label":"Tuxedo"},
    {"lat":41.2200,"lng":-73.9500,"label":"Sloatsburg"},
    {"lat":41.3112,"lng":-74.0039,"label":"Destination"}
  ],
  "colors": {"city":"#E24B4A","parkway":"#7F77DD","scenic":"#34A853"}
}

CRITICAL waypoints requirement:
- Include 10-15 waypoints tracing the EXACT road path, placed every 2-4 miles.
- Points must be ON real roads — use coordinates you are confident sit on the actual pavement of named roads (9W, Palisades Pkwy, Merritt Pkwy, Route 35, Storm King Hwy, etc.).
- NEVER place points in water, parks, forests, medians, or off the road surface. Snap radius is only 500m — if a point is off-road it will cause an error.
- RIVER CROSSINGS: If the route crosses the Hudson River, it must cross at exactly ONE named bridge (e.g. GW Bridge, Bear Mountain Bridge, Newburgh-Beacon Bridge). Place one waypoint on the approach road and one on the exit road immediately after the bridge. Never zigzag back across.
- Stay on one side of any river per leg — if you cross to the NJ/west side, all subsequent waypoints must remain on the west side until you intentionally cross back.
- Include start and destination as first and last points.
- For curvy roads add a point every 2-3 miles to capture the bends.
- The two routes must take meaningfully different roads.

Use real road names and insider rider knowledge. Prioritize scenic parkways and twisty back roads.
IMPORTANT: Return ONLY a raw JSON array. No markdown, no code fences, no backticks. Start with [ and end with ].`;

    // Return immediately — route computation runs in background
    const backgroundWork = (async () => {
      try {
        const message = await anthropic.messages.create({
          model: 'claude-sonnet-4-5',
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });

        let rawText = message.content[0].type === 'text' ? message.content[0].text : '[]';
        rawText = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const routes = JSON.parse(rawText);

        for (const route of routes) {
          let geojson: object | null = null;
          if (Array.isArray(route.waypoints) && route.waypoints.length >= 2) {
            geojson = await computeORSRoute(route.waypoints);
            if (!geojson) {
              console.warn(`ORS failed for ${route.id}, using straight-line fallback`);
              geojson = straightLineGeoJSON(route.waypoints);
            }
          }

          await supabase
            .from('routes')
            .upsert(
              { ...route, geojson, is_stale: false },
              { onConflict: 'id', ignoreDuplicates: false }
            );

          console.log(`Saved route ${route.id} (geojson: ${geojson ? 'yes' : 'no'})`);
        }
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
