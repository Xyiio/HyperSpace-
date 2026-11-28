// POST { token, alerts? } → stores the wallet's alert list (when given) and returns delivery status.
import { admin, cors, json, sessionAddress } from '../_shared/verify.ts';

const MAX_ALERTS = 200;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const { token, alerts } = await req.json().catch(() => ({}));
  const db = admin();
  const address = await sessionAddress(db, token);
  if (!address) return json({ error: 'Your wallet sign-in expired; sign in again.' }, 401);

  if (alerts !== undefined) {
    if (!Array.isArray(alerts) || alerts.length > MAX_ALERTS) return json({ error: `Send up to ${MAX_ALERTS} alerts.` }, 400);
    if (JSON.stringify(alerts).length > 200_000) return json({ error: 'Alert list too large.' }, 400);
    const { error } = await db.from('alerts_sync').upsert({ address, alerts, updated_at: new Date().toISOString() }, { onConflict: 'address' });
    if (error) return json({ error: error.message }, 500);
  }
  const [{ data: row }, { data: link }, { data: run }] = await Promise.all([
    db.from('alerts_sync').select('fired').eq('address', address).maybeSingle(),
    db.from('telegram_links').select('chat_id').eq('address', address).maybeSingle(),
    db.from('kv').select('value').eq('key', 'alerts-run').maybeSingle(),
  ]);
  return json({ telegramLinked: !!link, lastRun: (run?.value as { at?: string } | null)?.at ?? null, fired: row?.fired ?? {} });
});
