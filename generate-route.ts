import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    // Support both old { start, destination } and new { query } formats
    const userQuery: string = body.query || body.destination || '';
    const startLocation: string = body.start || 'Balancero cafe, Astoria, Queens, NY';

    if (!userQuery) {
      return new Response(JSON.stringify({ error: 'No query provided' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // ── Build enriched Gemini prompt ─────────────────────────────────────────
    const systemPrompt = `You are an expert motorcycle route planner for riders starting from ${startLocation} in New York.

You know every twisty, scenic road in the Northeast. You know which parkways flow well on a bike, where the best coffee stops are, which roads have been reviewed and loved by motorcyclists online, and how to get out of NYC quickly.

When given a rider's request, you plan a route that:
1. Gets out of the city as fast as possible (GW Bridge, Tappan Zee, or appropriate exit)
2. Transitions immediately to scenic, well-reviewed motorcycle roads
3. Follows the spirit of the rider's specific request (destination, vibe, stops)
4. Includes any coffee/food stops the rider mentions

You respond ONLY with valid JSON — no markdown, no code fences, just raw JSON.`;

    const userPrompt = `Rider's request: "${userQuery}"

Plan a motorcycle route from ${startLocation}.

Respond with this exact JSON structure:
{
  "title": "Short evocative route name (e.g. 'The Bear Mountain Loop')",
  "destination": "Primary destination name",
  "duration_str": "Total ride time (e.g. '2h 30min')",
  "distance_mi": "Total miles as a number string (e.g. '95')",
  "waypoints": [
    {"lat": 40.7719, "lng": -73.9303, "name": "Start: Balancero cafe, Astoria"},
    ... 6-12 waypoints along the actual route ...,
    {"lat": 41.3456, "lng": -74.8901, "name": "Destination name"}
  ],
  "segments": [
    {
      "label": "⚡ Quick City Exit",
      "color": "#e74c3c",
      "duration": "25 min",
      "miles": "18 mi",
      "description": "Detailed paragraph describing this part of the ride — roads taken, what to expect, any tips. Write like a knowledgeable local rider describing it to a friend. 3-5 sentences."
    },
    {
      "label": "🛣️ [Parkway/Bridge name]",
      "color": "#9b59b6",
      "duration": "20 min",
      "miles": "15 mi",
      "description": "..."
    },
    {
      "label": "🌲 [Scenic road or area name]",
      "color": "#2ecc71",
      "duration": "1h 30min",
      "miles": "60 mi",
      "description": "..."
    }
  ]
}

Use 3-5 segments total. If the rider asked for a coffee stop, include it as its own segment with a ☕ emoji label and name the specific cafe. Waypoints must be real coordinates along the route.`;

    // ── Call Gemini ──────────────────────────────────────────────────────────
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
          }
        })
      }
    );

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('[generate-route] Gemini error:', errText);
      return new Response(JSON.stringify({ error: 'Gemini API failed', detail: errText }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const geminiData = await geminiRes.json();
    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Strip any accidental markdown fences
    const jsonText = rawText.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    let routeData: any;
    try {
      routeData = JSON.parse(jsonText);
    } catch (e) {
      console.error('[generate-route] JSON parse failed:', jsonText.slice(0, 500));
      return new Response(JSON.stringify({ error: 'Failed to parse Gemini response', raw: jsonText.slice(0, 500) }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── Build GeoJSON from waypoints ─────────────────────────────────────────
    const waypoints = routeData.waypoints || [];
    const geojson = waypoints.length >= 2 ? {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: waypoints.map((w: any) => [w.lng, w.lat])
        },
        properties: {}
      }]
    } : null;

    // ── Save to Supabase ─────────────────────────────────────────────────────
    const { data: inserted, error: dbError } = await supabase
      .from('routes')
      .insert([{
        title: routeData.title || userQuery,
        destination: routeData.destination || userQuery,
        duration_str: routeData.duration_str || null,
        distance_mi: routeData.distance_mi || null,
        segments: routeData.segments || [],
        waypoints: waypoints,
        geojson: geojson,
        group_name: 'AI Generated',
        is_stale: false,
        community_score: 0,
      }])
      .select()
      .single();

    if (dbError) {
      console.error('[generate-route] DB insert error:', dbError.message);
      // Return the route even if DB save fails
      return new Response(JSON.stringify([{
        id: crypto.randomUUID(),
        title: routeData.title || userQuery,
        destination: routeData.destination || userQuery,
        duration_str: routeData.duration_str || null,
        distance_mi: routeData.distance_mi || null,
        segments: routeData.segments || [],
        waypoints: waypoints,
        geojson: geojson,
        group_name: 'AI Generated',
      }]), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify([inserted]), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err: any) {
    console.error('[generate-route] Unhandled error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
