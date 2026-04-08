import Anthropic from 'npm:@anthropic-ai/sdk';
import { createClient } from 'npm:@supabase/supabase-js';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

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

    const prompt = `You are TwistyRoute, an expert motorcycle route planner for the NYC tri-state area.
Generate 2 scenic motorcycle routes from "${start}" to "${destination}".

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
    {"lat":40.762283,"lng":-73.918380,"label":"Balancero Caffe"},
    {"lat":41.3112,"lng":-74.0039,"label":"${destination}"}
  ],
  "colors": {"city":"#E24B4A","parkway":"#7F77DD","scenic":"#34A853"}
}

Use real road names, exit numbers, and insider rider knowledge.
Prioritize fast city escape, scenic parkways, and community-recommended twisty roads.
Return ONLY a valid JSON array. No markdown, no explanation.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    const rawText = message.content[0].type === 'text' ? message.content[0].text : '[]';
    const routes = JSON.parse(rawText);

    // Save to Supabase cache
    for (const route of routes) {
      await supabase.from('routes').upsert(route, { onConflict: 'id', ignoreDuplicates: false });
    }

    return new Response(JSON.stringify({ routes }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
