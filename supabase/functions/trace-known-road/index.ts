// trace-known-road edge function — v1.0
//
// The RIGHT way to resolve a scenic chunk's geometry. Instead of routing
// between the two endpoints in GraphHopper (which returns the FASTEST path —
// often a different road than the named scenic one), this traces the ACTUAL
// OSM way(s) carrying the catalogued name/ref, assembles them into the real
// road, and extracts the stretch between the (projected) endpoints.
//
// Why it's better (see trim-known-roads for the problem it fixes):
//  - Two endpoints don't identify which of several roads is the scenic one —
//    the NAME does. We resolve by name/ref, so we follow the real road.
//  - Gives a reliable wrong-road signal: if NO OSM way with that name/ref
//    exists near the endpoints, the entry is genuinely misplaced (reject).
//  - The traced geometry is what the app should cache + ride (the anchor then
//    makes GH assemble routes through the REAL scenic road).
//
// SAFETY: reads/writes only approved-null rows. dry_run defaults TRUE (returns
// the trace without writing). On apply it updates start/end to the traced
// stretch's ends + caches the traced geometry.
//
// Body: { batch?, road_ids?[], sample?, dry_run? }
// Returns: { dry_run, processed, traced, not_found, results: [ {...} ] }

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const UA = 'twotired-routing/1.0 (ivan@easyaerial.com)';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const BBOX_PAD_DEG = 0.03; // ~2.5km around the endpoints to catch the whole road

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, tr = (d: number) => d * Math.PI / 180;
  const dLat = tr(bLat - aLat), dLng = tr(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(tr(aLat)) * Math.cos(tr(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ── Match terms from the catalog row ─────────────────────────────────────
const STOP_WORDS = new Set([
  'road', 'rd', 'street', 'st', 'avenue', 'ave', 'pike', 'lane', 'ln', 'drive', 'dr',
  'highway', 'hwy', 'route', 'rt', 'rte', 'county', 'cr', 'way', 'boulevard', 'blvd',
  'turnpike', 'tpke', 'loop', 'extension', 'ext', 'the', 'old', 'to', 'and',
  'north', 'south', 'east', 'west', 'area', 'section', 'stretch',
]);
function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function normalize(s: string): string {
  return s.toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function distinctiveTokens(part: string): string[] {
  return normalize(part).split(' ').filter((t) => t && !STOP_WORDS.has(t) && (t.length >= 3 || /^\d+$/.test(t)));
}
interface Terms { nameParts: string[]; partTokenSets: string[][]; searchWords: string[]; nums: string[] }
function extractTerms(name: string, routeNumber: string | null): Terms {
  const nameParts = name.replace(/\([^)]*\)/g, ' ').split('/').map((p) => p.trim()).filter((p) => p.length >= 4 && /[a-z]/i.test(p));
  const partTokenSets = nameParts.map(distinctiveTokens).filter((a) => a.length > 0);
  // Server-side search word per part: the longest proper-noun token, with any
  // apostrophe + trailing "s" trimmed so "Schooleys" still substring-matches
  // OSM's "Schooley's" (the client filter re-checks the full name).
  const searchWords = new Set<string>();
  for (const toks of partTokenSets) {
    const longest = toks.filter((t) => !/^\d+$/.test(t)).sort((a, b) => b.length - a.length)[0];
    if (longest && longest.length >= 4) searchWords.add(longest.replace(/s$/, ''));
  }
  // Route numbers (for ref matching).
  const nums = new Set<string>();
  const src = `${routeNumber || ''} ${name}`;
  for (const m of src.matchAll(/\b(?:route|rt|rte|nj|ny|pa|ct|ma|us|cr|co|sr)\b[\s-]*(\d+[a-z]?)/gi)) nums.add(m[1].toLowerCase());
  if (routeNumber) for (const m of routeNumber.matchAll(/(\d+[a-z]?)/gi)) nums.add(m[1].toLowerCase());
  return { nameParts, partTokenSets, searchWords: [...searchWords], nums: [...nums] };
}

// Build match terms from the resolver's road list (primary_roads) instead of
// the row name — so we trace the ACTUAL scenic roads Claude identified
// (e.g. "Neshanic Station Rd" not "202").
function termsFromRoads(roads: { name: string | null; ref: string | null }[]): Terms {
  const nameParts: string[] = [];
  const searchWords = new Set<string>();
  const nums = new Set<string>();
  for (const rd of roads) {
    if (rd?.name) {
      nameParts.push(rd.name);
      const toks = distinctiveTokens(rd.name);
      const longest = toks.filter((t) => !/^\d+$/.test(t)).sort((a, b) => b.length - a.length)[0];
      if (longest && longest.length >= 4) searchWords.add(longest.replace(/s$/, ''));
      for (const t of toks) if (/^\d+$/.test(t)) nums.add(t);
    }
    if (rd?.ref) for (const m of rd.ref.matchAll(/(\d+[a-z]?)/gi)) nums.add(m[1].toLowerCase());
  }
  const partTokenSets = nameParts.map(distinctiveTokens).filter((a) => a.length > 0);
  return { nameParts, partTokenSets, searchWords: [...searchWords], nums: [...nums] };
}

// Sample points along a polyline every ~spacingM meters (plus both ends) — the
// "right points on the correct road" that GH threads through so it can't
// shortcut a parallel road. Mirrors the app's v2.98 roadViaPoints.
function sampleVias(poly: number[][], spacingM: number): number[][] {
  if (poly.length < 2) return poly.slice();
  const out = [poly[0]];
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    acc += haversineM(poly[i-1][0], poly[i-1][1], poly[i][0], poly[i][1]);
    if (acc >= spacingM) { out.push(poly[i]); acc = 0; }
  }
  const last = poly[poly.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// ── Overpass: fetch ways matching the name/ref in the bbox ───────────────
interface Way { name: string | null; ref: string | null; nodes: number[]; coords: number[][]; } // coords [[lat,lng]]
async function overpass(q: string): Promise<any | null> {
  for (const url of [...OVERPASS_MIRRORS, OVERPASS_MIRRORS[0]]) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(55000),
      });
      if (!r.ok) continue;
      return await r.json();
    } catch { /* next mirror */ }
  }
  return null;
}
function refMatches(ref: string, nums: string[]): boolean {
  const r = ref.toLowerCase();
  for (const num of nums) if (new RegExp(`(^|[^0-9])${num}($|[^0-9])`).test(r)) return true;
  return false;
}
async function fetchNamedWays(s: number, w: number, n: number, e: number, terms: Terms): Promise<Way[] | null> {
  const bbox = `${s},${w},${n},${e}`;
  const clauses: string[] = [];
  // Server-side: broad substring on the distinctive word + ref-number contains.
  for (const wd of terms.searchWords) clauses.push(`way["highway"]["name"~"${regexEscape(wd)}",i](${bbox});`);
  for (const num of terms.nums)       clauses.push(`way["highway"]["ref"~"(^|[^0-9])${regexEscape(num)}($|[^0-9])",i](${bbox});`);
  if (clauses.length === 0) return [];
  const q = `[out:json][timeout:50];(${clauses.join('')});out geom;`;
  const d = await overpass(q);
  if (!d) return null;
  const cand: Way[] = [];
  for (const el of d.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || !Array.isArray(el.nodes)) continue;
    cand.push({ name: el.tags?.name || null, ref: el.tags?.ref || null, nodes: el.nodes, coords: el.geometry.map((g: any) => [g.lat, g.lon]) });
  }
  // Client-side confirm (apostrophe-insensitive): a way keeps if its normalized
  // name contains ALL distinctive tokens of some catalog name part, OR its ref
  // carries one of the route numbers.
  const keep: Way[] = [];
  for (const wy of cand) {
    const nmTokens = new Set(wy.name ? normalize(wy.name).split(' ').filter(Boolean) : []);
    let ok = terms.partTokenSets.some((toks) => toks.every((t) => nmTokens.has(t)));
    if (!ok && wy.ref) ok = refMatches(wy.ref, terms.nums);
    if (ok) keep.push(wy);
  }
  return keep;
}

