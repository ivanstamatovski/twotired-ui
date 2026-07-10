// resolve-known-road edge function — v1.0
//
// The SEMANTIC layer in front of the OSM tracer. A known_roads row was seeded
// by Claude from training lore as a BUNDLE of intent — name, route_number,
// must_see, caveats, vibe_tags, coords. The `name` (often a route number) is a
// rough corridor handle; the real scenic road frequently lives in `must_see`
// (a landmark/hamlet) while the caveats even warn the numbered highway is
// commercial. e.g. "NJ Route 202 (Somerville to Ringoes)" whose must_see is
// "Neshanic Station / South Branch Raritan valley" is really Neshanic Rd, not
// commercial US-202.
//
// This calls Claude with the FULL row context and asks it to name the actual
// road(s) a rider should ride (prioritising must_see over the route number),
// plus roads to AVOID. That structured output feeds trace-known-road, which
// turns names → real OSM geometry. Together: resolve intent → trace the road.
//
// SAFETY: read-only on the catalog by default. dry_run defaults TRUE and just
// returns the resolution. On apply it stores the resolution in `resolved_roads`
// (jsonb) for the tracer to consume — it never changes coords/approval itself.
//
// Body: { batch?, road_ids?[], sample?, dry_run? }

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANTHROPIC_API_KEY         = Deno.env.get('ANTHROPIC_API_KEY')!;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SYSTEM = `
You are a motorcycle-route geographer for the NY/NJ/CT/MA/PA region. You are
given a catalog entry for a scenic road segment that YOU (an earlier Claude)
generated from training lore. Your job now: identify the ACTUAL road(s) a rider
should ride to experience what the entry describes.

Critical rules:
- The entry's name / route number is often just a rough CORRIDOR handle, not the
  scenic road. PRIORITISE the "must_see" landmark and "caveats" over the number.
- If the caveats warn a numbered highway is commercial / high-traffic, the
  scenic road is almost always a PARALLEL BACK ROAD near the must_see landmark —
  name that back road, and put the highway in avoid_roads.
- Use real OSM-style road names you are confident exist in the given state/
  region near the endpoint coordinates. If unsure of a road's exact name, omit
  it — never invent a road name or number.
- Give the roads in the order they'd be ridden between the two endpoints.

Output STRICT JSON, starting with '{':
{
  "primary_roads": [ { "name": "<road name or null>", "ref": "<route ref like 'CR 567' / 'NJ 29' or null>" } ],
  "avoid_roads":   [ { "name": "<road>", "ref": "<ref or null>" } ],
  "waypoints":     [ "<landmark/hamlet the scenic road passes>" ],
  "confidence":    "high" | "medium" | "low",
  "reasoning":     "<one sentence: why these roads, and why not the named number if so>"
}
No prose, no markdown.
`.trim();

interface Resolution {
  primary_roads?: { name: string | null; ref: string | null }[];
  avoid_roads?: { name: string | null; ref: string | null }[];
  waypoints?: string[];
  confidence?: string;
  reasoning?: string;
}

async function resolveRow(row: any): Promise<{ resolution: Resolution | null; error?: string; in?: number; out?: number }> {
  const userPrompt = `
Catalog entry:
- name: ${row.name}
- route_number: ${row.route_number ?? '(none)'}
- state: ${row.state}   region: ${row.region ?? '(none)'}
- endpoints: start (${row.start_lat}, ${row.start_lng}) → end (${row.end_lat}, ${row.end_lng})
- approx length: ${row.length_km ?? '?'} km
- vibe_tags: ${(row.vibe_tags || []).join(', ') || '(none)'}
- difficulty: ${row.difficulty ?? '?'}/5   curviness_tier: ${row.curviness_tier ?? '?'}
- best_for: ${(row.best_for || []).join(', ') || '(none)'}
- must_see: ${row.must_see ?? '(none)'}
- caveats: ${row.caveats ?? '(none)'}

Identify the actual road(s) to ride. Remember: must_see + caveats outrank the route number.
`.trim();

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system: SYSTEM, messages: [{ role: 'user', content: userPrompt }] }),
    });
    if (!r.ok) return { resolution: null, error: `claude ${r.status}: ${(await r.text()).slice(0, 200)}` };
    const d = await r.json();
    const text = (d?.content?.[0]?.text || '').replace(/^```json\s*|\s*```$/g, '').trim();
    let parsed: Resolution;
    try { parsed = JSON.parse(text); }
    catch (e: any) { return { resolution: null, error: `non-JSON: ${text.slice(0, 160)}` }; }
    return { resolution: parsed, in: d?.usage?.input_tokens || 0, out: d?.usage?.output_tokens || 0 };
  } catch (e: any) {
    return { resolution: null, error: e?.message };
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);
  const auth = req.headers.get('authorization') || '';
  let role = '';
  try {
    const p = auth.replace(/^Bearer\s+/i, '').split('.');
    if (p.length >= 2) { let b = p[1].replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '='; role = JSON.parse(atob(b))?.role || ''; }
  } catch {}
  if (role !== 'service_role') return json({ error: 'forbidden — service role required' }, 403);

  let body: any; try { body = await req.json(); } catch { body = {}; }
  const dryRun  = body.dry_run !== false;
  const batch   = typeof body.batch === 'string' ? body.batch : null;
  const roadIds = Array.isArray(body.road_ids) ? body.road_ids : null;
  const sample  = Number.isInteger(body.sample) && body.sample > 0 ? body.sample : null;

  let filter = 'approved=is.null';
  if (roadIds) filter += `&id=in.(${roadIds.map((x: string) => `"${x}"`).join(',')})`;
  else if (batch) filter += `&seed_batch=eq.${encodeURIComponent(batch)}`;
  const sel = 'id,name,route_number,state,region,length_km,vibe_tags,difficulty,curviness_tier,best_for,caveats,must_see,start_lat,start_lng,end_lat,end_lng';
  let rows: any[] = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/known_roads?select=${sel}&${filter}&order=name.asc`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!r.ok) return json({ error: `row fetch failed: ${r.status}` }, 500);
    rows = await r.json();
  } catch (e: any) { return json({ error: 'row fetch exception', detail: e?.message }, 500); }
  if (sample) rows = rows.slice(0, sample);

  const results: any[] = [];
  let resolved = 0, failed = 0, inTok = 0, outTok = 0;
  for (const row of rows) {
    const { resolution, error, in: i, out: o } = await resolveRow(row);
    inTok += i || 0; outTok += o || 0;
    if (!resolution) { failed++; results.push({ id: row.id, name: row.name, error }); continue; }
    resolved++;
    const primary = (resolution.primary_roads || []).filter((r) => r && (r.name || r.ref));
    const avoid   = (resolution.avoid_roads || []).filter((r) => r && (r.name || r.ref));
    results.push({
      id: row.id, name: row.name, must_see: row.must_see,
      primary_roads: primary, avoid_roads: avoid,
      waypoints: resolution.waypoints || [], confidence: resolution.confidence, reasoning: resolution.reasoning,
    });
    if (!dryRun) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/known_roads?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ resolved_roads: { ...resolution, resolved_at: new Date().toISOString() } }),
        });
      } catch (_) { /* best-effort */ }
    }
  }
  return json({ dry_run: dryRun, processed: rows.length, resolved, failed, input_tokens: inTok, output_tokens: outTok, results }, 200);
});
