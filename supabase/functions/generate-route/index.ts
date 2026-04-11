import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── OpenRouteService routing ────────────────────────────────────────────────
// Takes Claude-generated lat/lng waypoints, returns a road-following GeoJSON
// FeatureCollection using ORS with highway/tollway avoidance.
async function computeORSRoute(
  waypoints: Array<{ lat: number; lng: number }>
): Promise<object | null> {
  const orsApiKey = Deno.env.get('ORS_API_KEY');
  if (!orsApiKey || waypoints.length < 2) return null;

  // ORS expects [lng, lat] pairs (GeoJSON order)
  const coordinates = waypoints.map(wp => [wp.lng, wp.lat]);

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
          options: {
            avoid_features: ['highways', 'tollways'],
          },
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
    {"lat":40.762283,"lng":-73.918380,"label":"Start / Balancero Caffe"},
    {"lat":40.8480,"lng":-73.9320,"label":"GW Bridge toll plaza"},
    {"lat":40.8645,"lng":-73.9520,"label":"Palisades Pkwy entrance"},
    {"lat":40.9320,"lng":-73.9640,"label":"Palisades Pkwy mile 10"},
    {"lat":40.9990,"lng":-74.0010,"label":"Rockland County line"},
    {"lat":41.0850,"lng":-74.0320,"label":"Palisades Pkwy mile 25"},
    {"lat":41.1770,"lng":-74.0510,"label":"Bear Mountain junction"},
    {"lat":41.3112,"lng":-74.0039,"label":"Destination"}
  ],
  "colors": {"city":"#E24B4A","parkway":"#7F77DD","scenic":"#34A853"}
}

CRITICAL waypoints requirement — READ CAREFULLY:
- Include 10–15 waypoints that trace the EXACT road geometry from start to destination.
- Place points every 2–4 miles along the ACTUAL route — do NOT skip large gaps.
- For winding scenic roads (Storm King Hwy, 9W, Snake Hill Rd, etc.) add a point every 2–3 miles to capture the curves accurately.
- Every waypoint must sit ON a real road. Use your knowledge of exact road geometry for:
  • NY-9W, Palisades Interstate Pkwy, Bear Mountain State Pkwy
  • Storm King Highway (US-9W past Cornwall)
  • Route 17, Route 202, Route 206 in NJ
  • CT scenic routes: Rte 7, Rte 37, Rte 39
  • Any NJ/CT/NY county roads known to motorcyclists
- Include start point and destination as first and last waypoints.
- waypoints will be fed into a routing API (OpenRouteService) that snaps to the nearest road — so accuracy within ~500m is fine, but direction must be correct.
- DO NOT list just 4–5 major landmarks far apart. Trace the road.

Use real road names, exit numbers, and insider rider knowledge.
Prioritize fast city escape, scenic parkways, and community-recommended twisty roads.
Make the two routes meaningfully different (e.g. one via 9W/Palisades, one via NJ backroads).
IMPORTANT: Return ONLY a raw JSON array. No markdown, no code fences, no backticks, no explanation. Start with [ and end with ].`;

    // Return immediately — all heavy work runs in background via waitUntil
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
          // Compute ORS road-following GeoJSON from Claude's dense waypoints
          let geojson: object | null = null;
          if (Array.isArray(route.waypoints) && route.waypoints.length >= 2) {
            geojson = await computeORSRoute(route.waypoints);
            if (!geojson) {
              // ORS unavailable — fall back to straight lines between waypoints
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

    // Keep edge function alive until background work completes
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
