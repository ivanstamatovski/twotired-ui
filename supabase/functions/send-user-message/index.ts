// send-user-message edge function — v1.0
//
// Admin compose flow: POST { recipient_id, subject, body_html, body_text? }
// → looks up the rider's email via service-role read on auth.users
// → sends via Resend API
// → inserts the result into public.sent_messages
//
// Caller authentication: the admin portal includes its service-role key in
// the Authorization header (same pattern as the other Supabase REST calls
// from admin), so we trust callers that present a valid service-role JWT.
// The function itself doesn't accept anon JWTs — only service-role.

const SUPABASE_URL              = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY            = Deno.env.get('RESEND_API_KEY')!;
const SEND_USER_FROM            = Deno.env.get('SEND_USER_FROM')
                                  || 'TwoTired <support@twotired.net>';
const SEND_USER_REPLY_TO        = Deno.env.get('SEND_USER_REPLY_TO')
                                  || 'support@twotired.net';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ComposeBody {
  recipient_id?: string;
  subject?: string;
  body_html?: string;
  body_text?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return json({ error: 'POST only' }, 405);
  }

  // Require the service-role bearer (the admin portal sends it). Reject
  // anything else — we don't want random authenticated riders to use this
  // to spam other riders.
  const auth = req.headers.get('authorization') || '';
  if (!auth.includes(SUPABASE_SERVICE_ROLE_KEY.slice(-12))) {
    // Cheap signature check on the tail of the key. Cheap enough that we
    // catch the most obvious "user JWT instead of service" mistakes.
    // Anyone with the real service key could of course bypass; we trust
    // that the admin portal is the only thing with it.
    return json({ error: 'forbidden — service role required' }, 403);
  }

  let body: ComposeBody;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad json' }, 400);
  }

  const recipientId = (body.recipient_id || '').trim();
  const subject     = (body.subject || '').trim();
  const bodyHtml    = (body.body_html || '').trim();
  const bodyText    = (body.body_text || '').trim();

  if (!recipientId) return json({ error: 'recipient_id is required' }, 400);
  if (!subject)     return json({ error: 'subject is required' }, 400);
  if (!bodyHtml && !bodyText) return json({ error: 'body_html or body_text is required' }, 400);

  // Look up the rider's email via the admin Users API.
  let recipientEmail: string;
  try {
    const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${recipientId}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!userRes.ok) {
      const text = await userRes.text();
      return json({ error: `recipient lookup failed: ${userRes.status} ${text}` }, 400);
    }
    const user = await userRes.json();
    recipientEmail = user?.email;
    if (!recipientEmail) {
      return json({ error: 'recipient has no email on file' }, 400);
    }
  } catch (e: any) {
    return json({ error: `recipient lookup error: ${e?.message}` }, 500);
  }

  // Insert the pending row up front so we have a paper trail even if Resend
  // is down or the function crashes mid-way.
  const pendingRow = {
    recipient_id: recipientId,
    recipient_email: recipientEmail,
    subject,
    body_html: bodyHtml || null,
    body_text: bodyText || null,
    channel: 'email',
    status: 'pending',
  };
  let messageId: string | null = null;
  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/sent_messages`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(pendingRow),
    });
    if (insertRes.ok) {
      const inserted = await insertRes.json();
      messageId = inserted?.[0]?.id ?? null;
    } else {
      console.warn('[send-user-message] insert pending failed:', await insertRes.text());
    }
  } catch (e: any) {
    console.warn('[send-user-message] insert pending exception:', e?.message);
  }

  // Send via Resend.
  let resendOk = false;
  let resendErrorText = '';
  try {
    const html = bodyHtml || `<p>${escapeHtml(bodyText).replace(/\n/g, '<br>')}</p>`;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: SEND_USER_FROM,
        to: [recipientEmail],
        reply_to: SEND_USER_REPLY_TO,
        subject,
        html,
        text: bodyText || stripHtml(html),
      }),
    });
    if (res.ok) {
      resendOk = true;
    } else {
      resendErrorText = await res.text();
      console.error('[send-user-message] Resend error:', res.status, resendErrorText);
    }
  } catch (e: any) {
    resendErrorText = e?.message || String(e);
    console.error('[send-user-message] Resend exception:', resendErrorText);
  }

  // Flip the row to its final status.
  if (messageId) {
    const patchBody = resendOk
      ? { status: 'sent', sent_at: new Date().toISOString() }
      : { status: 'failed', error_text: resendErrorText };
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/sent_messages?id=eq.${messageId}`, {
        method: 'PATCH',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(patchBody),
      });
    } catch (e: any) {
      console.warn('[send-user-message] status patch failed:', e?.message);
    }
  }

  if (!resendOk) {
    return json({ error: 'send failed', detail: resendErrorText, message_id: messageId }, 500);
  }
  return json({ ok: true, message_id: messageId, recipient_email: recipientEmail }, 200);
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}
