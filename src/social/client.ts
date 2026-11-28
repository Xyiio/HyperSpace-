// Supabase client for profiles and trade ideas. Configured with VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY (the public anon key; never the service_role key).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildMessage, sha256Hex, type ChatLoginInput, type IdeaInput, type ProfileInput, type RateInput, type ReferrerInput, type ScriptInput, type SignedKind } from '../../supabase/functions/_shared/proof';
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
  payload: IdeaInput | ProfileInput | ScriptInput | ChatLoginInput | RateInput | ReferrerInput,
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

// ---------- Wallet session (shared by chat, alerts sync and Telegram) ----------

/** The chat sign-in doubles as a general wallet session for token-authenticated calls. */
export const walletSession = chatSession;
export const walletLogin = chatLogin;

async function withSession<T>(address: string, fn: string, body: Record<string, unknown>): Promise<T> {
  const s = chatSession(address);
  if (!s) throw new Error('Sign in with your wallet first.');
  try {
    return await call<T>(fn, { token: s.token, ...body });
  } catch (e) {
    if (/sign in again/i.test((e as Error).message)) chatLogout(address);
    throw e;
  }
}

// ---------- Alerts and Telegram ----------

export interface AlertSyncStatus {
  telegramLinked: boolean;
  /** When the server last evaluated alerts (its cron job); null if it never has. */
  lastRun: string | null;
  /** Alert id → when the server last fired it. */
  fired: Record<string, number>;
}

export const syncAlertsRemote = (address: string, alerts: unknown[] | null) => withSession<AlertSyncStatus>(address, 'alerts-sync', alerts ? { alerts } : {});
export const telegramLink = (address: string) => withSession<{ code: string; bot: string | null }>(address, 'telegram-link', {});
export const telegramUnlink = (address: string) => withSession<{ ok: true }>(address, 'telegram-link', { unlink: true });
export const telegramSend = (address: string, title: string, body: string, link?: string) =>
  withSession<{ ok: true }>(address, 'telegram-send', { title, body, link: link ? `${location.origin}${location.pathname}${link}` : undefined });

// ---------- Ratings and creators ----------

export interface CreatorStats {
  author: string;
  scripts: number;
  installs: number;
  ratings: number;
  avg_rating: number | null;
}

export async function listCreators(): Promise<CreatorStats[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('creator_stats').select('*').order('installs', { ascending: false }).limit(100);
  if (error) throw error;
  return (data as CreatorStats[]).map((c) => ({ ...c, avg_rating: c.avg_rating === null ? null : Number(c.avg_rating) }));
}

export async function scriptRatings(): Promise<Map<string, { avg: number; count: number }>> {
  const map = new Map<string, { avg: number; count: number }>();
  if (!supabase) return map;
  const { data } = await supabase.from('script_rating_stats').select('*');
  (data as { script_id: string; avg_rating: number; ratings: number }[] | null)?.forEach((r) => map.set(r.script_id, { avg: Number(r.avg_rating), count: r.ratings }));
  return map;
}

export const rateScript = (address: string, scriptId: string, stars: number, sign: (m: string) => Promise<string>) =>
  signedCall<{ ok: true }>('rate-script', 'rate-script', address, { scriptId, stars }, sign);

// ---------- Idea scorecards ----------

export interface Scorecard {
  author: string;
  ideas: number;
  resolved: number;
  targets: number;
  stops: number;
  hit_rate: number | null;
  avg_move: number | null;
}

export async function getScorecards(addresses: string[]): Promise<Map<string, Scorecard>> {
  const map = new Map<string, Scorecard>();
  if (!supabase || !addresses.length) return map;
  const { data } = await supabase.from('idea_scorecards').select('*').in('author', [...new Set(addresses.map((a) => a.toLowerCase()))]);
  (data as Scorecard[] | null)?.forEach((s) => map.set(s.author, { ...s, hit_rate: s.hit_rate === null ? null : Number(s.hit_rate), avg_move: s.avg_move === null ? null : Number(s.avg_move) }));
  return map;
}

// ---------- Referrals ----------

export const setReferrer = (address: string, referrer: string, sign: (m: string) => Promise<string>) =>
  signedCall<{ ok: true }>('set-referrer', 'set-referrer', address, { referrer }, sign);

export interface ReferralStats {
  referrer: string;
  sharePct: number;
  referees: { address: string; joined: string; builderFees: number; volume: number }[];
  totalFees: number;
  earned: number;
  updatedAt: string;
}

export const referralStats = (address: string) => call<ReferralStats>('referral-stats', { address: address.toLowerCase() });

export async function myReferrer(address: string): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('referrals').select('referrer').eq('referee', address.toLowerCase()).maybeSingle();
  return (data as { referrer: string } | null)?.referrer ?? null;
}

// ---------- Points ----------

export interface PointsRow {
  address: string;
  ideas: number;
  targets: number;
  scripts: number;
  installs: number;
  ratings_given: number;
  referrals: number;
  trading: number;
  total: number;
}

export async function pointsBoard(limit = 100): Promise<PointsRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('points').select('*').order('total', { ascending: false }).limit(limit);
  if (error) throw error;
  return (data as PointsRow[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === 'address' ? v : Number(v)])) as unknown as PointsRow);
}

export async function myPoints(address: string): Promise<PointsRow | null> {
  if (!supabase) return null;
  const { data } = await supabase.from('points').select('*').eq('address', address.toLowerCase()).maybeSingle();
  return (data as PointsRow | null) ?? null;
}
