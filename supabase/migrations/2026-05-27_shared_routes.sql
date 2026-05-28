-- shared_routes: routes sent from one rider to another connected rider.
--
-- Sharer's app inserts a row when they tap "Share". Recipient's app sees it
-- via postgres_changes (same realtime path as friendships/positions).
--
-- Lifetime is persistent on the recipient side — they keep a "Shared with me"
-- inbox until they explicitly delete an entry. Either party can delete.
-- Privacy: only the recipient can read; only the sharer can insert.

create table if not exists public.shared_routes (
  id            uuid primary key default gen_random_uuid(),
  sharer_id     uuid not null references auth.users(id) on delete cascade,
  recipient_id  uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  distance_mi   double precision,
  duration_str  text,
  geometry      jsonb not null,           -- GeoJSON LineString { type, coordinates }
  stops         jsonb default '[]'::jsonb,
  intent        jsonb,                    -- preserves origin/destination/curviness for re-planning
  instructions  jsonb default '[]'::jsonb,
  shared_at     timestamptz not null default now(),
  viewed_at     timestamptz                  -- recipient first opened the share
);

create index if not exists shared_routes_recipient_idx
  on public.shared_routes(recipient_id, shared_at desc);
create index if not exists shared_routes_sharer_idx
  on public.shared_routes(sharer_id, shared_at desc);

alter table public.shared_routes enable row level security;

-- Sharer can insert their own outgoing shares, but ONLY to a user they have
-- an accepted friendship with. Prevents spamming arbitrary users.
create policy "sharer can insert to accepted friend"
  on public.shared_routes for insert to authenticated
  with check (
    auth.uid() = sharer_id
    and exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and (
          (f.user_id_a = auth.uid() and f.user_id_b = recipient_id) or
          (f.user_id_b = auth.uid() and f.user_id_a = recipient_id)
        )
    )
  );

-- Recipient can read what was shared with them.
create policy "recipient can read incoming"
  on public.shared_routes for select to authenticated
  using (auth.uid() = recipient_id);

-- Sharer can also read their outgoing shares (for confirmation / 'sent' state).
create policy "sharer can read outgoing"
  on public.shared_routes for select to authenticated
  using (auth.uid() = sharer_id);

-- Recipient can update viewed_at on rows shared with them.
create policy "recipient can mark viewed"
  on public.shared_routes for update to authenticated
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id);

-- Either party can delete.
create policy "either party can delete"
  on public.shared_routes for delete to authenticated
  using (auth.uid() = sharer_id or auth.uid() = recipient_id);

-- Broadcast inserts/updates/deletes via postgres_changes.
alter publication supabase_realtime add table public.shared_routes;
