// POST { token } → a one-time code to send to the bot as /start <code>.  POST { token, unlink: true } → unlinks.
import { admin, cors, json, sessionAddress } from '../_shared/verify.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const { token, unlink } = await req.json().catch(() => ({}));
  const db = admin();
  const address = await sessionAddress(db, token);
  if (!address) return json({ error: 'Your wallet sign-in expired; sign in again.' }, 401);

  if (unlink) {
    await db.from('telegram_links').delete().eq('address', address);
    return json({ ok: true });
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const code = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  await db.from('telegram_codes').delete().eq('address', address);
  const { error } = await db.from('telegram_codes').insert({ code, address, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
  if (error) return json({ error: error.message }, 500);
  return json({ code, bot: Deno.env.get('TELEGRAM_BOT_USERNAME') ?? null });
});
