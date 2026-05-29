// delete-account
//
// Apple App Store Guideline 5.1.1(v) requires apps that let users create
// accounts to also offer in-app account deletion. This function is the
// server side of that: it removes the caller's auth.users row, which
// cascades through every user-owned table (profiles, friendships,
// mate_positions, shared_routes) — see `on delete cascade` clauses in the
// migrations.
//
// Tables NOT cleaned by cascade (no user_id column today):
//   - routes        — saved routes, written without an owner column
//   - bug_reports   — user-submitted bug reports + screenshots
//   - route_logs    — full pipeline trace with user GPS coords
// These rows remain after deletion as anonymous data — none of them
// identify the deleted user via a foreign key. v1.1 should add user_id
// columns and wipe them here too.
//
// Security model:
//   - Caller must present a valid Supabase access-token JWT in the
//     Authorization header (their own token, obtained from supabase.auth).
//   - We verify the JWT and extract `sub` (the user's id). We never accept
//     a user_id parameter — callers can only delete themselves.
//   - The actual delete uses the service-role key so it can hit the
//     auth.users admin endpoint, which a normal user JWT cannot.
//
// Response shape:
//   200 { ok: true, deleted_user_id: "<uuid>" }
//   401 { error: "<reason>" }   — JWT missing/invalid/expired
//   500 { error: "<reason>" }   — Supabase Admin API failed

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY         = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST')     return json(405, { error: 'method not allowed' });

  // Pull the caller's access token out of the Authorization header.
  const authHeader = req.headers.get('Authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return json(401, { error: 'missing Authorization bearer token' });

  // Verify the JWT by asking Supabase Auth who it belongs to. This both
  // proves the token is valid AND tells us which user to delete — we never
  // trust a user_id from the request body.
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      apikey:        SUPABASE_ANON_KEY,
    },
  });
  if (!userRes.ok) {
    const text = await userRes.text().catch(() => '');
    return json(401, { error: `auth check failed: ${userRes.status} ${text.slice(0, 200)}` });
  }
  const user = await userRes.json() as { id?: string; email?: string };
  if (!user.id) return json(401, { error: 'auth check returned no user id' });

  console.log(`[delete-account] deleting user ${user.id} (${user.email ?? 'no email'})`);

  // Delete the auth.users row via the Supabase Admin API. Cascade FKs in
  // every user-owned table do the rest in a single transaction inside the
  // database. We pass `?should_soft_delete=false` so the row is fully
  // removed, not just marked deleted — Apple wants real deletion.
  const adminUrl = `${SUPABASE_URL}/auth/v1/admin/users/${user.id}?should_soft_delete=false`;
  const adminRes = await fetch(adminUrl, {
    method: 'DELETE',
    headers: {
      apikey:        SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });

  if (!adminRes.ok) {
    const text = await adminRes.text().catch(() => '');
    console.error(`[delete-account] admin delete failed: ${adminRes.status} ${text}`);
    return json(500, {
      error:       'failed to delete user',
      status:      adminRes.status,
      supabase:    text.slice(0, 500),
    });
  }

  return json(200, { ok: true, deleted_user_id: user.id });
});
