// Scheduled job (every minute, see README): evaluates every synced alert list and sends what fires to
// the wallet's linked Telegram chat, so alerts work while HyperSpace is closed. Big-trade alerts need a
// live trade stream and stay browser-only. Call with header x-cron-secret: $CRON_SECRET.
import { admin, cronAllowed, hlInfo, json, telegram } from '../_shared/verify.ts';

interface Pt {
  t: number;
  p: number;
}
interface Alert {
  id: string;
  kind: string;
  active: boolean;
  repeat: boolean;
  coin?: string;
  op?: 'above' | 'below' | 'cross';
  value?: number;
  refPx?: number;
  line?: { kind: 'hline' | 'trend'; a: Pt; b: Pt };
  address?: string;
  label?: string;
}
interface State {
  px?: Record<string, number>;
  fund?: Record<string, boolean>;
  fillCursor?: Record<string, number>;
}

const APP_URL = Deno.env.get('APP_URL') ?? '';
const COOLDOWN_MS = 60_000;

const linePriceAt = (l: NonNullable<Alert['line']>, t: number) =>
  l.kind === 'hline' || l.b.t === l.a.t ? l.a.p : l.a.p + ((l.b.p - l.a.p) * (t - l.a.t)) / (l.b.t - l.a.t);
const crossed = (op: Alert['op'], prev: number, now: number, level: number, prevLevel = level) => {
  const up = prev < prevLevel && now >= level;
  const down = prev > prevLevel && now <= level;
  return op === 'above' ? up : op === 'below' ? down : up || down;
};
const dexOf = (coin: string) => (coin.includes(':') ? coin.split(':')[0] : '');

