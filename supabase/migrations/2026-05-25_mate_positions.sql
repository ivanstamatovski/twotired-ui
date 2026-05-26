-- mate_positions: durable per-recipient position rows for live tracking.
--
-- One row per (sharer, recipient) pair. Sharer upserts every ~5s while
-- their toggle is on, deletes the row when they toggle off. Recipient
-- watches via postgres_changes (more reliable than Realtime presence,
-- which is connection-bound and brittle on iOS WKWebView).
--
-- Privacy: row visible only to the recipient via RLS. Insert/update/delete
-- gated to the sharer.

create table if not exists public.mate_positions (
  sharer_id     uuid not null references auth.users(id) on delete cascade,
  recipient_id  uuid not null references auth.users(id) on delete cascade,
  lat           double precision not null,
  lng           double precision not null,
  updated_at    timestamptz not null default now(),
  primary key (sharer_id, recipient_id)
);

create index if not exists mate_positions_recipient_idx
  on public.mate_positions(recipient_id);

alter table public.mate_positions enable row level security;

create policy "sharer can insert own row"
  on public.mate_positions for insert to authenticated
  with check (auth.uid() = sharer_id);

create policy "sharer can update own row"
  on public.mate_positions for update to authenticated
  using (auth.uid() = sharer_id);

create policy "sharer can delete own row"
  on public.mate_positions for delete to authenticated
  using (auth.uid() = sharer_id);

create policy "recipient can see rows shared with them"
  on public.mate_positions for select to authenticated
  using (auth.uid() = recipient_id);

-- Broadcast changes via postgres_changes (same channel the toasts use).
alter publication supabase_realtime add table public.mate_positions;
