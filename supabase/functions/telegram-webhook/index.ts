// Telegram bot webhook. Register it with setWebhook and secret_token = TELEGRAM_WEBHOOK_SECRET (see README).
// Handles "/start <code>" to link a chat to a wallet, and "/stop" to unlink.
import { admin, json, telegram } from '../_shared/verify.ts';

Deno.serve(async (req) => {
  const secret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
  if (!secret || req.headers.get('x-telegram-bot-api-secret-token') !== secret) return json({ error: 'forbidden' }, 403);
  const update = await req.json().catch(() => ({}));
  const msg = update?.message;
  const chatId = msg?.chat?.id;
  const text: string = msg?.text ?? '';
  if (!chatId) return json({ ok: true });
  const db = admin();

  const start = text.match(/^\/start\s+([0-9a-f]{24})$/);
  if (start) {
    const { data: row } = await db.from('telegram_codes').select('address, expires_at').eq('code', start[1]).maybeSingle();
    if (!row || Date.parse(row.expires_at) < Date.now()) {
      await telegram(chatId, 'That link has expired. Open Alerts in HyperSpace and press "Link Telegram" again.');
      return json({ ok: true });
    }
    await db.from('telegram_codes').delete().eq('code', start[1]);
    await db.from('telegram_links').upsert({ address: row.address, chat_id: chatId, linked_at: new Date().toISOString() }, { onConflict: 'address' });
    await telegram(chatId, `Linked to ${row.address.slice(0, 6)}…${row.address.slice(-4)}. Your HyperSpace alerts will arrive here. Send /stop to unlink.`);
  } else if (text.trim() === '/stop') {
    await db.from('telegram_links').delete().eq('chat_id', chatId);
    await telegram(chatId, 'Unlinked. You will not get HyperSpace alerts here any more.');
  } else {
    await telegram(chatId, 'Open Alerts in HyperSpace and press "Link Telegram" to connect this chat.');
  }
  return json({ ok: true });
});
