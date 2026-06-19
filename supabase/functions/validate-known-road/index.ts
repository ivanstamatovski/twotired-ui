// validate-known-road edge function — v1.0
//
// Called from admin when approving a row in the known_roads catalog. Re-snaps
// the start/end coords against GH's nearest-edge index and routes between
// them; returns ok/not-ok with details. If the row passes, the function
// flips approved=true. If it fails, the row stays pending and the admin
// can either edit the coords or pass override=true to approve anyway
// (useful when a road is in a region GH doesn't have OSM coverage for).
//
// Body:
//   { road_id: uuid, override?: boolean }
//
// Returns:
//   200 { ok:true,  validated_km, expected_km, ratio, snap_distance_m_start, snap_distance_m_end }
//   200 { ok:false, reason, ...details }
//   4xx { error }

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GRAPHHOPPER_URL           = Deno.env.get('GRAPHHOPPER_URL')
                                  || 'https://molly.tail71232f.ts.net/gh';

// Same thresholds as the seeder for consistency.
const SNAP_OK_M       = 200;
const SNAP_REVIEW_M   = 500;
// Length-ratio bounds: GH route should be within 0.5x..2x of Claude's
// claimed length_km. Tighter than that and Claude's length was wrong but
// the road is real; looser and the coords are pointing at the wrong road.
const LEN_RATIO_LOW   = 0.5;
const LEN_RATIO_HIGH  = 2.0;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')    return json({ error: 'POST only' }, 405);

  // Service-role required — same JWT-decode pattern as send-user-message.
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

  let body: { road_id?: string; override?: boolean };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }

  const roadId = (body.road_id || '').trim();
  const override = body.override === true;
  if (!roadId) return json({ error: 'road_id required' }, 400);

  // Fetch the row.
  let row: any;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/known_roads?id=eq.${roadId}&select=*`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!r.ok) return json({ error: `row fetch failed: ${r.status}` }, 500);
    const arr = await r.json();
    row = arr?.[0];
    if (!row) return json({ error: 'road not found' }, 404);
  } catch (e: any) {
    return json({ error: 'row fetch exception', detail: e?.message }, 500);
  }

  // If override, skip validation and just approve.
  if (override) {
    await patchRow(roadId, {
      approved: true,
      approved_at: new Date().toISOString(),
    });
    return json({ ok: true, override: true }, 200);
  }

  // Re-snap both endpoints.
  const startSnap = await snapPoint(row.start_lat, row.start_lng);
  const endSnap   = await snapPoint(row.end_lat,   row.end_lng);

  if (startSnap === null || endSnap === null) {
    return json({
      ok: false,
      reason: 'snap_failed',
      detail: 'GH /nearest unreachable or returned no edge for one or both endpoints',
    }, 200);
  }

  if (startSnap.distM > SNAP_REVIEW_M) {
    return json({
      ok: false,
      reason: 'start_too_far',
      detail: `Start coord is ${startSnap.distM.toFixed(0)}m from nearest road. Likely not on a road. Edit coord or override.`,
      snap_distance_m_start: startSnap.distM,
    }, 200);
  }
  if (endSnap.distM > SNAP_REVIEW_M) {
    return json({
      ok: false,
      reason: 'end_too_far',
      detail: `End coord is ${endSnap.distM.toFixed(0)}m from nearest road. Likely not on a road. Edit coord or override.`,
      snap_distance_m_end: endSnap.distM,
    }, 200);
  }

  // Route between the snapped endpoints.
  const routeKm = await routeBetween(
    { lat: startSnap.lat, lng: startSnap.lng },
    { lat: endSnap.lat,   lng: endSnap.lng   },
  );
  if (routeKm === null) {
    return json({
      ok: false,
      reason: 'gh_cannot_route',
      detail: 'GraphHopper failed to route between the two endpoints. Roads may be disconnected.',
      snap_distance_m_start: startSnap.distM,
      snap_distance_m_end: endSnap.distM,
    }, 200);
  }

  // Length check (only if Claude gave a length_km estimate).
  let ratio: number | null = null;
  if (typeof row.length_km === 'number' && row.length_km > 0) {
    ratio = routeKm / row.length_km;
    if (ratio < LEN_RATIO_LOW || ratio > LEN_RATIO_HIGH) {
      return json({
        ok: false,
        reason: 'length_mismatch',
        detail: `GH route is ${routeKm.toFixed(1)}km but Claude said the road is ${row.length_km}km (ratio ${ratio.toFixed(2)}). Coords may be pointing at the wrong road. Edit or override.`,
        validated_km: routeKm,
        expected_km: row.length_km,
        ratio,
      }, 200);
    }
  }

  // All checks pass. Persist the snapped coords + approval.
  await patchRow(roadId, {
    approved: true,
    approved_at: new Date().toISOString(),
    start_lat: startSnap.lat,
    start_lng: startSnap.lng,
    end_lat:   endSnap.lat,
    end_lng:   endSnap.lng,
    snap_distance_m_start: startSnap.distM,
    snap_distance_m_end:   endSnap.distM,
    route_validated_km:    routeKm,
    needs_coord_review:    false,
    coord_review_reason:   null,
  });

  return json({
    ok: true,
    validated_km: routeKm,
    expected_km: row.length_km,
    ratio,
    snap_distance_m_start: startSnap.distM,
    snap_distance_m_end: endSnap.distM,
  }, 200);
});

async function snapPoint(lat: number, lng: number): Promise<{ lat: number; lng: number; distM: number } | null> {
  try {
    const r = await fetch(`${GRAPHHOPPER_URL}/nearest?point=${lat},${lng}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const sLng = d?.coordinates?.[0];
    const sLat = d?.coordinates?.[1];
    const distM = d?.distance;
    if (sLat == null || sLng == null || distM == null) return null;
    return { lat: sLat, lng: sLng, distM };
  } catch {
    return null;
  }
}

async function routeBetween(start: { lat: number; lng: number }, end: { lat: number; lng: number }): Promise<number | null> {
  try {
    const body = {
      points: [[start.lng, start.lat], [end.lng, end.lat]],
      profile: 'motorcycle',
      'ch.disable': true,
      instructions: false,
      calc_points: false,
    };
    const r = await fetch(`${GRAPHHOPPER_URL}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const dist = d?.paths?.[0]?.distance;
    if (typeof dist !== 'number') return null;
    return dist / 1000;
  } catch {
    return null;
  }
}

async function patchRow(id: string, patch: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/known_roads?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(patch),
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}
