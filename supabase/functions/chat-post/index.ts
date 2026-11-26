// POST { token, channel, body } → posts a chat message as the wallet that owns the session.
import { admin, cors, json } from '../_shared/verify.ts';
import { CHAT_CHANNELS, MAX_CHAT_CHARS, sha256Hex } from '../_shared/proof.ts';

const MIN_GAP_MS = 2000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const { token, channel, body } = await req.json().catch(() => ({}));
  if (typeof token !== 'string' || typeof channel !== 'string' || typeof body !== 'string') return json({ error: 'token, channel and body required' }, 400);
  if (!CHAT_CHANNELS.some((c) => c.id === channel)) return json({ error: 'Unknown channel.' }, 400);
  const text = body.trim();
  if (!text || text.length > MAX_CHAT_CHARS) return json({ error: `Messages are 1 to ${MAX_CHAT_CHARS} characters.` }, 400);

  const db = admin();
  const { data: session } = await db.from('chat_sessions').select('address, expires_at').eq('token_hash', await sha256Hex(token)).maybeSingle();
  if (!session || Date.parse(session.expires_at) < Date.now()) return json({ error: 'Your chat sign-in expired; sign in again.' }, 401);

  const { data: last } = await db.from('chat_messages').select('created_at').eq('author', session.address).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (last && Date.now() - Date.parse(last.created_at) < MIN_GAP_MS) return json({ error: 'Slow down a little.' }, 429);

  const { data, error } = await db.from('chat_messages').insert({ channel, author: session.address, body: text }).select().single();
  if (error) return json({ error: error.message }, 500);
  return json({ message: data });
});
