-- stop_ratings — closing the loop on AI-suggested stops.
--
-- When the rider dwells at a stop the app suggested (coffee, lunch, scenic
-- overlook, etc), a one-tap survey fires asking how it was. The result feeds
-- back into route planning over time — places that score well get a
-- soft preference, places that score poorly get a soft penalty.
--
-- rating semantics:
--   -1 = thumbs down (don't suggest this place again)
--    0 = neutral / "meh"
--   +1 = thumbs up (suggest more often, mention in similar future routes)

create table if not exists public.stop_ratings (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) on delete set null,
  session_id    uuid not null,                          -- the nav arc that visited this stop
  stop_index    int not null,                           -- index in route.stops[]
  place_id      text,                                   -- Google places place_id when available
  place_name    text not null,
  place_type    text,                                   -- 'coffee shop' | 'lunch' | 'gas' | etc
  rating        smallint not null check (rating in (-1, 0, 1)),
  comment       text,
  created_at    timestamptz not null default now(),
  -- Prevent duplicate ratings for the same stop in the same session
  unique (session_id, stop_index)
);

create index if not exists stop_ratings_user_id_idx on public.stop_ratings (user_id, created_at desc);
create index if not exists stop_ratings_place_id_idx on public.stop_ratings (place_id) where place_id is not null;
create index if not exists stop_ratings_session_id_idx on public.stop_ratings (session_id);

alter table public.stop_ratings enable row level security;

-- Riders insert their own ratings (client writes directly via the Supabase JS
-- client during the survey).
create policy "users insert own stop ratings"
  on public.stop_ratings for insert
  to authenticated
  with check (user_id = auth.uid());

-- Riders read their own ratings (so we can show "you rated this place" in
-- future routes' stop detail).
create policy "users read own stop ratings"
  on public.stop_ratings for select
  to authenticated
  using (user_id = auth.uid());

-- Riders update their own (in case they want to change their rating later).
create policy "users update own stop ratings"
  on public.stop_ratings for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
