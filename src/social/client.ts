// Supabase client for profiles and trade ideas. Configured with VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY (the public anon key; never the service_role key).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { buildMessage, type IdeaInput, type ProfileInput, type SignedKind } from '../../supabase/functions/_shared/proof';

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

async function signedCall<T>(fn: string, kind: SignedKind, address: string, payload: IdeaInput | ProfileInput, sign: (m: string) => Promise<string>) {
  if (!supabase) throw new Error('Ideas are not connected to a backend yet.');
  const message = buildMessage(kind, address, Date.now(), payload);
  const signature = await sign(message);
  const { data, error } = await supabase.functions.invoke(fn, { body: { message, signature } });
  if (error) {
    // Surface the function's own error text when there is one.
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
