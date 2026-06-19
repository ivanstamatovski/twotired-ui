// seed-known-roads edge function — v1.0
//
// One-shot extractor: asks Claude Sonnet to enumerate every motorcycle-iconic
// road in our service area (NY/NJ/CT/MA/PA) and inserts the result into
// public.known_roads with approved=null (pending review). Admin reviews each
// entry and flips approved=true to make it eligible for the corridor planner.
//
// Triggered manually from the admin portal ("Seed catalog" button). Service
// role only. NOT cron'd — we want hand-review of the seed batch, then later
// runs add new categories ("the 10 best NJ Pine Barrens roads") incrementally.
//
// Body:
//   {
//     "states": ["NY","NJ"],          // optional, default all 5
//     "regions": ["Catskills"],       // optional narrow scope
//     "max_roads": 60,                // safety cap, default 80
//     "extra_prompt": "..."           // optional extra guidance, e.g. "focus on twisty primaries"
//   }
//
// Returns:
//   {
//     "inserted": 47,
//     "skipped_duplicates": 3,
//     "raw_count": 50,
//     "model": "claude-sonnet-4-6",
//     "input_tokens": 1234,
//     "output_tokens": 8765
//   }

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY         = Deno.env.get('ANTHROPIC_API_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const DEFAULT_STATES = ['NY','NJ','CT','MA','PA'];
const DEFAULT_MAX    = 80;

interface SeedBody {
  states?: string[];
  regions?: string[];
  max_roads?: number;
  extra_prompt?: string;
}

interface ClaudeRoad {
  name: string;
  route_number?: string | null;
  state: string;
  region?: string | null;
  start_lat: number;
  start_lng: number;
  end_lat: number;
  end_lng: number;
  length_km?: number | null;
  vibe_tags?: string[];
  difficulty?: number | null;
  curviness_tier?: number | null;
  best_for?: string[];
  caveats?: string | null;
  must_see?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  // Require service-role caller (same JWT-role check as send-user-message).
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  let role = '';
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      const payload = JSON.parse(atob(p));
      role = payload?.role || '';
    }
  } catch {}
  if (role !== 'service_role') {
    return json({ error: 'forbidden — service role required', got_role: role || '(none)' }, 403);
  }

  let body: SeedBody;
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const states    = (body.states && body.states.length ? body.states : DEFAULT_STATES)
                      .map(s => s.toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s));
  const regions   = body.regions || [];
  const maxRoads  = Math.min(Math.max(body.max_roads ?? DEFAULT_MAX, 5), 150);
  const extra     = (body.extra_prompt || '').trim();

  if (states.length === 0) return json({ error: 'no valid states' }, 400);

  // Build the extraction prompt. The key trick: we're asking Claude to
  // ENUMERATE knowledge that's already in its training data — forum
  // discussions, magazine articles, route databases, scenic-byway
  // designations. We force structured JSON output so the result is directly
  // ingestable.
  const systemPrompt = `
You are a motorcycle route expert. Your job is to enumerate iconic
motorcycle roads in a specific region from your training knowledge —
the kind of roads that show up in ADVrider threads, Rider magazine
"top 10" lists, RoadRunner features, RideWithGPS public collections,
and rider folklore. NOT generic scenic drives — specifically *roads
motorcyclists go out of their way to ride*.

Constraints:
- Real, named roads only. No invented or composite routes.
- Each row is one SEGMENT (start point → end point). If a famous road
  has multiple distinct stretches, emit multiple rows (e.g. "9W (Bear
  Mountain Bridge to Storm King)" and "9W (Palisades section)" are
  separate rows).
- start_lat/lng and end_lat/lng must be the actual lat/lng of the
  segment endpoints, to 6 decimal places, on the road itself (not a
  nearby city center). If you're unsure of exact coords, do NOT include
  the road — better to miss one than fabricate coordinates.
- length_km is approximate driving length of the segment.
- vibe_tags: pick from {twisty, iconic, panoramic, tight-tech,
  fast-sweeper, foliage, mountain, river-following, ridgeline, bridge,
  historic, switchback, dragon-grade, cruise}. Multiple allowed.
- difficulty: 1=cruise, 2=easy-curves, 3=moderate-twisty, 4=advanced,
  5=expert-only.
- curviness_tier: matches our app's 1/2/3 where 1=transit/efficient,
  2=scenic-balanced, 3=backroads-twisty.
- best_for: pick from {weekend, sunday-morning, weekday, fall-foliage,
  dawn, dusk, summer, off-season}.
- caveats: police presence, lack of services, seasonal closures.
- must_see: the *one* highlight per segment (overlook, bridge, gap).

Output STRICT JSON: { "roads": [ {...}, ... ] }. No prose, no markdown,
no preamble. Start the response with '{'.
`.trim();

  const userPrompt = `
Enumerate up to ${maxRoads} iconic motorcycle roads in: ${states.join(', ')}.
${regions.length ? `Focus regions: ${regions.join(', ')}.` : ''}
${extra ? `Additional guidance: ${extra}` : ''}

Quality over quantity — if you can only confidently list 30 with accurate
coordinates, list 30. Skip any road where you're unsure of the exact
endpoint lat/lng.
`.trim();

  // Call Sonnet.
  let claudeResp: any;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      return json({ error: 'claude failed', status: r.status, body: t }, 500);
    }
    claudeResp = await r.json();
    inputTokens  = claudeResp?.usage?.input_tokens  || 0;
    outputTokens = claudeResp?.usage?.output_tokens || 0;
  } catch (e: any) {
    return json({ error: 'claude exception', detail: e?.message }, 500);
  }

  const rawText = claudeResp?.content?.[0]?.text || '';
  let parsed: { roads?: ClaudeRoad[] };
  try {
    // Strip any accidental code fences just in case.
    const cleaned = rawText.replace(/^```json\s*|\s*```$/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e: any) {
    return json({
      error: 'claude returned non-JSON',
      detail: e?.message,
      preview: rawText.slice(0, 500),
    }, 500);
  }

  const roads = Array.isArray(parsed?.roads) ? parsed!.roads! : [];
  if (roads.length === 0) {
    return json({ error: 'claude returned zero roads', preview: rawText.slice(0, 500) }, 500);
  }

  // De-dupe against existing rows by (name, state). Insert the rest with
  // approved=null so the admin queue catches them for review.
  const existingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/known_roads?select=name,state`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
  );
  const existing = existingRes.ok ? await existingRes.json() : [];
  const existingKey = new Set<string>(
    (existing as any[]).map((r: any) => `${r.state}::${r.name.toLowerCase()}`)
  );

  const rowsToInsert: any[] = [];
  let skipped = 0;
  for (const r of roads) {
    if (!r?.name || !r?.state) { skipped++; continue; }
    if (typeof r.start_lat !== 'number' || typeof r.start_lng !== 'number'
        || typeof r.end_lat !== 'number' || typeof r.end_lng !== 'number') {
      skipped++; continue;
    }
    const key = `${r.state.toUpperCase()}::${r.name.toLowerCase()}`;
    if (existingKey.has(key)) { skipped++; continue; }
    existingKey.add(key);

    rowsToInsert.push({
      name:           r.name,
      route_number:   r.route_number || null,
      state:          r.state.toUpperCase(),
      region:         r.region || null,
      start_lat:      r.start_lat,
      start_lng:      r.start_lng,
      end_lat:        r.end_lat,
      end_lng:        r.end_lng,
      length_km:      r.length_km ?? null,
      vibe_tags:      Array.isArray(r.vibe_tags) ? r.vibe_tags : [],
      difficulty:     r.difficulty ?? null,
      curviness_tier: r.curviness_tier ?? null,
      best_for:       Array.isArray(r.best_for) ? r.best_for : [],
      caveats:        r.caveats || null,
      must_see:       r.must_see || null,
      source:         'claude_seed',
      approved:       null,
    });
  }

  let inserted = 0;
  if (rowsToInsert.length > 0) {
    const ins = await fetch(`${SUPABASE_URL}/rest/v1/known_roads`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(rowsToInsert),
    });
    if (!ins.ok) {
      const t = await ins.text();
      return json({ error: 'insert failed', detail: t, attempted: rowsToInsert.length }, 500);
    }
    const insBody = await ins.json();
    inserted = Array.isArray(insBody) ? insBody.length : 0;
  }

  return json({
    inserted,
    skipped_duplicates: skipped,
    raw_count: roads.length,
    model: 'claude-sonnet-4-6',
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  }, 200);
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
