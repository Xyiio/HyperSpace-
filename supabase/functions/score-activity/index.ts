// Scheduled job (hourly, see README): resolves trade ideas (target or stop, whichever price hit first)
// and credits trading volume that paid the HyperSpace builder fee. Header x-cron-secret: $CRON_SECRET.
import { admin, cronAllowed, hlInfo, json } from '../_shared/verify.ts';

const MAX_AGE_MS = 90 * 86_400_000; // ideas still open after 90 days are left unresolved

Deno.serve(async (req) => {
  if (!cronAllowed(req)) return json({ error: 'forbidden' }, 403);
  const db = admin();
  const now = Date.now();

  // 1. Ideas: walk hourly candles from the post time.
  const { data: open } = await db
    .from('ideas')
    .select('id, coin, direction, target, stop, mark_at_post, created_at')
    .is('outcome', null)
    .gte('created_at', new Date(now - MAX_AGE_MS).toISOString())
    .limit(300);
  let resolved = 0;
  for (const i of open ?? []) {
    if (i.target === null && i.stop === null) continue;
    const long = i.direction === 'long';
    const candles = await hlInfo<{ t: number; h: string; l: string }[]>({
      type: 'candleSnapshot',
      req: { coin: i.coin, interval: '1h', startTime: Date.parse(i.created_at), endTime: now },
    }).catch(() => []);
    for (const c of candles) {
      const hi = Number(c.h);
      const lo = Number(c.l);
      const stopHit = i.stop !== null && (long ? lo <= i.stop : hi >= i.stop);
      const targetHit = i.target !== null && (long ? hi >= i.target : lo <= i.target);
      if (!stopHit && !targetHit) continue;
      // Same candle hits both: count it as stopped (the cautious reading).
      const outcome = stopHit ? 'stop' : 'target';
      const level = outcome === 'stop' ? i.stop : i.target;
      const move = ((level - i.mark_at_post) / i.mark_at_post) * (long ? 1 : -1);
      await db.from('ideas').update({ outcome, outcome_move: move, resolved_at: new Date(c.t).toISOString() }).eq('id', i.id);
      resolved++;
      break;
    }
  }

  // 2. Trading points: fills with a builder fee, for wallets HyperSpace knows about.
  let traders = 0;
  if (Deno.env.get('BUILDER_ADDRESS')) {
    const [{ data: a }, { data: b }, { data: c }] = await Promise.all([
      db.from('profiles').select('address'),
      db.from('referrals').select('referee'),
      db.from('alerts_sync').select('address'),
    ]);
    const wallets = new Set([...(a ?? []).map((x) => x.address), ...(b ?? []).map((x) => x.referee), ...(c ?? []).map((x) => x.address)]);
    const { data: tp } = await db.from('trade_points').select('*');
    const prev = new Map((tp ?? []).map((r) => [r.address as string, r]));
    for (const w of [...wallets].slice(0, 500)) {
      const p = prev.get(w) ?? { volume: 0, builder_fees: 0, cursor_ms: now - 30 * 86_400_000 };
      const fills = await hlInfo<{ px: string; sz: string; time: number; builderFee?: string }[]>({
        type: 'userFillsByTime',
        user: w,
        startTime: Number(p.cursor_ms) + 1,
        aggregateByTime: true,
      }).catch(() => null);
      if (!fills) continue;
      let vol = Number(p.volume);
      let fees = Number(p.builder_fees);
      let cursor = Number(p.cursor_ms);
      for (const f of fills) {
        cursor = Math.max(cursor, f.time);
        const bf = Number(f.builderFee ?? 0);
        if (bf > 0) {
          vol += Number(f.px) * Number(f.sz);
          fees += bf;
        }
      }
      await db.from('trade_points').upsert({ address: w, volume: vol, builder_fees: fees, cursor_ms: cursor, updated_at: new Date().toISOString() }, { onConflict: 'address' });
      traders++;
    }
  }
  return json({ ok: true, resolved, traders });
});
