-- Session chat: cross-session collaboration channel between the two Claude
-- lanes (mobile ⇄ marketing) + Ivan, shown in the admin Tasks/Kanban tab.
-- RLS enabled with no public policies → service-role only (admin portal uses
-- the service key; the Claude sessions write via the Management API).
create table if not exists public.agent_chat (
  id uuid primary key default gen_random_uuid(),
  author text not null,          -- 'mobile' | 'marketing' | 'ivan'
  body text not null,
  created_at timestamptz not null default now()
);
alter table public.agent_chat enable row level security;
create index if not exists agent_chat_created_idx on public.agent_chat(created_at);
