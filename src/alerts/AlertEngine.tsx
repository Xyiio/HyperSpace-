// Watches live data for every active alert while HyperSpace is open in any tab.
// Price and line alerts use the allMids stream, big-trade alerts the trade stream, wallet
// watch each wallet's fill stream, and funding / listing alerts the minute market refresh.
import { useEffect, useMemo, useRef } from 'react';
import type { Market, Trade } from '../hl/api';
import { hlSocket } from '../hl/ws';
import { fmtCompact, shortAddr } from '../hl/stats';
import { crossed, describeAlert, getAlerts, linePriceAt, updateAlert, useAlerts, type Alert } from './store';
import { notify } from './notify';
import { serverDelivers } from './sync';

const REPEAT_COOLDOWN_MS = 60_000;
const STREAM_COOLDOWN_MS = 10_000;

const dexOf = (coin: string) => (coin.includes(':') ? coin.split(':')[0] : '');

function fire(a: Alert, body: string, link?: string) {
  const now = Date.now();
  const stream = a.kind === 'bigTrade' || a.kind === 'wallet' || a.kind === 'listing';
  if (a.lastFired && now - a.lastFired < (stream ? STREAM_COOLDOWN_MS : REPEAT_COOLDOWN_MS)) return;
  updateAlert(a.id, { lastFired: now, active: stream || a.repeat ? true : false });
  notify(describeAlert(a), body, link, !serverDelivers(a.kind));
}

