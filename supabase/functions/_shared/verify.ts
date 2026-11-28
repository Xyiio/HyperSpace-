// Server-side helpers for the Supabase Edge Functions (Deno).
import { verifyMessage } from 'npm:viem@2.58.6';
import { createClient } from 'npm:@supabase/supabase-js@2.119.2';
import { MAX_AGE_MS, parseMessage, sha256Hex, type ParsedMessage, type SignedKind } from './proof.ts';

export const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

export const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

const HL_API = Deno.env.get('HYPERLIQUID_API_URL') ?? 'https://api.hyperliquid.xyz';

export async function hlInfo<T>(body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${HL_API}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Hyperliquid ${body.type}: HTTP ${r.status}`);
  return (await r.json()) as T;
}

/** Verifies a signed request and returns the parsed message, or an error Response. */
export async function verifyRequest(req: Request, kind: SignedKind): Promise<ParsedMessage | Response> {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body: { message?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const { message, signature } = body;
  if (typeof message !== 'string' || typeof signature !== 'string') return json({ error: 'message and signature required' }, 400);
  const parsed = parseMessage(message);
  if (!parsed || parsed.kind !== kind) return json({ error: 'Unrecognised message' }, 400);
  if (!/^0x[0-9a-f]{40}$/.test(parsed.address)) return json({ error: 'Invalid wallet' }, 400);
  if (!Number.isFinite(parsed.issuedAt) || Math.abs(Date.now() - parsed.issuedAt) > MAX_AGE_MS) return json({ error: 'Signature expired; sign again.' }, 400);
  const ok = await verifyMessage({ address: parsed.address as `0x${string}`, message, signature: signature as `0x${string}` }).catch(() => false);
  if (!ok) return json({ error: 'Signature does not match the wallet.' }, 401);
  return parsed;
}

/** The wallet behind a session token from chat-login, or null if missing or expired. */
export async function sessionAddress(db: ReturnType<typeof admin>, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !token) return null;
  const { data } = await db.from('chat_sessions').select('address, expires_at').eq('token_hash', await sha256Hex(token)).maybeSingle();
  return data && Date.parse(data.expires_at) > Date.now() ? (data.address as string) : null;
}

/** Sends a Telegram message through the HyperSpace bot. Needs the TELEGRAM_BOT_TOKEN secret. */
export async function telegram(chatId: number | string, text: string): Promise<boolean> {
  const bot = Deno.env.get('TELEGRAM_BOT_TOKEN');
  if (!bot) return false;
  const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  });
  return r.ok;
}

/** Cron-only functions check this shared secret (set CRON_SECRET and send it as x-cron-secret). */
export const cronAllowed = (req: Request) => {
  const want = Deno.env.get('CRON_SECRET');
  return !!want && req.headers.get('x-cron-secret') === want;
};