Deno.serve(async (req) => {
  if (!cronAllowed(req)) return json({ error: 'forbidden' }, 403);
  const db = admin();
  const now = Date.now();
  const { data: links } = await db.from('telegram_links').select('address, chat_id');
  const chat = new Map((links ?? []).map((l) => [l.address as string, l.chat_id as number]));
  if (!chat.size) {
    await db.from('kv').upsert({ key: 'alerts-run', value: { at: new Date().toISOString(), sent: 0 } }, { onConflict: 'key' });
    return json({ ok: true, sent: 0 });
  }
  const { data: rows } = await db.from('alerts_sync').select('address, alerts, state, fired').in('address', [...chat.keys()]);

  // Market data, fetched once per dex for everyone.
  const all = (rows ?? []).flatMap((r) => (r.alerts as Alert[]).filter((a) => a.active));
  const dexes = new Set(all.filter((a) => a.coin).map((a) => dexOf(a.coin!)));
  const needFunding = all.some((a) => a.kind === 'funding');
  const needListing = all.some((a) => a.kind === 'listing');
  const mids: Record<string, number> = {};
  const funding: Record<string, number> = {};
  for (const dex of dexes) {
    const m = await hlInfo<Record<string, string>>(dex ? { type: 'allMids', dex } : { type: 'allMids' });
    for (const [k, v] of Object.entries(m)) mids[k] = Number(v);
    if (needFunding) {
      const [meta, ctxs] = await hlInfo<[{ universe: { name: string }[] }, { funding: string }[]]>({ type: 'metaAndAssetCtxs', dex });
      meta.universe.forEach((u, i) => (funding[u.name] = Number(ctxs[i]?.funding ?? 0) * 100));
    }
  }
  // Listings: compare every dex's market names with the list saved last run.
  let newListings: string[] = [];
  if (needListing) {
    const dexList = await hlInfo<({ name: string } | null)[]>({ type: 'perpDexs' });
    const names: string[] = [];
    for (const d of dexList) {
      const meta = await hlInfo<{ universe: { name: string }[] }>({ type: 'meta', dex: d?.name ?? '' });
      names.push(...meta.universe.map((u) => u.name));
    }
    const { data: known } = await db.from('kv').select('value').eq('key', 'known-markets').maybeSingle();
    const before = new Set((known?.value as string[] | undefined) ?? []);
    if (before.size) newListings = names.filter((n) => !before.has(n));
    await db.from('kv').upsert({ key: 'known-markets', value: names, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  }

  let sent = 0;
  for (const row of rows ?? []) {
    const alerts = row.alerts as Alert[];
    const state = (row.state ?? {}) as State;
    const fired = (row.fired ?? {}) as Record<string, number>;
    state.px ??= {};
    state.fund ??= {};
    state.fillCursor ??= {};
    const out: string[] = [];
    const fire = (a: Alert, text: string, path: string) => {
      if (fired[a.id] && now - fired[a.id] < COOLDOWN_MS) return;
      fired[a.id] = now;
      out.push(`${text}${APP_URL ? `\n${APP_URL}${path}` : ''}`);
    };

    for (const a of alerts) {
      if (!a.active) continue;
      if (!a.repeat && fired[a.id] && (a.kind === 'price' || a.kind === 'drawing' || a.kind === 'funding')) continue;
      const coin = a.coin ?? '';
      const px = mids[coin];
      if ((a.kind === 'price' || a.kind === 'drawing') && px !== undefined) {
        const prev = state.px[coin] ?? a.refPx;
        if (prev !== undefined) {
          if (a.kind === 'price' && a.value !== undefined && crossed(a.op ?? 'cross', prev, px, a.value)) fire(a, `${coin} is at ${px} (alert at ${a.value}).`, `#/trade/${coin}`);
          if (a.kind === 'drawing' && a.line && crossed('cross', prev, px, linePriceAt(a.line, now), linePriceAt(a.line, now - 60_000)))
            fire(a, `${coin} at ${px} crossed your ${a.line.kind === 'trend' ? 'trend line' : 'line'}.`, `#/trade/${coin}`);
        }
      }
      if (a.kind === 'funding' && funding[coin] !== undefined && a.value !== undefined) {
        const on = a.op === 'below' ? funding[coin] <= a.value : funding[coin] >= a.value;
        if (on && !state.fund[a.id]) fire(a, `${coin} funding is ${funding[coin].toFixed(4)}%/h.`, `#/trade/${coin}`);
        state.fund[a.id] = on;
      }
      if (a.kind === 'listing' && newListings.length) fire(a, `New on Hyperliquid: ${newListings.slice(0, 10).join(', ')}`, '#/markets/auctions');
      if (a.kind === 'wallet' && a.address) {
        const since = state.fillCursor[a.address] ?? now - 60_000;
        const fills = await hlInfo<{ coin: string; side: 'B' | 'A'; px: string; sz: string; dir: string; time: number }[]>({
          type: 'userFillsByTime',
          user: a.address,
          startTime: since + 1,
          aggregateByTime: true,
        }).catch(() => []);
        if (fills.length) {
          state.fillCursor[a.address] = Math.max(...fills.map((f) => f.time));
          const byCoin = new Map<string, { dir: string; sz: number; ntl: number }>();
          for (const f of fills) {
            const g = byCoin.get(f.coin) ?? { dir: f.dir, sz: 0, ntl: 0 };
            g.sz += Number(f.sz);
            g.ntl += Number(f.sz) * Number(f.px);
            byCoin.set(f.coin, g);
          }
          const who = a.label || `${a.address.slice(0, 6)}…${a.address.slice(-4)}`;
          const lines = [...byCoin].map(([c, g]) => `${g.dir} ${c}: $${Math.round(g.ntl).toLocaleString('en-US')} at ~${(g.ntl / g.sz).toPrecision(6)}`);
          fired[a.id] = 0; // wallet alerts stream, so no cooldown
          fire(a, `👀 ${who}\n${lines.join('\n')}`, `#/wallet/${a.address}`);
        } else state.fillCursor[a.address] = since;
      }
    }
    for (const c of Object.keys(mids)) if (alerts.some((a) => a.coin === c)) state.px[c] = mids[c];

    for (const text of out.slice(0, 10)) if (await telegram(chat.get(row.address)!, `🔔 HyperSpace\n${text}`)) sent++;
    await db.from('alerts_sync').update({ state, fired }).eq('address', row.address);
  }
  await db.from('kv').upsert({ key: 'alerts-run', value: { at: new Date().toISOString(), sent }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  return json({ ok: true, sent });
});
