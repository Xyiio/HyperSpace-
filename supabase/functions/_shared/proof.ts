// Signed-message format shared by the browser and the Supabase functions.
// Users sign a human-readable message with their wallet (personal_sign / EIP-191).
// The server verifies the signature, checks freshness, and stamps the post with the
// author's on-chain Hyperliquid state at that moment.

export const APP_NAME = 'HyperSpace';
export const MAX_AGE_MS = 5 * 60_000;

export interface IdeaInput {
  coin: string;
  direction: 'long' | 'short';
  entry: number | null;
  target: number | null;
  stop: number | null;
  timeframe: string; // e.g. "1d", free text up to 20 chars
  body: string;
}

export interface ProfileInput {
  displayName: string;
  bio: string;
  twitter: string;
}

export interface ScriptInput {
  scriptId: string | null; // null publishes a new script; an id updates your existing one
  name: string;
  description: string;
  priceHs: number; // 0 = free; otherwise a price in HYPERSPACE tokens
  codeSha256: string; // hash of the code sent alongside, so the signature covers it
}

export interface ChatLoginInput {
  purpose: 'chat';
}

export type SignedKind = 'post-idea' | 'save-profile' | 'publish-script' | 'chat-login';
type Payload = IdeaInput | ProfileInput | ScriptInput | ChatLoginInput;

const TITLES: Record<SignedKind, string> = {
  'post-idea': 'post a trade idea',
  'save-profile': 'update my profile',
  'publish-script': 'publish an indicator',
  'chat-login': 'sign in to chat',
};

/** The exact text the wallet signs. The JSON payload is on its own last line. */
export function buildMessage(kind: SignedKind, address: string, issuedAt: number, payload: Payload): string {
  return [
    `${APP_NAME}: ${TITLES[kind]}`,
    '',
    'This signature proves you own this wallet. It does not send a transaction or cost gas.',
    '',
    `Wallet: ${address.toLowerCase()}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Payload: ${JSON.stringify(payload)}`,
  ].join('\n');
}

export interface ParsedMessage {
  kind: SignedKind;
  address: string;
  issuedAt: number;
  payload: unknown;
}

export function parseMessage(message: string): ParsedMessage | null {
  const lines = message.split('\n');
  const head = lines[0];
  const kind = ((Object.keys(TITLES) as SignedKind[]).find((k) => head === `${APP_NAME}: ${TITLES[k]}`) ?? null) as SignedKind | null;
  const get = (prefix: string) => lines.find((l) => l.startsWith(prefix))?.slice(prefix.length);
  const address = get('Wallet: ');
  const issued = get('Issued: ');
  const payload = get('Payload: ');
  if (!kind || !address || !issued || !payload) return null;
  try {
    return { kind, address, issuedAt: Date.parse(issued), payload: JSON.parse(payload) };
  } catch {
    return null;
  }
}

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : NaN);

/** Validates an idea payload; returns an error message or the cleaned idea. */
export function validateIdea(p: unknown): IdeaInput | string {
  const o = p as Record<string, unknown>;
  if (!o || typeof o !== 'object') return 'Missing idea.';
  if (typeof o.coin !== 'string' || !/^[A-Za-z0-9:@/_-]{1,32}$/.test(o.coin)) return 'Invalid market.';
  if (o.direction !== 'long' && o.direction !== 'short') return 'Direction must be long or short.';
  const entry = num(o.entry);
  const target = num(o.target);
  const stop = num(o.stop);
  if ([entry, target, stop].some((x) => Number.isNaN(x))) return 'Prices must be positive numbers.';
  if (typeof o.body !== 'string' || o.body.trim().length < 10 || o.body.length > 2000) return 'Write 10 to 2,000 characters.';
  const timeframe = typeof o.timeframe === 'string' ? o.timeframe.slice(0, 20) : '';
  if (entry && target && stop) {
    const ok = o.direction === 'long' ? stop < entry && entry < target : target < entry && entry < stop;
    if (!ok) return o.direction === 'long' ? 'For a long, stop < entry < target.' : 'For a short, target < entry < stop.';
  }
  return { coin: o.coin, direction: o.direction, entry, target, stop, timeframe, body: o.body.trim() };
}

export function validateProfile(p: unknown): ProfileInput | string {
  const o = p as Record<string, unknown>;
  if (!o || typeof o !== 'object') return 'Missing profile.';
  const displayName = String(o.displayName ?? '').trim();
  if (displayName.length < 2 || displayName.length > 32) return 'Name must be 2 to 32 characters.';
  const bio = String(o.bio ?? '').trim().slice(0, 280);
  const twitter = String(o.twitter ?? '').trim().replace(/^@/, '');
  if (twitter && !/^[A-Za-z0-9_]{1,15}$/.test(twitter)) return 'Invalid X handle.';
  return { displayName, bio, twitter };
}

export const MAX_SCRIPT_CHARS = 20_000;
export const MAX_PRICE_HS = 1_000_000;

export function validateScript(p: unknown): ScriptInput | string {
  const o = p as Record<string, unknown>;
  if (!o || typeof o !== 'object') return 'Missing script details.';
  const name = String(o.name ?? '').trim();
  if (name.length < 3 || name.length > 60) return 'Name must be 3 to 60 characters.';
  const description = String(o.description ?? '').trim();
  if (description.length < 10 || description.length > 1000) return 'Description must be 10 to 1,000 characters.';
  const priceHs = Number(o.priceHs);
  if (!Number.isFinite(priceHs) || priceHs < 0 || priceHs > MAX_PRICE_HS) return `Price must be 0 (free) to ${MAX_PRICE_HS.toLocaleString()} HYPERSPACE.`;
  const codeSha256 = String(o.codeSha256 ?? '');
  if (!/^[0-9a-f]{64}$/.test(codeSha256)) return 'Missing code hash.';
  const scriptId = o.scriptId === null || o.scriptId === undefined ? null : String(o.scriptId);
  if (scriptId !== null && !/^[0-9a-f-]{36}$/.test(scriptId)) return 'Invalid script id.';
  return { scriptId, name, description, priceHs: Math.round(priceHs * 100) / 100, codeSha256 };
}

/** Hex SHA-256 of a string (works in browsers and Deno). */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const CHAT_CHANNELS = [
  { id: 'general', name: 'general', about: 'Anything HyperSpace and Hyperliquid' },
  { id: 'btc', name: 'btc', about: 'Bitcoin' },
  { id: 'eth', name: 'eth', about: 'Ethereum' },
  { id: 'alts', name: 'alts', about: 'Everything else on the main dex' },
  { id: 'stocks', name: 'stocks', about: 'Tokenized stocks, indices and commodities (HIP-3)' },
  { id: 'scripts', name: 'scripts', about: 'HyperScript help and indicator ideas' },
] as const;
export const MAX_CHAT_CHARS = 500;
