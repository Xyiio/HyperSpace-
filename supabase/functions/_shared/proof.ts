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

export type SignedKind = 'post-idea' | 'save-profile';

/** The exact text the wallet signs. The JSON payload is on its own last line. */
export function buildMessage(kind: SignedKind, address: string, issuedAt: number, payload: IdeaInput | ProfileInput): string {
  return [
    `${APP_NAME}: ${kind === 'post-idea' ? 'post a trade idea' : 'update my profile'}`,
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
  const kind: SignedKind | null =
    head === `${APP_NAME}: post a trade idea` ? 'post-idea' : head === `${APP_NAME}: update my profile` ? 'save-profile' : null;
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