// ── Assemble ways (shared endpoint nodes) into the longest connected chain ─
function assemble(ways: Way[]): number[][] {
  if (ways.length === 0) return [];
  if (ways.length === 1) return ways[0].coords;
  // endpoint node → way indices
  const endMap = new Map<number, number[]>();
  ways.forEach((wy, i) => {
    for (const nd of [wy.nodes[0], wy.nodes[wy.nodes.length - 1]]) {
      const a = endMap.get(nd) || []; a.push(i); endMap.set(nd, a);
    }
  });
  const used = new Set<number>();
  // pick a starting way: prefer one with a degree-1 endpoint (a terminus)
  let startIdx = 0;
  for (let i = 0; i < ways.length; i++) {
    const f = ways[i].nodes[0], l = ways[i].nodes[ways[i].nodes.length - 1];
    if ((endMap.get(f)?.length || 0) === 1 || (endMap.get(l)?.length || 0) === 1) { startIdx = i; break; }
  }
  // orient the start way so its terminus (or first node) leads
  let cur = ways[startIdx];
  used.add(startIdx);
  let chain = cur.coords.slice();
  let headNode = cur.nodes[0], tailNode = cur.nodes[cur.nodes.length - 1];
  if ((endMap.get(headNode)?.length || 0) === 1 && (endMap.get(tailNode)?.length || 0) !== 1) {
    // head is terminus → already leading; walk from tail
  } else if ((endMap.get(tailNode)?.length || 0) === 1) {
    chain = chain.slice().reverse(); [headNode, tailNode] = [tailNode, headNode];
  }
  // walk forward from tailNode
  let node = tailNode;
  for (let guard = 0; guard < ways.length + 2; guard++) {
    const cands = (endMap.get(node) || []).filter((i) => !used.has(i));
    if (cands.length === 0) break;
    const ni = cands[0]; const nw = ways[ni]; used.add(ni);
    let seg = nw.coords;
    if (nw.nodes[0] !== node) { seg = seg.slice().reverse(); node = nw.nodes[0]; }
    else { node = nw.nodes[nw.nodes.length - 1]; }
    chain = chain.concat(seg.slice(1)); // drop shared vertex
  }
  return chain;
}

