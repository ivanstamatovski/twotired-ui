-- service_costs — monthly subscription / usage tracking for everything
-- powering TwoTired. Lets Ivan see total burn at a glance without piecing
-- it together from N billing dashboards.
--
-- Variable usage-based services (Anthropic API, Google Places) get rough
-- monthly estimates that Ivan can refine when real bills land.

create table if not exists public.service_costs (
  id            uuid primary key default gen_random_uuid(),
  service_name  text        not null,                    -- "Vercel", "Supabase", "Anthropic API"
  plan_name     text,                                    -- "Pro", "Free", "Sonnet 4.6 usage"
  monthly_usd   numeric(10,2) not null default 0,        -- effective monthly cost (annualized for annual plans)
  annual_usd    numeric(10,2),                           -- raw annual cost for annual plans
  billing_cycle text not null default 'monthly'
                  check (billing_cycle in ('monthly','annual','usage','one_time')),
  category      text not null default 'other'
                  check (category in ('infra','ai','email','dev_tools','platform','domain','observability','other')),
  is_variable   boolean not null default false,          -- true for usage-based estimates
  status        text not null default 'active'
                  check (status in ('active','trial','paused','canceled')),
  started_at    date,
  url           text,                                    -- service dashboard or billing page link
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists service_costs_status_idx   on public.service_costs (status);
create index if not exists service_costs_category_idx on public.service_costs (category);

create or replace function public.service_costs_set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists service_costs_updated_at on public.service_costs;
create trigger service_costs_updated_at
  before update on public.service_costs
  for each row execute function public.service_costs_set_updated_at();

alter table public.service_costs enable row level security;
-- Reads + writes are admin-only via service role. No public RLS policies.

-- ── Seed with known services (idempotent — won't duplicate on re-run) ──
insert into public.service_costs (service_name, plan_name, monthly_usd, annual_usd, billing_cycle, category, is_variable, status, url, notes)
select * from (values
  ('Claude Code',         'Max ($200/mo)',         200.00, null,    'monthly', 'dev_tools',     false, 'active', 'https://claude.com/upgrade',                'Coding assistant — this conversation interface'),
  ('Supabase',            'Pro',                    25.00, null,    'monthly', 'infra',         false, 'active', 'https://supabase.com/dashboard/org/_/billing','DB + edge functions + auth + storage'),
  ('Anthropic API',       'Sonnet/Haiku usage',      5.00, null,    'usage',   'ai',            true,  'active', 'https://console.anthropic.com/settings/billing','Intent parsing + ride briefs + anchor briefs'),
  ('Google Places API',   'searchText calls',        5.00, null,    'usage',   'infra',         true,  'active', 'https://console.cloud.google.com/billing',  'Geocoding stops + destinations'),
  ('Apple Developer',     'Annual program',          8.25, 99.00,   'annual',  'platform',      false, 'active', 'https://developer.apple.com/account',       'App Store distribution; $99/year'),
  ('twotired.net',        'Domain registration',     1.00, 12.00,   'annual',  'domain',        false, 'active', 'https://vercel.com/domains',                'Estimated $12/year — please verify exact'),
  ('Vercel',              'Hobby (free)',            0.00, null,    'monthly', 'infra',         false, 'active', 'https://vercel.com/dashboard',              'Hosts twotired.net + admin.twotired.net'),
  ('Tailscale',           'Free (personal)',         0.00, null,    'monthly', 'infra',         false, 'active', 'https://login.tailscale.com/admin',         'Funnel for Molly home server'),
  ('ImprovMX',            'Free (forwarding only)',  0.00, null,    'monthly', 'email',         false, 'active', 'https://improvmx.com/dashboard',            'Inbound: *@twotired.net → ivanstamatovski@gmail.com'),
  ('Resend',              'Free (3k emails/mo)',     0.00, null,    'monthly', 'email',         false, 'active', 'https://resend.com/overview',               'Outbound: OTP + signup + admin messages'),
  ('GitHub',              'Free',                    0.00, null,    'monthly', 'dev_tools',     false, 'active', 'https://github.com/settings/billing',       'Source control'),
  ('Molly (electricity)', 'Home server estimate',    5.00, null,    'monthly', 'infra',         true,  'active', null,                                        'Rough estimate for the always-on i7-1165G7 + UPS; refine with kWh measurement'),
  ('OpenFreeMap tiles',   'Free hosted tiles',       0.00, null,    'monthly', 'infra',         false, 'active', 'https://openfreemap.org/',                  'Map tiles for MapLibre')
) as t(service_name, plan_name, monthly_usd, annual_usd, billing_cycle, category, is_variable, status, url, notes)
where not exists (
  select 1 from public.service_costs sc where sc.service_name = t.service_name
);
