// notify-signup edge function — v1.0
//
// Receives a Supabase Database Webhook payload when a new row is INSERTED
// into auth.users (a fresh signup) and sends Ivan an email via Resend.
//
// Configure the webhook in: Supabase dashboard → Database → Webhooks → Create
//   Source: auth.users  |  Event: INSERT  |  Method: POST
//   URL:    https://<project-ref>.supabase.co/functions/v1/notify-signup
//   Headers: x-webhook-secret: <NOTIFY_SIGNUP_SECRET from edge fn secrets>
//
// Secrets required:
//   RESEND_API_KEY         — full-access Resend API key (re_xxx...)
//   NOTIFY_SIGNUP_SECRET   — random string, shared between webhook + function
//   NOTIFY_SIGNUP_TO       — recipient email (e.g. ivan@easyaerial.com)
//   NOTIFY_SIGNUP_FROM     — sender, e.g. 'TwoTired <support@twotired.net>'

const RESEND_API_KEY       = Deno.env.get('RESEND_API_KEY')!;
const NOTIFY_SIGNUP_SECRET = Deno.env.get('NOTIFY_SIGNUP_SECRET') || '';
const NOTIFY_SIGNUP_TO     = Deno.env.get('NOTIFY_SIGNUP_TO')     || 'ivan@easyaerial.com';
const NOTIFY_SIGNUP_FROM   = Deno.env.get('NOTIFY_SIGNUP_FROM')   || 'TwoTired <support@twotired.net>';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), {
      status: 405, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // Verify shared secret. Optional but recommended — without it, anyone who
  // discovers the function URL could spam your inbox.
  if (NOTIFY_SIGNUP_SECRET) {
    const got = req.headers.get('x-webhook-secret') || '';
    if (got !== NOTIFY_SIGNUP_SECRET) {
      console.warn('[notify-signup] secret mismatch');
      return new Response(JSON.stringify({ error: 'forbidden' }), {
        status: 403, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'bad json' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  // Supabase Database Webhook payload shape:
  //   { type: 'INSERT', table: 'users', schema: 'auth', record: {...}, old_record: null }
  const rec = payload?.record;
  if (!rec) {
    return new Response(JSON.stringify({ error: 'no record in payload' }), {
      status: 400, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }

  const email     = rec.email || '(no email)';
  const id        = rec.id    || '(no id)';
  const provider  = rec.raw_app_meta_data?.provider || rec.app_metadata?.provider || 'email';
  const createdAt = rec.created_at || new Date().toISOString();
  const localTime = new Date(createdAt).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;padding:24px;background:#0f0f0f;color:#f0f0f0;border-radius:12px">
      <div style="font-size:24px;font-weight:800;color:#f97316;margin-bottom:18px">🏍️ New TwoTired signup</div>
      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:16px;margin-bottom:14px">
        <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Email</div>
        <div style="font-size:16px;font-weight:600">${escapeHtml(email)}</div>
      </div>
      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:16px;margin-bottom:14px">
        <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">Provider</div>
        <div style="font-size:14px">${escapeHtml(String(provider))}</div>
      </div>
      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:16px;margin-bottom:14px">
        <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">When</div>
        <div style="font-size:14px">${escapeHtml(localTime)} ET</div>
      </div>
      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:8px;padding:16px">
        <div style="color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">User ID</div>
        <div style="font-family:monospace;font-size:12px;color:#888">${escapeHtml(id)}</div>
      </div>
      <div style="margin-top:18px;font-size:11px;color:#555">
        Admin: <a href="https://admin.twotired.net" style="color:#f97316">admin.twotired.net</a>
      </div>
    </div>
  `;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: NOTIFY_SIGNUP_FROM,
        to: [NOTIFY_SIGNUP_TO],
        subject: `🏍️ New TwoTired signup: ${email}`,
        html,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('[notify-signup] Resend error:', res.status, errBody);
      return new Response(JSON.stringify({ error: 'resend failed', status: res.status, body: errBody }), {
        status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    console.log(`[notify-signup] emailed ${NOTIFY_SIGNUP_TO} about ${email}`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e: any) {
    console.error('[notify-signup] exception:', e?.message);
    return new Response(JSON.stringify({ error: e?.message || String(e) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});

function escapeHtml(s: string): string {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