function nearestIdx(lat: number, lng: number, poly: number[][]): { idx: number; distM: number } {
  let best = Infinity, bi = 0;
  for (let i = 0; i < poly.length; i++) {
    const d = haversineM(lat, lng, poly[i][0], poly[i][1]);
    if (d < best) { best = d; bi = i; }
  }
  return { idx: bi, distM: best };
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
  let rows: any[] = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/known_roads?select=id,name,route_number,state,start_lat,start_lng,end_lat,end_lng,resolved_roads&${filter}&order=name.asc`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!r.ok) return json({ error: `row fetch failed: ${r.status}` }, 500);
    rows = await r.json();
  } catch (e: any) { return json({ error: 'row fetch exception', detail: e?.message }, 500); }
  if (sample) rows = rows.slice(0, sample);

  const results: any[] = [];
  let traced = 0, notFound = 0;
  for (const row of rows) {
    const res: any = { id: row.id, name: row.name };
    // Prefer the resolver's identified roads over the row name — that's the
    // whole point (trace "Neshanic Station Rd", not "202").
    const resolved = row.resolved_roads;
    const primary = Array.isArray(resolved?.primary_roads) ? resolved.primary_roads.filter((r: any) => r && (r.name || r.ref)) : [];
    const useResolved = body.use_resolved !== false && primary.length > 0;
    const terms = useResolved ? termsFromRoads(primary) : extractTerms(row.name, row.route_number ?? null);
    res.term_source = useResolved ? 'resolved' : 'name';
    res.resolved_ride = useResolved ? primary.map((p: any) => p.name || p.ref) : undefined;
    res.match_terms = { searchWords: terms.searchWords, nums: terms.nums };
    if (terms.searchWords.length === 0 && terms.nums.length === 0) { res.status = 'no-terms'; res.note = 'no name/ref to match on'; results.push(res); continue; }

    const minLat = Math.min(row.start_lat, row.end_lat) - BBOX_PAD_DEG;
    const maxLat = Math.max(row.start_lat, row.end_lat) + BBOX_PAD_DEG;
    const minLng = Math.min(row.start_lng, row.end_lng) - BBOX_PAD_DEG;
    const maxLng = Math.max(row.start_lng, row.end_lng) + BBOX_PAD_DEG;
    const ways = await fetchNamedWays(minLat, minLng, maxLat, maxLng, terms);
    if (ways === null) { res.status = 'overpass-failed'; res.note = 'Overpass unavailable'; results.push(res); continue; }
    if (ways.length === 0) {
      res.status = 'not-found';
      res.note = `no OSM way named/ref'd like "${row.name}" within ~2.5km of the endpoints — likely wrong road, reject`;
      notFound++; results.push(res); continue;
    }

    const chain = assemble(ways);
    if (chain.length < 2) { res.status = 'assemble-failed'; res.note = 'matched ways but could not assemble a path'; results.push(res); continue; }

    // Project the catalog endpoints onto the traced road; the stretch between
    // them is the scenic chunk. If a projection is far from the road, that end
    // was off the named road.
    const ps = nearestIdx(row.start_lat, row.start_lng, chain);
    const pe = nearestIdx(row.end_lat, row.end_lng, chain);
    const iLo = Math.min(ps.idx, pe.idx), iHi = Math.max(ps.idx, pe.idx);
    const stretch = chain.slice(iLo, iHi + 1);
    let lenM = 0; for (let i = 1; i < stretch.length; i++) lenM += haversineM(stretch[i-1][0], stretch[i-1][1], stretch[i][0], stretch[i][1]);
    // orient start→end to match the catalog's intended direction
    const oriented = (ps.idx <= pe.idx) ? stretch : stretch.slice().reverse();
    const newStart = oriented[0], newEnd = oriented[oriented.length - 1];

    res.status = 'traced';
    res.matched_ways = ways.length;
    res.matched_names = [...new Set(ways.map((w) => w.name).filter(Boolean))].slice(0, 4);
    res.matched_refs  = [...new Set(ways.map((w) => w.ref).filter(Boolean))].slice(0, 4);
    res.start_proj_m = Math.round(ps.distM);
    res.end_proj_m   = Math.round(pe.distM);
    // Confidence from how far the catalog endpoints sat from the real named
    // road: close = coords were right; far = the entry was misplaced and the
    // trace RELOCATED it onto the real road (verify before trusting).
    const maxProj = Math.max(ps.distM, pe.distM);
    res.confidence = maxProj < 400 ? 'high' : maxProj < 1500 ? 'medium' : 'low';
    res.relocated = maxProj >= 1500;
    res.traced_km    = +(lenM / 1000).toFixed(2);
    res.new_start = [newStart[0], newStart[1]];
    res.new_end   = [newEnd[0], newEnd[1]];
    // The deliverable: ordered points on the correct road that GH threads.
    const vias = sampleVias(oriented, 1500);
    res.points = vias;          // [[lat,lng], ...] entry · vias · exit
    res.n_points = vias.length;
    res.maps = {
      before: `https://www.google.com/maps/dir/${row.start_lat},${row.start_lng}/${row.end_lat},${row.end_lng}`,
      after:  `https://www.google.com/maps/dir/${newStart[0]},${newStart[1]}/${newEnd[0]},${newEnd[1]}`,
    };
    res.note = `traced ${res.traced_km}km along ${res.matched_names.join(', ') || res.matched_refs.join(', ')} (endpoint proj: ${res.start_proj_m}m / ${res.end_proj_m}m)`;
    traced++;

    if (!dryRun) {
      const geometry = { type: 'LineString', coordinates: oriented.map((c) => [c[1], c[0]]) };
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/known_roads?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({
            start_lat: newStart[0], start_lng: newStart[1], end_lat: newEnd[0], end_lng: newEnd[1],
            geometry, geometry_fetched_at: new Date().toISOString(),
            admin_notes: `name-traced ${new Date().toISOString().slice(0,10)}: ${res.traced_km}km along ${res.matched_names.join(', ') || res.matched_refs.join(', ')}`,
          }),
        });
      } catch (_) { res.note = 'traced but DB write failed'; }
    }
    results.push(res);
  }

  return json({ dry_run: dryRun, processed: rows.length, traced, not_found: notFound, results }, 200);
});
