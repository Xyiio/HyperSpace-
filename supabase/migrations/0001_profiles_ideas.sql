-- HyperSpace phase 2: chartist profiles and trade ideas.
-- Reads are public. Writes go only through the post-idea and save-profile functions,
-- which verify a wallet signature and use the service role.

create table public.profiles (
  address text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  display_name text not null check (char_length(display_name) between 2 and 32),
  bio text not null default '',
  twitter text not null default '',
  signature text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ideas (
  id uuid primary key default gen_random_uuid(),
  author text not null check (author ~ '^0x[0-9a-f]{40}$'),
  coin text not null,
  dex text not null default '',
  direction text not null check (direction in ('long', 'short')),
  entry numeric,
  target numeric,
  stop numeric,
  timeframe text not null default '',
  body text not null check (char_length(body) between 10 and 2000),
  -- Price and the author's Hyperliquid state read by the server at posting time.
  mark_at_post numeric not null,
  snapshot jsonb not null,
  signed_message text not null,
  signature text not null,
  created_at timestamptz not null default now()
);

create unique index ideas_signature_idx on public.ideas (signature);
create index ideas_created_idx on public.ideas (created_at desc);
create index ideas_author_idx on public.ideas (author, created_at desc);
create index ideas_coin_idx on public.ideas (coin, created_at desc);

alter table public.profiles enable row level security;
alter table public.ideas enable row level security;

create policy "profiles are public" on public.profiles for select using (true);
create policy "ideas are public" on public.ideas for select using (true);
-- No insert/update/delete policies: only the service role (used by the functions) can write.
