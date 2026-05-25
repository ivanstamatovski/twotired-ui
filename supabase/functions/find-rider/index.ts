// find-rider — look up a rider's profile by email so the caller can send them
// a friend request. Email lives in auth.users which isn't queryable from the
// client; this is the controlled way to translate email → user_id without
// exposing the full user list.
//
// POST { email: string }
// 200 { found: true,  profile: { user_id, display_name, share_code } }
// 200 { found: false }
// 401 if no valid auth token

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      },
    });
  }

  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  // Verify the caller is authenticated.
  const authHeader = req.headers.get('Authorization') || '';
  const userClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: cors });
  }

  let body: { email?: string } = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const email = (body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return new Response(JSON.stringify({ error: 'invalid email' }), { status: 400, headers: cors });
  }

  // Use service role to query auth.users by email.
  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // admin.listUsers doesn't support email filter directly; query via the admin endpoint.
  // Supabase v2 SDK exposes this as a paginated list, so we do a direct fetch for efficiency.
  const lookupRes = await fetch(
    `${Deno.env.get('SUPABASE_URL')}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    {
      headers: {
        apikey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        Authorization: `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!}`,
      },
    },
  );
  if (!lookupRes.ok) {
    return new Response(JSON.stringify({ error: 'lookup failed' }), { status: 502, headers: cors });
  }
  const lookup = await lookupRes.json();
  const target = (lookup.users || [])[0];
  if (!target) {
    return new Response(JSON.stringify({ found: false }), { headers: cors });
  }

  // Don't let users discover themselves this way; the UI should handle this anyway.
  if (target.id === user.id) {
    return new Response(JSON.stringify({ found: false, self: true }), { headers: cors });
  }

  const { data: profile, error: profErr } = await admin
    .from('profiles')
    .select('user_id, display_name, share_code')
    .eq('user_id', target.id)
    .single();

  if (profErr || !profile) {
    return new Response(JSON.stringify({ found: false }), { headers: cors });
  }

  return new Response(JSON.stringify({ found: true, profile }), { headers: cors });
});
