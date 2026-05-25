-- Friendship plumbing for TwoTired ride-buddy tracking.
--
-- Two tables:
--   profiles      — one per auth user; stores display name + a 6-char share code
--   friendships   — pending/accepted pairs; one row per (a, b) with a < b
--
-- Conventions:
--   - user_id_a is always the lexicographically smaller UUID so each pair has
--     a single canonical row regardless of who initiated.
--   - status: 'pending' (a sent, b hasn't accepted) | 'accepted'
--   - initiated_by tells the UI which side sent the request.

-- ── profiles ────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null check (char_length(display_name) between 1 and 40),
  share_code    text not null unique check (share_code ~ '^[A-Z2-9]{6}$'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists profiles_share_code_idx on public.profiles(share_code);

alter table public.profiles enable row level security;

-- Everyone authenticated can read profiles by share_code or to display friend names.
-- (Email/UUID is never exposed via select; only display_name + share_code.)
create policy "profiles are readable by authenticated users"
  on public.profiles for select
  to authenticated using (true);

create policy "users can insert their own profile"
  on public.profiles for insert
  to authenticated with check (auth.uid() = user_id);

create policy "users can update their own profile"
  on public.profiles for update
  to authenticated using (auth.uid() = user_id);

-- ── friendships ─────────────────────────────────────────────────────────────
create table if not exists public.friendships (
  id            uuid primary key default gen_random_uuid(),
  user_id_a     uuid not null references auth.users(id) on delete cascade,
  user_id_b     uuid not null references auth.users(id) on delete cascade,
  status        text not null check (status in ('pending','accepted')),
  initiated_by  uuid not null references auth.users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (user_id_a < user_id_b),
  unique (user_id_a, user_id_b)
);

create index if not exists friendships_user_a_idx on public.friendships(user_id_a);
create index if not exists friendships_user_b_idx on public.friendships(user_id_b);

alter table public.friendships enable row level security;

create policy "users can see their own friendships"
  on public.friendships for select
  to authenticated using (auth.uid() in (user_id_a, user_id_b));

create policy "users can create friend requests they initiate"
  on public.friendships for insert
  to authenticated with check (
    auth.uid() = initiated_by
    and auth.uid() in (user_id_a, user_id_b)
    and status = 'pending'
  );

-- Accept / decline: the OTHER party can flip pending → accepted, and either
-- party can delete the row.
create policy "users can accept friend requests sent to them"
  on public.friendships for update
  to authenticated
  using (
    auth.uid() in (user_id_a, user_id_b)
    and status = 'pending'
    and auth.uid() <> initiated_by
  )
  with check (status = 'accepted');

create policy "users can delete their own friendships"
  on public.friendships for delete
  to authenticated using (auth.uid() in (user_id_a, user_id_b));

-- ── auto-create profile + share code on signup ─────────────────────────────
-- Generates a 6-char share code from a 30-char alphabet (A-Z minus I/O/Q,
-- digits 2-9) — ambiguous characters removed for easier verbal sharing.
create or replace function public.generate_share_code()
returns text
language plpgsql
as $$
declare
  alphabet text := 'ABCDEFGHJKLMNPRSTUVWXYZ23456789';
  code     text;
  collisions int;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    select count(*) into collisions from public.profiles where share_code = code;
    exit when collisions = 0;
  end loop;
  return code;
end $$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name, share_code)
  values (
    new.id,
    coalesce(split_part(new.email, '@', 1), 'Rider'),
    public.generate_share_code()
  )
  on conflict (user_id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for existing users (skips ones already with a profile).
insert into public.profiles (user_id, display_name, share_code)
select u.id,
       coalesce(split_part(u.email, '@', 1), 'Rider'),
       public.generate_share_code()
from auth.users u
left join public.profiles p on p.user_id = u.id
where p.user_id is null;
