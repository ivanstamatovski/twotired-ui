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
interface Way { name: string | null; ref: string | null; nodes: number[]; coords: number[][]; pref: boolean; } // pref = a resolved/named scenic road
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
function isPreferred(name: string | null, ref: string | null, terms: Terms): boolean {
  const nmTokens = new Set(name ? normalize(name).split(' ').filter(Boolean) : []);
  if (terms.partTokenSets.some((toks) => toks.every((t) => nmTokens.has(t)))) return true;
  if (ref && refMatches(ref, terms.nums)) return true;
  return false;
}
const NONPUBLIC_HW = new Set(['service', 'track', 'path', 'footway', 'cycleway', 'pedestrian', 'steps', 'bridleway', 'construction', 'proposed', 'raceway', 'busway', 'corridor']);
// Fetch ALL public roads in the bbox, MARKING the ones that match the resolver's
// roads as preferred. We route over everything but strongly prefer the scenic
// roads — so short unnamed connectors can bridge them into one connected ride.
async function fetchRoads(s: number, w: number, n: number, e: number, terms: Terms): Promise<{ ways: Way[]; prefCount: number } | null> {
  const bbox = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:50];way["highway"](${bbox});out geom;`;
  const d = await overpass(q);
  if (!d) return null;
  const ways: Way[] = [];
  let prefCount = 0;
  for (const el of d.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || !Array.isArray(el.nodes)) continue;
    const hw = el.tags?.highway;
    if (!hw || NONPUBLIC_HW.has(hw) || ['private', 'no'].includes(el.tags?.access)) continue;
    const name = el.tags?.name || null, ref = el.tags?.ref || null;
    const pref = isPreferred(name, ref, terms);
    if (pref) prefCount++;
    ways.push({ name, ref, nodes: el.nodes, coords: el.geometry.map((g: any) => [g.lat, g.lon]), pref });
  }
  return { ways, prefCount };
}

// Trace the actual CONNECTED route through the matched (resolved) roads between
// the two rough endpoints — a shortest path over the road graph. This is robust
// to the original coords being on a DIFFERENT road (they're just rough bounds):
// we snap each to the nearest node of the resolved roads and route between them
// ALONG those roads. Fixes the naive-projection failure (0km / 20km-off traces).
// Binary min-heap for Dijkstra (the all-roads graph can be large).
class Heap {
  a: [number, number][] = [];
  push(x: [number, number]) { const a = this.a; a.push(x); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
  pop(): [number, number] | undefined { const a = this.a; if (!a.length) return undefined; const top = a[0], last = a.pop()!; if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2*i+1, r = 2*i+2; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
  get size() { return this.a.length; }
}
const PREF_W = 0.15, OTHER_W = 1.4;   // scenic roads are 9x cheaper than connectors
function tracePath(ways: Way[], start: [number, number], end: [number, number]):
  { path: number[][]; startProjM: number; endProjM: number; connected: boolean; prefFrac: number } | null {
  // Spatial filter so long spans (dense metro) stay tractable: keep preferred
  // (scenic) roads always, but non-preferred roads only near a scenic road — so
  // the graph is the scenic corridor + immediate connectors, not the whole city.
  const CELL = 0.0035;   // ~390m grid
  const cellKey = (lat: number, lng: number) => `${Math.round(lat / CELL)},${Math.round(lng / CELL)}`;
  const prefCells = new Set<string>();
  for (const wy of ways) if (wy.pref) for (const [la, ln] of wy.coords) {
    const gx = Math.round(la / CELL), gy = Math.round(ln / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) prefCells.add(`${gx+dx},${gy+dy}`);
  }
  const nearPref = (wy: Way) => wy.pref || wy.coords.some(([la, ln]) => prefCells.has(cellKey(la, ln)));

  const pos = new Map<number, [number, number]>();
  const adj = new Map<number, { to: number; w: number; len: number; pref: boolean }[]>();
  const addEdge = (a: number, b: number, len: number, pref: boolean) => { if (!adj.has(a)) adj.set(a, []); adj.get(a)!.push({ to: b, w: len * (pref ? PREF_W : OTHER_W), len, pref }); };
  const prefNodes = new Set<number>();
  for (const wy of ways) {
    if (wy.nodes.length !== wy.coords.length || !nearPref(wy)) continue;
    for (let i = 0; i < wy.nodes.length; i++) { pos.set(wy.nodes[i], [wy.coords[i][0], wy.coords[i][1]]); if (wy.pref) prefNodes.add(wy.nodes[i]); }
    for (let i = 1; i < wy.nodes.length; i++) {
      const len = haversineM(wy.coords[i-1][0], wy.coords[i-1][1], wy.coords[i][0], wy.coords[i][1]);
      addEdge(wy.nodes[i-1], wy.nodes[i], len, wy.pref); addEdge(wy.nodes[i], wy.nodes[i-1], len, wy.pref);
    }
  }
  if (pos.size === 0 || pos.size > 25000) return null;
  // Anchor A/B on the nearest PREFERRED (scenic) nodes — so the traced stretch
  // is the scenic road itself, with the rough coords as its bounds.
  let A = -1, B = -1, dA = Infinity, dB = Infinity;
  for (const id of prefNodes) {
    const [nl, nn] = pos.get(id)!;
    const da = haversineM(start[0], start[1], nl, nn); if (da < dA) { dA = da; A = id; }
    const db = haversineM(end[0], end[1], nl, nn);   if (db < dB) { dB = db; B = id; }
  }
  if (A < 0 || B < 0) return null;
  if (A === B) return { path: [pos.get(A)!], startProjM: dA, endProjM: dB, connected: true, prefFrac: 1 };
  // Dijkstra A→B on the weighted graph.
  const dist = new Map<number, number>([[A, 0]]); const prev = new Map<number, number>();
  const heap = new Heap(); heap.push([0, A]);
  while (heap.size) {
    const [d, u] = heap.pop()!;
    if (u === B) break;
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const { to, w } of adj.get(u) || []) {
      const nd = d + w;
      if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, u); heap.push([nd, to]); }
    }
  }
  if (!dist.has(B)) return { path: [], startProjM: dA, endProjM: dB, connected: false, prefFrac: 0 };
  // reconstruct + measure how much of the path is on preferred roads
  const nodePath: number[] = []; let cur: number | undefined = B;
  while (cur !== undefined) { nodePath.push(cur); cur = prev.get(cur); }
  nodePath.reverse();
  const path = nodePath.map((id) => pos.get(id)!);
  let total = 0, prefLen = 0;
  for (let i = 1; i < nodePath.length; i++) {
    const edge = (adj.get(nodePath[i-1]) || []).find((x) => x.to === nodePath[i]);
    if (edge) { total += edge.len; if (edge.pref) prefLen += edge.len; }
  }
  return { path, startProjM: dA, endProjM: dB, connected: true, prefFrac: total ? prefLen / total : 0 };
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

  // Explicit road_ids target those exact rows (any approval state — the caller
  // chose them; also lets us re-trace rejected rows). Batch/default only touch
  // pending rows.
  let filter: string;
  if (roadIds) filter = `id=in.(${roadIds.map((x: string) => `"${x}"`).join(',')})`;
  else if (batch) filter = `approved=is.null&seed_batch=eq.${encodeURIComponent(batch)}`;
  else filter = 'approved=is.null';
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
    const fetched = await fetchRoads(minLat, minLng, maxLat, maxLng, terms);
    if (fetched === null) { res.status = 'overpass-failed'; res.note = 'Overpass unavailable'; results.push(res); continue; }
    const ways = fetched.ways;
    if (fetched.prefCount === 0) {
      res.status = 'not-found';
      res.note = `no OSM way named/ref'd like "${row.name}" within ~2.5km of the endpoints — likely wrong road, reject`;
      notFound++; results.push(res); continue;
    }

    // Route through the resolved roads between the rough endpoints (connected
    // path), instead of naively projecting the — possibly wrong-road — coords.
    const tp = tracePath(ways, [row.start_lat, row.start_lng], [row.end_lat, row.end_lng]);
    if (!tp) { res.status = 'assemble-failed'; res.note = 'matched ways but could not build a graph'; results.push(res); continue; }
    if (!tp.connected || tp.path.length < 2) {
      res.status = 'disconnected';
      res.matched_names = [...new Set(ways.filter((w) => w.pref).map((w) => w.name).filter(Boolean))].slice(0, 4);
      res.note = `matched ${res.matched_names.join(', ')} but no public route connects them between the endpoints — needs review`;
      results.push(res); continue;
    }
    const oriented = tp.path;   // already start→end order
    let lenM = 0; for (let i = 1; i < oriented.length; i++) lenM += haversineM(oriented[i-1][0], oriented[i-1][1], oriented[i][0], oriented[i][1]);
    const newStart = oriented[0], newEnd = oriented[oriented.length - 1];

    const prefWays = ways.filter((w) => w.pref);
    res.matched_ways = prefWays.length;
    res.matched_names = [...new Set(prefWays.map((w) => w.name).filter(Boolean))].slice(0, 5);
    res.matched_refs  = [...new Set(prefWays.map((w) => w.ref).filter(Boolean))].slice(0, 4);
    res.start_proj_m = Math.round(tp.startProjM);
    res.end_proj_m   = Math.round(tp.endProjM);
    res.pref_frac    = +tp.prefFrac.toFixed(2);
    const maxProj = Math.max(tp.startProjM, tp.endProjM);
    res.traced_km    = +(lenM / 1000).toFixed(2);
    // Reject only degenerate traces: too short, or barely on the scenic roads
    // (mostly connectors → the resolved roads don't actually form the ride).
    // A far endpoint projection is a big RELOCATION, not a failure → low conf.
    if (res.traced_km < 0.8 || tp.prefFrac < 0.45) {
      res.status = 'poor-trace';
      res.note = `trace weak (${res.traced_km}km, ${Math.round(tp.prefFrac*100)}% on scenic roads) — flag, don't trust`;
      results.push(res); continue;
    }
    res.status = 'traced';
    res.confidence = maxProj < 400 && tp.prefFrac > 0.9 ? 'high' : maxProj < 1500 ? 'medium' : 'low';
    res.relocated = maxProj >= 1500;
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
