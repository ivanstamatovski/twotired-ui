-- Tag known_roads rows with the seeding batch they came from, so the admin
-- can visually distinguish and filter a batch (e.g. the NYC<->Philadelphia
-- corridor seed) while reviewing/approving. Null = pre-batch / ad-hoc rows.
alter table public.known_roads
  add column if not exists seed_batch text;

create index if not exists known_roads_seed_batch_idx
  on public.known_roads (seed_batch);
