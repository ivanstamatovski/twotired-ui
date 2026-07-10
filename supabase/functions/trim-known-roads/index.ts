// trim-known-roads edge function — v1.0
//
// Auto-trims pending known_roads endpoints to replicate the manual editing
// pattern Ivan applied ~84 times by hand: pull each endpoint OUT of the urban
// area, onto a local through-road (not a city street), off any dead-end /
// no-outlet stub. It walks each endpoint INWARD along the GraphHopper-routed
// spine until the first point that is BOTH:
//   (a) outside residential/commercial/retail/industrial landuse, AND
//   (b) on a through-road class (primary/secondary/tertiary/unclassified + links).
// Landing mid-through-road inherently means the road continues past it → an
// outlet exists, so "blind road / no outlet" endpoints are resolved for free.
//
// SAFETY: only ever reads/writes rows with approved IS NULL. Approved roads are
// untouchable here. dry_run defaults to TRUE — it computes and returns
// before/after WITHOUT writing anything. Set dry_run:false to persist.
//
// Body:
//   {
//     "batch":    "nyc-philly-2026-07",  // scope to a seed_batch (optional)
//     "road_ids": ["uuid", ...],          // OR explicit ids (optional)
//     "sample":   4,                      // only process the first N (preview)
//     "dry_run":  true                    // default true; false = write trims
//   }
//
// Returns:
//   { dry_run, scoped, processed, changed, skipped, results: [ {...} ] }
//   result: { id, name, state, ok, changed, note,
//             start: { orig:[lat,lng], trimmed:[lat,lng]|null, trim_m, reason },
//             end:   { ... },
//             maps: { before, after } }

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GRAPHHOPPER_URL           = Deno.env.get('GRAPHHOPPER_URL')
                                  || 'https://molly.tail71232f.ts.net/gh';
const OVERPASS_URL              = 'https://overpass-api.de/api/interpreter';
const UA                        = 'twotired-routing/1.0 (ivan@easyaerial.com)';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ── Tuning ───────────────────────────────────────────────────────────────
const STEP_M         = 200;      // walk step along the spine
const MAX_TRIM_FRAC  = 0.45;     // search bound: don't look past this fraction of the road
const MAX_TRIM_M     = 9000;     // ...or this many meters, whichever is smaller
// AUTO-APPLY only small trims — an endpoint just needs to reach the nearest
// clean junction to be a good anchor connection point. A big trim means a long
// developed strip or (more likely) GH's spine is on the wrong road, so we FLAG
// it for review instead of silently eating into the scenic chunk.
const SMALL_TRIM_M   = 800;
const BBOX_PAD_DEG   = 0.02;     // pad the spine bbox for the Overpass fetch (~1.5km)
const NEAR_WAY_M     = 35;       // pre-snap gate: nearest highway within this
const NEAR_WAY_SNAP_M = 15;      // post-snap: point must actually BE on the through-road
const URBAN          = new Set(['residential', 'commercial', 'retail', 'industrial']);
// Through-road classes we're happy to END on (rural local roads + connectors).
// Everything else (residential, living_street, service, track, path, motorway,
// trunk…) is NOT an acceptable endpoint.
const THROUGH = new Set([
  'primary', 'secondary', 'tertiary', 'unclassified',
  'primary_link', 'secondary_link', 'tertiary_link',
]);

