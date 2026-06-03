-- announcement_dismissals: per-user record of which announcements they've
-- already dismissed. Lets a rider dismiss a notice on the web and have it
-- stay dismissed on their phone. (Phase 1 used localStorage — per device.)
--
-- The composite primary key prevents duplicate rows if a dismiss is fired
-- twice (e.g. realtime echo races a local optimistic update).

create table if not exists public.announcement_dismissals (
  user_id         uuid not null references auth.users(id) on delete cascade,
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  dismissed_at    timestamptz not null default now(),
  primary key (user_id, announcement_id)
);

create index if not exists announcement_dismissals_user_idx
  on public.announcement_dismissals (user_id);

alter table public.announcement_dismissals enable row level security;

-- Riders can see + manage only their own dismissals.
create policy "auth reads own dismissals"
  on public.announcement_dismissals for select
  to authenticated using (auth.uid() = user_id);

create policy "auth inserts own dismissals"
  on public.announcement_dismissals for insert
  to authenticated with check (auth.uid() = user_id);

create policy "auth deletes own dismissals"
  on public.announcement_dismissals for delete
  to authenticated using (auth.uid() = user_id);
