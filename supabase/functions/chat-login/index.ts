// POST { message, signature } → a chat session token for the signing wallet (valid 7 days).
// One signature per week instead of one per message.
import { admin, cors, json, verifyRequest } from '../_shared/verify.ts';
import { sha256Hex } from '../_shared/proof.ts';

const TTL_MS = 7 * 86_400_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const parsed = await verifyRequest(req, 'chat-login');
  if (parsed instanceof Response) return parsed;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const expires = new Date(Date.now() + TTL_MS).toISOString();
  const db = admin();
  // Keep only the newest few sessions per wallet.
  await db.from('chat_sessions').delete().eq('address', parsed.address).lt('expires_at', new Date().toISOString());
  const { error } = await db.from('chat_sessions').insert({ token_hash: await sha256Hex(token), address: parsed.address, expires_at: expires });
  if (error) return json({ error: error.message }, 500);
  return json({ token, address: parsed.address, expiresAt: expires });
});