// ── Geometry helpers (meters via local equirectangular) ──────────────────
function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, tr = (d: number) => d * Math.PI / 180;
  const dLat = tr(bLat - aLat), dLng = tr(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(tr(aLat)) * Math.cos(tr(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// Distance from point P to segment A-B, in meters (local planar approx).
function distPtSegM(pLat: number, pLng: number, aLat: number, aLng: number, bLat: number, bLng: number): number {
  const latRef = (pLat + aLat + bLat) / 3;
  const mPerLat = 111320, mPerLng = 111320 * Math.cos(latRef * Math.PI / 180);
  const px = pLng * mPerLng, py = pLat * mPerLat;
  const ax = aLng * mPerLng, ay = aLat * mPerLat;
  const bx = bLng * mPerLng, by = bLat * mPerLat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}
function pointInRing(pLat: number, pLng: number, ring: number[][]): boolean {
  // ring: [[lat,lng], ...]; ray cast
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i][0], xi = ring[i][1];
    const yj = ring[j][0], xj = ring[j][1];
    const intersect = ((yi > pLat) !== (yj > pLat))
      && (pLng < (xj - xi) * (pLat - yi) / (yj - yi + 1e-15) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

interface Highway { cls: string; name: string | null; ref: string | null; pts: number[][]; } // pts: [[lat,lng], ...]
interface OSM { highways: Highway[]; urbanPolys: number[][][]; }

// ── Road-name matching (wrong-road detector) ─────────────────────────────
// Distinctive tokens only: drop road-type words, directions, connectors, and
// short fragments, keep proper-noun tokens + numbers (route refs).
const NAME_STOP = new Set([
  'road','rd','street','st','avenue','ave','pike','lane','ln','drive','dr',
  'highway','hwy','route','rt','rte','county','cr','way','boulevard','blvd',
  'turnpike','tpke','loop','extension','ext','north','south','east','west',
  'the','old','to','and','via','trail','pass','bridge','mountain','mtn','river',
]);
function nameTokens(s: string): Set<string> {
  const out = new Set<string>();
  // Strip apostrophes/possessives FIRST so "Schooley's" == "Schooleys",
  // then drop parentheticals + remaining punctuation.
  const cleaned = s.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/['’`]/g, '').replace(/[^a-z0-9 ]/g, ' ');
  for (const t of cleaned.split(/\s+/)) {
    if (!t) continue;
    if (NAME_STOP.has(t)) continue;
    if (t.length >= 3 || /^\d+$/.test(t)) out.add(t);
  }
  return out;
}

function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const tr = (d: number) => d * Math.PI / 180;
  const y = Math.sin(tr(bLng - aLng)) * Math.cos(tr(bLat));
  const x = Math.cos(tr(aLat)) * Math.sin(tr(bLat)) - Math.sin(tr(aLat)) * Math.cos(tr(bLat)) * Math.cos(tr(bLng - aLng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
// Does the point sit on a road that CONTINUES (an outlet), vs a dead-end/spur?
// Gather through-road vertices within R meters and require their bearings from
// the point to span a wide angle — a through-road has road on ~opposite sides,
// a stub/driveway end has everything clustered one way.
function hasOutlet(lat: number, lng: number, osm: OSM): boolean {
  const R = 50;
  const bearings: number[] = [];
  for (const hw of osm.highways) {
    if (!THROUGH.has(hw.cls)) continue;
    for (const [la, ln] of hw.pts) {
      const d = haversineM(lat, lng, la, ln);
      if (d > 3 && d <= R) bearings.push(bearingDeg(lat, lng, la, ln));
    }
  }
  if (bearings.length < 2) return false;
  let maxSpan = 0;
  for (let i = 0; i < bearings.length; i++) {
    for (let j = i + 1; j < bearings.length; j++) {
      let diff = Math.abs(bearings[i] - bearings[j]);
      if (diff > 180) diff = 360 - diff;
      if (diff > maxSpan) maxSpan = diff;
    }
  }
  return maxSpan >= 80;
}

// Which named/numbered roads does the route actually run ON? For each spine
// vertex, find the nearest way within TRAVERSE_M and tally by way identity;
// keep the ways that account for a meaningful share of the route (ignoring
// crossing streets a point or two touch). Returns the distinctive tokens of
// those dominant roads + a human label.
const TRAVERSE_M = 22;
function traversedRoads(spine: number[][], osm: OSM): { tokens: Set<string>; labels: string[]; named: boolean } {
  const tally = new Map<string, { count: number; name: string | null; ref: string | null }>();
  // Downsample the spine to ~cap points so the nearest-way scan stays cheap on
  // long roads (else O(vertices × ways × segments) can blow the CPU budget).
  const CAP = 60;
  const stride = Math.max(1, Math.floor(spine.length / CAP));
  const samples: number[][] = [];
  for (let i = 0; i < spine.length; i += stride) samples.push(spine[i]);
  for (const [lat, lng] of samples) {
    let bestD = Infinity, best: Highway | null = null;
    for (const hw of osm.highways) {
      for (let i = 1; i < hw.pts.length; i++) {
        const d = distPtSegM(lat, lng, hw.pts[i - 1][0], hw.pts[i - 1][1], hw.pts[i][0], hw.pts[i][1]);
        if (d < bestD) { bestD = d; best = hw; }
      }
    }
    if (!best || bestD > TRAVERSE_M) continue;
    const key = (best.ref || '') + '|' + (best.name || '');
    const e = tally.get(key) || { count: 0, name: best.name, ref: best.ref };
    e.count++; tally.set(key, e);
  }
  const threshold = Math.max(2, Math.floor(samples.length * 0.12));
  const tokens = new Set<string>();
  const labels: string[] = [];
  let named = false;
  for (const e of tally.values()) {
    if (e.count < threshold) continue;
    if (e.name) { for (const t of nameTokens(e.name)) tokens.add(t); labels.push(e.name); named = true; }
    if (e.ref)  { for (const t of nameTokens(e.ref))  tokens.add(t); if (!e.name) labels.push(e.ref); named = true; }
  }
  return { tokens, labels: [...new Set(labels)], named };
}

// Do the catalogued road name/number appear among the roads the route runs on?
// Returns wrong=true only when we have positively-named traversed roads and
// NONE of them share a distinctive token with the catalog entry (conservative —
// unnamed OSM roads → inconclusive → not flagged).
function wrongRoad(name: string, routeNumber: string | null, trav: ReturnType<typeof traversedRoads>):
  { wrong: boolean; catalogTerms: string[]; spineRoads: string[] } {
  const catalog = new Set<string>([...nameTokens(name), ...(routeNumber ? nameTokens(routeNumber) : [])]);
  const catalogTerms = [...catalog];
  // Decide ONLY on proper-noun tokens. Numbered routes (token = just a digit
  // string) are unreliable to judge — OSM tags the local segment name and the
  // ref match is spotty — so a number-only catalog entry is never flagged.
  const proper = catalogTerms.filter((t) => !/^\d+$/.test(t));
  if (!trav.named || proper.length === 0) return { wrong: false, catalogTerms, spineRoads: trav.labels };
  let overlap = false;
  for (const t of proper) if (trav.tokens.has(t)) { overlap = true; break; }
  return { wrong: !overlap, catalogTerms, spineRoads: trav.labels };
}

// Classify a point: nearest highway class + whether it sits in urban landuse.
// nearM caps how far the nearest way may be to count as "on" it — tight for the
// post-snap check (the point must actually BE on the through-road, not merely
// near one), looser for the cheap pre-snap gate.
function classifyPoint(lat: number, lng: number, osm: OSM, nearM = NEAR_WAY_M): { cls: string | null; urban: boolean; distM: number } {
  let bestD = Infinity, bestCls: string | null = null;
  for (const hw of osm.highways) {
    for (let i = 1; i < hw.pts.length; i++) {
      const d = distPtSegM(lat, lng, hw.pts[i - 1][0], hw.pts[i - 1][1], hw.pts[i][0], hw.pts[i][1]);
      if (d < bestD) { bestD = d; bestCls = hw.cls; }
    }
  }
  const cls = bestD <= nearM ? bestCls : null;
  let urban = false;
  for (const poly of osm.urbanPolys) { if (pointInRing(lat, lng, poly)) { urban = true; break; } }
  return { cls, urban, distM: bestD };
}

// ── External calls ───────────────────────────────────────────────────────
async function ghSpine(start: [number, number], end: [number, number]): Promise<number[][] | null> {
  // returns [[lng,lat], ...]
  try {
    const body = {
      points: [[start[1], start[0]], [end[1], end[0]]],
      profile: 'motorcycle', 'ch.disable': true, instructions: false,
      points_encoded: false,
    };
    const r = await fetch(`${GRAPHHOPPER_URL}/route`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const coords = d?.paths?.[0]?.points?.coordinates;
    return Array.isArray(coords) && coords.length >= 2 ? coords : null;
  } catch { return null; }
}

async function ghNearest(lat: number, lng: number): Promise<{ lat: number; lng: number; distM: number } | null> {
  try {
    const r = await fetch(`${GRAPHHOPPER_URL}/nearest?point=${lat},${lng}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const d = await r.json();
    const sLng = d?.coordinates?.[0], sLat = d?.coordinates?.[1], distM = d?.distance;
    if (sLat == null || sLng == null || distM == null) return null;
    return { lat: sLat, lng: sLng, distM };
  } catch { return null; }
}

// Public Overpass instances rotate under load; try several before giving up so
// the batch run doesn't silently skip ~25% of rows on a transient 429/timeout.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
async function overpassBbox(s: number, w: number, n: number, e: number): Promise<OSM | null> {
  const q = `[out:json][timeout:50];`
    + `(way[highway](${s},${w},${n},${e});`
    + `way[landuse~"^(residential|commercial|retail|industrial)$"](${s},${w},${n},${e}););`
    + `out geom;`;
  const attempts = [...OVERPASS_MIRRORS, OVERPASS_MIRRORS[0]]; // last = one retry of the primary
  for (const url of attempts) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(55000),
      });
      if (!r.ok) continue;
      const d = await r.json();
      const highways: Highway[] = [];
      const urbanPolys: number[][][] = [];
      for (const el of d.elements || []) {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const pts = el.geometry.map((g: any) => [g.lat, g.lon]);
        const t = el.tags || {};
        if (t.highway) highways.push({ cls: t.highway, name: t.name || null, ref: t.ref || null, pts });
        else if (t.landuse && URBAN.has(t.landuse)) urbanPolys.push(pts);
      }
      if (highways.length > 0) return { highways, urbanPolys };
      // empty highways = suspect response; try the next mirror
    } catch { /* try next mirror */ }
  }
  return null;
}

// Accept a point only if its FINAL (snapped) position is non-urban, on a
// through-road class, and has an outlet (not a dead-end/spur). Returns the
// snapped point + its snap distance, or null.
async function acceptCandidate(lat: number, lng: number, osm: OSM, snapFn: typeof ghNearest):
  Promise<{ pt: [number, number]; snapM: number; cls: string } | null> {
  // Cheap pre-filter on the raw point so we don't snap every step.
  const pre = classifyPoint(lat, lng, osm);
  if (pre.urban || !pre.cls || !THROUGH.has(pre.cls)) return null;
  // Snap to the GH edge, then RE-classify the snapped point with a TIGHT
  // tolerance — the snap can pull it onto a driveway/spur ~35m off the real
  // through-road; requiring the point to be within ~15m of a through-road
  // rejects that (the point must actually be ON the road, not near it).
  const s = await snapFn(lat, lng);
  const p: [number, number] = s ? [s.lat, s.lng] : [lat, lng];
  const post = classifyPoint(p[0], p[1], osm, NEAR_WAY_SNAP_M);
  if (post.urban || !post.cls || !THROUGH.has(post.cls)) return null;
  if (!hasOutlet(p[0], p[1], osm)) return null;
  return { pt: p, snapM: s?.distM ?? 0, cls: post.cls };
}

// Walk one end of the spine inward to the first acceptable endpoint.
// dir=+1 walks from the head (start), dir=-1 from the tail (end).
// spine is [[lat,lng], ...]. Returns the chosen (already-snapped) point.
async function trimEnd(spine: number[][], dir: 1 | -1, roadLenM: number, osm: OSM, snapFn: typeof ghNearest):
  Promise<{ pt: [number, number] | null; trimM: number; snapM: number; reason: string }> {
  const maxTrim = Math.min(MAX_TRIM_M, roadLenM * MAX_TRIM_FRAC);
  const n = spine.length;
  const idx0 = dir === 1 ? 0 : n - 1;
  // Is the original end already good (through-road, rural, has an outlet)?
  const orig = await acceptCandidate(spine[idx0][0], spine[idx0][1], osm, snapFn);
  if (orig) return { pt: orig.pt, trimM: 0, snapM: orig.snapM, reason: `already ${orig.cls}, rural` };

  let walked = 0;       // cumulative meters trimmed from the original end
  let sinceEval = 0;    // meters since the last candidate evaluation
  let prev = spine[idx0];
  let lastReason = 'no acceptable through-road found within trim budget';
  for (let step = 1; step < n; step++) {
    const i = dir === 1 ? step : n - 1 - step;
    const cur = spine[i];
    const seg = haversineM(prev[0], prev[1], cur[0], cur[1]);
    walked += seg; sinceEval += seg;
    prev = cur;
    if (walked > maxTrim) break;
    if (sinceEval < STEP_M) continue;   // only evaluate ~every STEP_M
    sinceEval = 0;
    const acc = await acceptCandidate(cur[0], cur[1], osm, snapFn);
    if (acc) return { pt: acc.pt, trimM: walked, snapM: acc.snapM, reason: `trimmed to ${acc.cls}, outside town, has outlet` };
    const c = classifyPoint(cur[0], cur[1], osm);
    lastReason = c.urban ? 'still in urban landuse' : (c.cls ? `on ${c.cls} (not a clean through-road / dead-end)` : 'no road nearby');
  }
  return { pt: null, trimM: 0, snapM: 0, reason: lastReason };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  // Service-role gate (same JWT-decode pattern as seed/validate).
  const auth = req.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  let role = '';
  try {
    const parts = token.split('.');
    if (parts.length >= 2) {
      let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      role = (JSON.parse(atob(p))?.role) || '';
    }
  } catch {}
  if (role !== 'service_role') return json({ error: 'forbidden — service role required', got_role: role || '(none)' }, 403);

  let body: any;
  try { body = await req.json(); } catch { body = {}; }
  const dryRun  = body.dry_run !== false; // default TRUE
  const batch   = typeof body.batch === 'string' ? body.batch : null;
  const roadIds = Array.isArray(body.road_ids) ? body.road_ids : null;
  const sample  = Number.isInteger(body.sample) && body.sample > 0 ? body.sample : null;

  // Fetch scoped PENDING rows only. approved=is.null is enforced server-side.
  let filter = 'approved=is.null';
  if (roadIds) filter += `&id=in.(${roadIds.map((x: string) => `"${x}"`).join(',')})`;
  else if (batch) filter += `&seed_batch=eq.${encodeURIComponent(batch)}`;
  const sel = 'id,name,state,start_lat,start_lng,end_lat,end_lng,length_km,seed_batch';
  let rows: any[] = [];
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/known_roads?select=${sel}&${filter}&order=name.asc`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    if (!r.ok) return json({ error: `row fetch failed: ${r.status}`, detail: await r.text() }, 500);
    rows = await r.json();
  } catch (e: any) {
    return json({ error: 'row fetch exception', detail: e?.message }, 500);
  }
  const scoped = rows.length;
  if (sample) rows = rows.slice(0, sample);

  const results: any[] = [];
  let changed = 0, skipped = 0, flaggedWrong = 0, flaggedReview = 0;

  for (const row of rows) {
    const res: any = { id: row.id, name: row.name, state: row.state, ok: false, changed: false };
    const spineLL: [number, number] = [row.start_lat, row.start_lng];
    const endLL:   [number, number] = [row.end_lat,   row.end_lng];

    const spineCoords = await ghSpine(spineLL, endLL); // [[lng,lat]]
    if (!spineCoords) { res.note = 'GH could not route the spine'; skipped++; results.push(res); continue; }
    const spine = spineCoords.map((c) => [c[1], c[0]]); // → [[lat,lng]]

    // spine length
    let roadLenM = 0;
    for (let i = 1; i < spine.length; i++) roadLenM += haversineM(spine[i-1][0], spine[i-1][1], spine[i][0], spine[i][1]);

    // Overpass over the padded spine bbox
    let minLat = 90, minLng = 180, maxLat = -90, maxLng = -180;
    for (const [la, ln] of spine) { minLat = Math.min(minLat, la); maxLat = Math.max(maxLat, la); minLng = Math.min(minLng, ln); maxLng = Math.max(maxLng, ln); }
    const osm = await overpassBbox(minLat - BBOX_PAD_DEG, minLng - BBOX_PAD_DEG, maxLat + BBOX_PAD_DEG, maxLng + BBOX_PAD_DEG);
    if (!osm) { res.note = 'Overpass unavailable — kept original (no guess)'; skipped++; results.push(res); continue; }

    res.ok = true;

    // Wrong-road ADVISORY: if the catalogued proper-name never appears on the
    // roads the route runs on, the entry may be on the wrong road. The spine is
    // a fastest-path guess between two endpoints — for a scenic road that's
    // often a DIFFERENT road — so this is a human-review hint, and we do NOT
    // trim suspects (trimming a wrong-road spine just moves the endpoint along
    // the wrong road).
    const trav = traversedRoads(spine, osm);
    const wr = wrongRoad(row.name, row.route_number ?? null, trav);
    const suspectWrong = wr.wrong;

    const empty = { pt: null as [number, number] | null, trimM: 0, snapM: 0, reason: 'skipped (wrong-road suspect)' };
    const startTrim = suspectWrong ? empty : await trimEnd(spine, 1, roadLenM, osm, ghNearest);
    const endTrim   = suspectWrong ? empty : await trimEnd(spine, -1, roadLenM, osm, ghNearest);

    // Categorize each end: good = already fine (no trim); small = apply;
    // large = trim too big, flag don't apply; unfixable = no clean point found.
    const cat = (t: typeof startTrim) =>
      t.pt !== null && t.trimM === 0 ? 'good'
      : t.pt !== null && t.trimM <= SMALL_TRIM_M ? 'small'
      : t.pt !== null ? 'large'
      : 'unfixable';
    const catS = suspectWrong ? 'skip' : cat(startTrim);
    const catE = suspectWrong ? 'skip' : cat(endTrim);

    const applyStart = catS === 'small', applyEnd = catE === 'small';
    const newStart = applyStart ? startTrim.pt : null;
    const newEnd   = applyEnd   ? endTrim.pt   : null;
    const needsReview = suspectWrong
      || catS === 'large' || catE === 'large'
      || catS === 'unfixable' || catE === 'unfixable';

    res.changed = applyStart || applyEnd;
    res.suspect_wrong_road = suspectWrong;
    res.needs_review = needsReview;
    if (suspectWrong) { res.spine_roads = wr.spineRoads; res.catalog_terms = wr.catalogTerms; flaggedWrong++; }
    if (needsReview) flaggedReview++;
    res.start = { orig: [row.start_lat, row.start_lng], cat: catS, trimmed: newStart, trim_m: Math.round(startTrim.trimM), reason: startTrim.reason };
    res.end   = { orig: [row.end_lat, row.end_lng],     cat: catE, trimmed: newEnd,   trim_m: Math.round(endTrim.trimM),   reason: endTrim.reason };
    const fS = newStart || [row.start_lat, row.start_lng];
    const fE = newEnd   || [row.end_lat, row.end_lng];
    res.maps = {
      before: `https://www.google.com/maps/dir/${row.start_lat},${row.start_lng}/${row.end_lat},${row.end_lng}`,
      after:  `https://www.google.com/maps/dir/${fS[0]},${fS[1]}/${fE[0]},${fE[1]}`,
    };

    const reasons: string[] = [];
    if (suspectWrong)         reasons.push(`possible wrong road — route runs on ${wr.spineRoads.join(', ') || 'an unnamed road'}, catalog says "${row.name}"`);
    if (catS === 'large')     reasons.push(`start needs a large ${Math.round(startTrim.trimM)}m trim (check wrong-road / far-off endpoint)`);
    if (catE === 'large')     reasons.push(`end needs a large ${Math.round(endTrim.trimM)}m trim`);
    if (catS === 'unfixable') reasons.push(`start can't reach a clean through-road (${startTrim.reason})`);
    if (catE === 'unfixable') reasons.push(`end can't reach a clean through-road (${endTrim.reason})`);
    res.note = (needsReview ? '⚠ VERIFY — ' + reasons.join('; ') + '. ' : '')
      + (res.changed ? `trimmed${applyStart ? ' start ' + res.start.trim_m + 'm' : ''}${applyEnd ? ' end ' + res.end.trim_m + 'm' : ''}` : 'no change');

    if (res.changed) changed++;

    if (!dryRun && (res.changed || needsReview)) {
      const patch: any = {};
      if (applyStart) { patch.start_lat = fS[0]; patch.start_lng = fS[1]; patch.snap_distance_m_start = startTrim.snapM; }
      if (applyEnd)   { patch.end_lat   = fE[0]; patch.end_lng   = fE[1]; patch.snap_distance_m_end   = endTrim.snapM; }
      const notes: string[] = [];
      if (res.changed) notes.push(`auto-trimmed ${new Date().toISOString().slice(0, 10)}:${applyStart ? ' start ' + res.start.trim_m + 'm' : ''}${applyEnd ? ' end ' + res.end.trim_m + 'm' : ''}`);
      if (needsReview) { const rv = '⚠ verify: ' + reasons.join('; '); notes.push(rv); patch.needs_coord_review = true; patch.coord_review_reason = rv; }
      patch.admin_notes = notes.join(' | ');
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/known_roads?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify(patch),
        });
      } catch (_) { res.note = 'computed but DB write failed'; }
    }
    results.push(res);
  }

  return json({ dry_run: dryRun, scoped, processed: rows.length, changed, flagged_wrong_road: flaggedWrong, flagged_review: flaggedReview, skipped, results }, 200);
});
