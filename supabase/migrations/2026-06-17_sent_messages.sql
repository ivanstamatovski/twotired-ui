-- sent_messages — history of admin → user email communications.
--
-- Every time the admin composes a message to a specific user, the
-- send-user-message edge function inserts a row here AND sends the email.
-- Lets us see what we've sent to whom, when, and whether Resend accepted it.
-- Future: when we add an in-app mailbox, the same table backs the rider's
-- inbox view (they read their own rows via RLS).

create table if not exists public.sent_messages (
  id            uuid primary key default gen_random_uuid(),
  recipient_id  uuid references auth.users(id) on delete set null,
  recipient_email text,                              -- snapshot at send time (in case the user later changes email)
  sender_id     uuid references auth.users(id) on delete set null,
  subject       text not null,
  body_html     text,
  body_text     text,                                -- plain-text fallback / preview
  channel       text not null default 'email'        check (channel in ('email', 'in_app', 'push')),
  status        text not null default 'pending'      check (status in ('pending', 'sent', 'failed')),
  error_text    text,                                -- Resend error message if status = failed
  sent_at       timestamptz,                         -- populated when Resend accepts
  read_at       timestamptz,                         -- future use for in_app inbox
  created_at    timestamptz not null default now()
);

create index if not exists sent_messages_recipient_id_idx
  on public.sent_messages (recipient_id, created_at desc);
create index if not exists sent_messages_status_idx
  on public.sent_messages (status, created_at desc) where status != 'sent';

alter table public.sent_messages enable row level security;

-- Riders can read messages addressed to them (for the future in-app inbox).
create policy "users read their own messages"
  on public.sent_messages for select
  to authenticated
  using (recipient_id = auth.uid());

-- Writes are service-role only (admin via edge function). No public write policy.
