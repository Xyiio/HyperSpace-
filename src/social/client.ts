// Supabase client for profiles and trade ideas. Configured with VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY (the public anon key; never the service_role key).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildMessage, sha256Hex, type ChatLoginInput, type IdeaInput, type ProfileInput, type ScriptInput, type SignedKind } from '../../supabase/functions/_shared/proof';
import { LEADERBOARD_URL, reduceLeaderboard, type Leaderboard, type RawLeaderboardRow } from '../../supabase/functions/_shared/leaderboard';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const supabase: SupabaseClient | null = url && anon ? createClient(url, anon, { auth: { persistSession: false } }) : null;
export const socialEnabled = !!supabase;

export interface Profile {
  address: string;
  display_name: string;
  bio: string;
  twitter: string;
  created_at: string;
}

export interface Idea {
  id: string;
  author: string;
  coin: string;
  dex: string;
  direction: 'long' | 'short';
  entry: number | null;
  target: number | null;
  stop: number | null;
  timeframe: string;
  body: string;
  mark_at_post: number;
  snapshot: {
    position: { szi: string; entryPx: string | null; positionValue: string; unrealizedPnl: string } | null;
    accountValue: string;
    allTimePnl: string | null;
    readAt: number;
  };
  created_at: string;
}

export async function listIdeas(opts: { coin?: string; author?: string; limit?: number } = {}): Promise<Idea[]> {
  if (!supabase) return [];
  let q = supabase.from('ideas').select('*').order('created_at', { ascending: false }).limit(opts.limit ?? 50);
  if (opts.coin) q = q.eq('coin', opts.coin);
  if (opts.author) q = q.eq('author', opts.author.toLowerCase());
  const { data, error } = await q;
  if (error) throw error;
  return data as Idea[];
}

export async function getProfiles(addresses: string[]): Promise<Map<string, Profile>> {
  const map = new Map<string, Profile>();
  if (!supabase || addresses.length === 0) return map;
  const { data } = await supabase.from('profiles').select('*').in('address', [...new Set(addresses.map((a) => a.toLowerCase()))]);
  (data as Profile[] | null)?.forEach((p) => map.set(p.address, p));
  return map;
}

async function signedCall<T>(
  fn: string,
  kind: SignedKind,
  address: string,
  payload: IdeaInput | ProfileInput | ScriptInput | ChatLoginInput,
  sign: (m: string) => Promise<string>,
  extra: Record<string, unknown> = {},
) {
  if (!supabase) throw new Error('Ideas are not connected to a backend yet.');
  const message = buildMessage(kind, address, Date.now(), payload);
  const signature = await sign(message);
  const { data, error } = await supabase.functions.invoke(fn, { body: { message, signature, ...extra } });
  if (error) {
    // Surface the function's own error text when there is one.
    const ctx = (error as { context?: Response }).context;
    const detail = ctx ? await ctx.json().catch(() => null) : null;
    throw new Error(detail?.error ?? error.message);
  }
  return data as T;
}

