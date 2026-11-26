-- Phase 3: indicator marketplace, community chat, cached leaderboard.

-- Published HyperScript indicators. Listing details are public; the code is in a separate table.
create table public.scripts (
  id uuid primary key default gen_random_uuid(),
  author text not null check (author ~ '^0x[0-9a-f]{40}$'),
  name text not null,
  description text not null,
  price_hs numeric(20, 2) not null default 0 check (price_hs >= 0),
  version int not null default 1,
  installs int not null default 0,
  code_sha256 text not null,
  signature text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index scripts_author_idx on public.scripts (author);
create index scripts_installs_idx on public.scripts (installs desc);

-- Code is readable by anyone for free scripts. Paid code is served only after a verified
-- purchase, which turns on with the HYPERSPACE token launch.
create table public.script_code (
  script_id uuid primary key references public.scripts(id) on delete cascade,
  code text not null check (char_length(code) <= 20000)
);

-- Purchases (used from token launch): one row per buyer and script, proven by an on-chain transfer.
create table public.script_purchases (
  script_id uuid not null references public.scripts(id) on delete cascade,
  buyer text not null,
  tx_hash text not null unique,
  amount_hs numeric(20, 2) not null,
  created_at timestamptz not null default now(),
  primary key (script_id, buyer)
);

-- Chat: a wallet signs once to get a session token (stored hashed), then posts with it.
create table public.chat_sessions (
  token_hash text primary key,
  address text not null,
  expires_at timestamptz not null
);
create index chat_sessions_address_idx on public.chat_sessions (address);

create table public.chat_messages (
  id bigint generated always as identity primary key,
  channel text not null,
  author text not null,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index chat_messages_channel_idx on public.chat_messages (channel, created_at desc);

-- Leaderboard cache, refreshed by the leaderboard function at most every 10 minutes.
create table public.leaderboard_cache (
  id int primary key default 1 check (id = 1),
  data jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.scripts enable row level security;
alter table public.script_code enable row level security;
alter table public.script_purchases enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.leaderboard_cache enable row level security;

create policy "scripts are public" on public.scripts for select using (true);
create policy "free script code is public" on public.script_code for select
  using (exists (select 1 from public.scripts s where s.id = script_id and s.price_hs = 0));
create policy "purchases are public" on public.script_purchases for select using (true);
create policy "chat is public" on public.chat_messages for select using (true);
create policy "leaderboard is public" on public.leaderboard_cache for select using (true);
-- chat_sessions: no policies, so only the service role (edge functions) can read it.

-- Count an install (anyone may call; it only increments a counter).
create function public.count_install(sid uuid) returns void
language sql security definer set search_path = public as $$
  update public.scripts set installs = installs + 1 where id = sid;
$$;
grant execute on function public.count_install(uuid) to anon, authenticated;

-- Live chat over Supabase Realtime.
alter publication supabase_realtime add table public.chat_messages;
