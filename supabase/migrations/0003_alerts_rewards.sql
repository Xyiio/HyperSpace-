-- Phase 4: server-side alerts with Telegram, indicator ratings, idea scorecards, referrals and points.

-- Each wallet's alert list, copied up from the browser so the scheduled job can run it 24/7.
create table public.alerts_sync (
  address text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  alerts jsonb not null default '[]',
  state jsonb not null default '{}',   -- last price per coin, wallet fill cursors, funding flags
  fired jsonb not null default '{}',   -- alert id -> ms when the server last sent it
  updated_at timestamptz not null default now()
);

-- Telegram: a wallet links a chat by sending /start <code> to the bot.
create table public.telegram_links (
  address text primary key,
  chat_id bigint not null,
  linked_at timestamptz not null default now()
);
create table public.telegram_codes (
  code text primary key,
  address text not null,
  expires_at timestamptz not null
);
-- Per-wallet send log for rate limiting browser-triggered Telegram sends.
create table public.telegram_sends (
  id bigint generated always as identity primary key,
  address text not null,
  sent_at timestamptz not null default now()
);
create index telegram_sends_idx on public.telegram_sends (address, sent_at desc);

-- Small key/value store for job status (alerts-run last run, known markets, ...).
create table public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Indicator ratings: one per wallet per script, signed.
create table public.script_ratings (
  script_id uuid not null references public.scripts(id) on delete cascade,
  rater text not null check (rater ~ '^0x[0-9a-f]{40}$'),
  stars int not null check (stars between 1 and 5),
  signature text not null unique,
  created_at timestamptz not null default now(),
  primary key (script_id, rater)
);

-- Referrals: the referee signs once to confirm who referred them. First confirmation is final.
create table public.referrals (
  referee text primary key check (referee ~ '^0x[0-9a-f]{40}$'),
  referrer text not null check (referrer ~ '^0x[0-9a-f]{40}$' and referrer <> referee),
  signature text not null unique,
  created_at timestamptz not null default now()
);
create index referrals_referrer_idx on public.referrals (referrer);

-- Trading volume routed through HyperSpace (fills that paid the builder fee), filled by score-activity.
create table public.trade_points (
  address text primary key,
  volume numeric not null default 0,
  builder_fees numeric not null default 0,
  cursor_ms bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- Idea outcomes, filled by score-activity: target or stop, whichever price reached first.
alter table public.ideas add column outcome text check (outcome in ('target', 'stop'));
alter table public.ideas add column outcome_move numeric; -- fractional move in the idea's direction at resolution
alter table public.ideas add column resolved_at timestamptz;

create view public.idea_scorecards as
select
  author,
  count(*)::int as ideas,
  count(outcome)::int as resolved,
  count(*) filter (where outcome = 'target')::int as targets,
  count(*) filter (where outcome = 'stop')::int as stops,
  case when count(outcome) > 0 then (count(*) filter (where outcome = 'target'))::numeric / count(outcome) end as hit_rate,
  avg(outcome_move) as avg_move
from public.ideas
group by author;

create view public.script_rating_stats as
select script_id, avg(stars)::numeric(4, 2) as avg_rating, count(*)::int as ratings
from public.script_ratings
group by script_id;

create view public.creator_stats as
select
  s.author,
  count(distinct s.id)::int as scripts,
  sum(s.installs)::int as installs,
  count(r.*)::int as ratings,
  avg(r.stars)::numeric(4, 2) as avg_rating
from public.scripts s
left join public.script_ratings r on r.script_id = s.id
group by s.author;

-- Points (see POINT_RULES in src/pages/Rewards.tsx): an activity score, not a token.
create view public.points as
with addrs as (
  select author as address from public.ideas
  union select author from public.scripts
  union select rater from public.script_ratings
  union select referrer from public.referrals
  union select address from public.trade_points
),
p as (
  select
    a.address,
    (select count(*) from public.ideas i where i.author = a.address)::int as ideas,
    (select count(*) from public.ideas i where i.author = a.address and i.outcome = 'target')::int as targets,
    (select count(*) from public.scripts s where s.author = a.address)::int as scripts,
    coalesce((select sum(installs) from public.scripts s where s.author = a.address), 0)::int as installs,
    (select count(*) from public.script_ratings r where r.rater = a.address)::int as ratings_given,
    (select count(*) from public.referrals f where f.referrer = a.address)::int as referrals,
    coalesce((select floor(volume / 10000) from public.trade_points t where t.address = a.address), 0)::int as trading
  from addrs a
)
select *, (ideas * 5 + targets * 20 + scripts * 25 + installs + ratings_given + referrals * 10 + trading)::int as total
from p;

alter table public.alerts_sync enable row level security;
alter table public.telegram_links enable row level security;
alter table public.telegram_codes enable row level security;
alter table public.telegram_sends enable row level security;
alter table public.kv enable row level security;
alter table public.script_ratings enable row level security;
alter table public.referrals enable row level security;
alter table public.trade_points enable row level security;

-- Public reads only where the data is public anyway. Alerts, Telegram links and codes have no
-- policies, so only the edge functions (service role) can touch them.
create policy "ratings are public" on public.script_ratings for select using (true);
create policy "referrals are public" on public.referrals for select using (true);
create policy "trade points are public" on public.trade_points for select using (true);

grant select on public.idea_scorecards, public.script_rating_stats, public.creator_stats, public.points to anon, authenticated;