async function call<T>(fn: string, body: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error('The community backend is not connected yet.');
  const { data, error } = await supabase.functions.invoke(fn, { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const detail = ctx ? await ctx.json().catch(() => null) : null;
    throw new Error(detail?.error ?? error.message);
  }
  return data as T;
}

export const postIdea = (address: string, idea: IdeaInput, sign: (m: string) => Promise<string>) =>
  signedCall<{ idea: Idea }>('post-idea', 'post-idea', address, idea, sign);

export const saveProfile = (address: string, p: ProfileInput, sign: (m: string) => Promise<string>) =>
  signedCall<{ profile: Profile }>('save-profile', 'save-profile', address, p, sign);

// ---------- Indicator marketplace ----------

export interface MarketScript {
  id: string;
  author: string;
  name: string;
  description: string;
  price_hs: number;
  version: number;
  installs: number;
  created_at: string;
  updated_at: string;
}

export async function listScripts(opts: { author?: string } = {}): Promise<MarketScript[]> {
  if (!supabase) return [];
  let q = supabase.from('scripts').select('id, author, name, description, price_hs, version, installs, created_at, updated_at').order('installs', { ascending: false }).limit(200);
  if (opts.author) q = q.eq('author', opts.author.toLowerCase());
  const { data, error } = await q;
  if (error) throw error;
  return (data as MarketScript[]).map((r) => ({ ...r, price_hs: Number(r.price_hs) }));
}

/** Code of a free script (paid code is released per buyer once the token launches). */
export async function getScriptCode(id: string): Promise<string> {
  if (!supabase) throw new Error('The marketplace is not connected yet.');
  const { data, error } = await supabase.from('script_code').select('code').eq('script_id', id).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('This indicator is paid; buying opens when the HYPERSPACE token launches.');
  void supabase.rpc('count_install', { sid: id });
  return (data as { code: string }).code;
}

export async function publishScript(
  address: string,
  meta: { scriptId: string | null; name: string; description: string; priceHs: number },
  code: string,
  sign: (m: string) => Promise<string>,
) {
  const payload: ScriptInput = { ...meta, codeSha256: await sha256Hex(code) };
  return signedCall<{ script: MarketScript }>('publish-script', 'publish-script', address, payload, sign, { code });
}

// ---------- Chat ----------

export interface ChatMessage {
  id: number;
  channel: string;
  author: string;
  body: string;
  created_at: string;
}

const chatKey = (address: string) => `hs.chat.${address.toLowerCase()}`;

export function chatSession(address: string): { token: string; expiresAt: string } | null {
  try {
    const raw = localStorage.getItem(chatKey(address));
    const s = raw ? (JSON.parse(raw) as { token: string; expiresAt: string }) : null;
    return s && Date.parse(s.expiresAt) > Date.now() ? s : null;
  } catch {
    return null;
  }
}

export async function chatLogin(address: string, sign: (m: string) => Promise<string>) {
  const r = await signedCall<{ token: string; expiresAt: string }>('chat-login', 'chat-login', address, { purpose: 'chat' }, sign);
  try {
    localStorage.setItem(chatKey(address), JSON.stringify(r));
  } catch {
    /* session lasts for this page only */
  }
  return r;
}

export function chatLogout(address: string) {
  try {
    localStorage.removeItem(chatKey(address));
  } catch {
    /* ignore */
  }
}

export async function chatPost(address: string, channel: string, body: string) {
  const s = chatSession(address);
  if (!s) throw new Error('Sign in to chat first.');
  try {
    return await call<{ message: ChatMessage }>('chat-post', { token: s.token, channel, body });
  } catch (e) {
    if (/sign in again/i.test((e as Error).message)) chatLogout(address);
    throw e;
  }
}

export async function listChat(channel: string, limit = 100): Promise<ChatMessage[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('chat_messages').select('*').eq('channel', channel).order('created_at', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as ChatMessage[]).reverse();
}

/** Live new messages in a channel. Returns an unsubscribe function. */
export function subscribeChat(channel: string, onMessage: (m: ChatMessage) => void): () => void {
  if (!supabase) return () => {};
  const ch = supabase
    .channel(`chat:${channel}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `channel=eq.${channel}` }, (p) => onMessage(p.new as ChatMessage))
    .subscribe();
  return () => {
    void supabase!.removeChannel(ch);
  };
}

// ---------- Leaderboard ----------

let lbCache: Leaderboard | null = null;

/**
 * Top Hyperliquid traders. Uses the cached backend copy when connected; otherwise reads
 * Hyperliquid's full leaderboard file directly (large, so it is cached for 10 minutes).
 */
export async function fetchLeaderboard(): Promise<Leaderboard & { source: 'backend' | 'direct' }> {
  if (lbCache && Date.now() - lbCache.fetchedAt < 10 * 60_000) return { ...lbCache, source: supabase ? 'backend' : 'direct' };
  if (supabase) {
    try {
      const d = await call<Leaderboard>('leaderboard', {});
      lbCache = d;
      return { ...d, source: 'backend' };
    } catch {
      /* fall back to the direct download */
    }
  }
  const r = await fetch(LEADERBOARD_URL);
  if (!r.ok) throw new Error(`Hyperliquid leaderboard: HTTP ${r.status}`);
  const { leaderboardRows } = (await r.json()) as { leaderboardRows: RawLeaderboardRow[] };
  lbCache = reduceLeaderboard(leaderboardRows);
  return { ...lbCache, source: 'direct' };
}