export function AlertEngine({ markets, newMarkets }: { markets: Market[]; newMarkets: string[] }) {
  const alerts = useAlerts();
  const active = useMemo(() => alerts.filter((a) => a.active), [alerts]);
  const lastPx = useRef<Record<string, number>>({});
  const fundingState = useRef<Record<string, boolean>>({});

  // Price and drawing alerts.
  const priceCoins = useMemo(() => [...new Set(active.filter((a) => a.kind === 'price' || a.kind === 'drawing').map((a) => a.coin!))].sort().join(','), [active]);
  useEffect(() => {
    if (!priceCoins) return;
    const coins = new Set(priceCoins.split(','));
    const dexes = [...new Set([...coins].map(dexOf))];
    const onMids = (d: { mids: Record<string, string> }) => {
      const now = Date.now();
      for (const coin of coins) {
        const v = d.mids[coin];
        if (v === undefined) continue;
        const px = Number(v);
        for (const a of getAlerts()) {
          if (!a.active || a.coin !== coin || (a.kind !== 'price' && a.kind !== 'drawing')) continue;
          const prev = lastPx.current[coin] ?? a.refPx;
          if (prev === undefined) continue;
          if (a.kind === 'price' && a.value !== undefined && crossed(a.op ?? 'cross', prev, px, a.value))
            fire(a, `${coin} is at ${px} (alert at ${a.value}).`, `#/trade/${coin}`);
          if (a.kind === 'drawing' && a.line) {
            const level = linePriceAt(a.line, now);
            if (crossed('cross', prev, px, level, linePriceAt(a.line, now - 5000)))
              fire(a, `${coin} at ${px} crossed your ${a.line.kind === 'trend' ? 'trend line' : 'line'} near ${Number(level.toPrecision(6))}.`, `#/trade/${coin}`);
          }
        }
        lastPx.current[coin] = px;
      }
    };
    const unsubs = dexes.map((dex) => hlSocket.subscribe(dex ? { type: 'allMids', dex } : { type: 'allMids' }, onMids));
    return () => unsubs.forEach((u) => u());
  }, [priceCoins]);

  // Big trades.
  const tradeCoins = useMemo(() => [...new Set(active.filter((a) => a.kind === 'bigTrade').map((a) => a.coin!))].sort().join(','), [active]);
  useEffect(() => {
    if (!tradeCoins) return;
    const unsubs = tradeCoins.split(',').map((coin) =>
      hlSocket.subscribe({ type: 'trades', coin }, (ts: Trade[]) => {
        for (const a of getAlerts()) {
          if (!a.active || a.kind !== 'bigTrade' || a.coin !== coin) continue;
          const big = ts.filter((t) => Number(t.px) * Number(t.sz) >= (a.value ?? Infinity));
          if (!big.length) continue;
          const t = big.reduce((m, x) => (Number(x.px) * Number(x.sz) > Number(m.px) * Number(m.sz) ? x : m));
          const ntl = Number(t.px) * Number(t.sz);
          const taker = t.users ? (t.side === 'B' ? t.users[0] : t.users[1]) : null;
          fire(a, `${t.side === 'B' ? 'Buy' : 'Sell'} ${fmtCompact(ntl)} at ${t.px}${taker ? ` by ${shortAddr(taker)}` : ''}.`, `#/trade/${coin}`);
        }
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [tradeCoins]);

  // Wallet watch: each watched wallet's fills, pushed live by Hyperliquid.
  const watched = useMemo(() => [...new Set(active.filter((a) => a.kind === 'wallet').map((a) => a.address!))].sort().join(','), [active]);
  useEffect(() => {
    if (!watched) return;
    const unsubs = watched.split(',').map((user) =>
      hlSocket.subscribe({ type: 'userFills', user }, (d: { isSnapshot?: boolean; fills: { coin: string; px: string; sz: string; dir: string; closedPnl: string }[] }) => {
        if (d.isSnapshot || !d.fills?.length) return;
        // Summarise by market and direction: one order often fills in many pieces.
        const groups = new Map<string, { coin: string; dir: string; sz: number; ntl: number; pnl: number }>();
        for (const f of d.fills) {
          if (!/open|close|liquidat/i.test(f.dir)) continue;
          const k = `${f.coin}|${f.dir}`;
          const g = groups.get(k) ?? { coin: f.coin, dir: f.dir, sz: 0, ntl: 0, pnl: 0 };
          g.sz += Number(f.sz);
          g.ntl += Number(f.sz) * Number(f.px);
          g.pnl += Number(f.closedPnl);
          groups.set(k, g);
        }
        if (!groups.size) return;
        for (const a of getAlerts()) {
          if (!a.active || a.kind !== 'wallet' || a.address !== user) continue;
          const lines = [...groups.values()].map(
            (g) => `${g.dir} ${Number(g.sz.toPrecision(6))} ${g.coin} at ${Number((g.ntl / g.sz).toPrecision(6))} (${fmtCompact(g.ntl)})${g.pnl ? `, PnL ${fmtCompact(g.pnl)}` : ''}`,
          );
          const first = [...groups.values()][0];
          fire(a, `${a.label || shortAddr(user)}: ${lines.join('; ')}.`, `#/trade/${first.coin}?wallet=${user}`);
        }
      }),
    );
    return () => unsubs.forEach((u) => u());
  }, [watched]);

  // Funding, on each market refresh: fires when the rate moves past the level.
  useEffect(() => {
    for (const a of getAlerts()) {
      if (!a.active || a.kind !== 'funding') continue;
      const m = markets.find((x) => x.name === a.coin);
      if (!m || a.value === undefined) continue;
      const rate = Number(m.ctx.funding) * 100;
      const on = a.op === 'below' ? rate <= a.value : rate >= a.value;
      const was = fundingState.current[a.id] ?? false;
      fundingState.current[a.id] = on;
      if (on && !was) fire(a, `${a.coin} funding is ${rate.toFixed(4)}%/h (${(rate * 24 * 365).toFixed(1)}% a year).`, `#/trade/${a.coin}`);
    }
  }, [markets]);

  // New listings.
  useEffect(() => {
    if (!newMarkets.length) return;
    for (const a of getAlerts()) {
      if (!a.active || a.kind !== 'listing') continue;
      fire(a, `New on Hyperliquid: ${newMarkets.join(', ')}.`, `#/trade/${newMarkets[0]}`);
    }
  }, [newMarkets]);

  return null;
}
