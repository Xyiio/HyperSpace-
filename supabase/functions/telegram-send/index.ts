// POST { token, title, body, link? } → sends an alert from the open browser to the wallet's linked Telegram chat.
// Used for alerts only the browser can see (big trades). Rate limited to 30 per hour per wallet.
import { admin, cors, json, sessionAddress, telegram } from '../_shared/verify.ts';

const PER_HOUR = 30;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const { token, title, body, link } = await req.json().catch(() => ({}));
  if (typeof title !== 'string' || typeof body !== 'string') return json({ error: 'title and body required' }, 400);
  const db = admin();
  const address = await sessionAddress(db, token);
  if (!address) return json({ error: 'Your wallet sign-in expired; sign in again.' }, 401);
  const { data: linkRow } = await db.from('telegram_links').select('chat_id').eq('address', address).maybeSingle();
  if (!linkRow) return json({ error: 'Telegram is not linked.' }, 400);

  const since = new Date(Date.now() - 3_600_000).toISOString();
  const { count } = await db.from('telegram_sends').select('id', { count: 'exact', head: true }).eq('address', address).gte('sent_at', since);
  if ((count ?? 0) >= PER_HOUR) return json({ error: 'Telegram limit reached for this hour.' }, 429);

  const safeLink = typeof link === 'string' && /^https:\/\//.test(link) ? `\n${link.slice(0, 300)}` : '';
  const ok = await telegram(linkRow.chat_id, `🔔 ${title.slice(0, 120)}\n${body.slice(0, 500)}${safeLink}`);
  if (!ok) return json({ error: 'Telegram did not accept the message.' }, 502);
  await db.from('telegram_sends').insert({ address });
  return json({ ok: true });
});
