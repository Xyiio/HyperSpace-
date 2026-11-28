// One view of the trading account, live (Hyperliquid) or paper, for the account panel,
// the chart's position lines and the hotkeys.
import { useEffect, useState } from 'react';
import { fetchClearinghouse, fetchFills, fetchOpenOrders, fetchTwapHistory, type Fill, type OpenOrder } from '../hl/api';
import { accountValue, positionsView, withdrawable } from '../paper/engine';
import { useWallet } from './WalletContext';

export interface PositionRow {
  coin: string;
  szi: number;
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  liquidationPx: number | null;
  leverage: number | null;
  leverageType: 'cross' | 'isolated';
}

export interface TwapRow {
  id: number;
  coin: string;
  isBuy: boolean;
  sz: number;
  executedSz: number;
  executedNtl: number;
  minutes: number;
  start: number;
  reduceOnly: boolean;
}

export interface AccountView {
  source: 'live' | 'paper';
  account: string;
  accountValue: number;
  withdrawable: number;
  positions: PositionRow[];
  orders: OpenOrder[];
  twaps: TwapRow[];
}

const onDex = (coin: string, dex: string) => (dex ? coin.startsWith(`${dex}:`) : !coin.includes(':'));

/** Account state for one dex (HIP-3 dexes keep separate margin), refreshed every few seconds. */
export function useAccount(dex: string): AccountView | null {
  const w = useWallet();
  const [live, setLive] = useState<AccountView | null>(null);
  const user = w.tradeAccount;

  useEffect(() => {
    setLive(null);
    if (w.paper || !user) return;
    let alive = true;
    let twaps: TwapRow[] = [];
    let n = 0;
    const load = async () => {
      try {
        const loadTwaps = n++ % 3 === 0;
        const [s, o, th] = await Promise.all([fetchClearinghouse(user, undefined, dex), fetchOpenOrders(user, dex), loadTwaps ? fetchTwapHistory(user) : null]);
        if (th) {
          // The newest row per TWAP id is its current state; keep the running ones.
          const latest = new Map<number, (typeof th)[number]>();
          for (const r of th) if (r.twapId !== undefined && (!latest.has(r.twapId) || latest.get(r.twapId)!.time <= r.time)) latest.set(r.twapId, r);
          twaps = [...latest.values()]
            .filter((r) => r.status.status === 'activated' && onDex(r.state.coin, dex))
            .map((r) => ({
              id: r.twapId!,
              coin: r.state.coin,
              isBuy: r.state.side === 'B',
              sz: Number(r.state.sz),
              executedSz: Number(r.state.executedSz),
              executedNtl: Number(r.state.executedNtl),
              minutes: r.state.minutes,
              start: r.state.timestamp,
              reduceOnly: r.state.reduceOnly,
            }));
        }
        if (!alive) return;
        setLive({
          source: 'live',
          account: user,
          accountValue: Number(s.marginSummary.accountValue),
          withdrawable: Number(s.withdrawable),
          positions: s.assetPositions.map(({ position: p }) => ({
            coin: p.coin,
            szi: Number(p.szi),
            entryPx: Number(p.entryPx ?? 0),
            positionValue: Number(p.positionValue),
            unrealizedPnl: Number(p.unrealizedPnl),
            returnOnEquity: Number(p.returnOnEquity),
            liquidationPx: p.liquidationPx ? Number(p.liquidationPx) : null,
            leverage: p.leverage?.value ?? null,
            leverageType: p.leverage?.type ?? 'cross',
          })),
          orders: o,
          twaps,
        });
      } catch {
        /* keep the last good view; the next poll retries */
      }
    };
    void load();
    const t = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [user, dex, w.paper, w.revision]);

  if (!w.paper) return live;
  const ps = w.paperState;
  return {
    source: 'paper',
    account: 'paper',
    accountValue: accountValue(ps),
    withdrawable: withdrawable(ps),
    positions: positionsView(ps)
      .filter((p) => onDex(p.coin, dex))
      .map((p) => ({ ...p, leverage: null, leverageType: 'cross' as const })),
    orders: ps.orders
      .filter((o) => onDex(o.coin, dex))
      .map((o) => ({
        coin: o.coin,
        side: o.isBuy ? 'B' : 'A',
        limitPx: String(o.trigger ? o.px : o.px),
        sz: String(o.sz),
        origSz: String(o.origSz),
        oid: o.oid,
        timestamp: o.ts,
        orderType: o.trigger ? (o.trigger.tpsl === 'tp' ? 'Take Profit Market' : 'Stop Market') : 'Limit',
        reduceOnly: o.reduceOnly,
        tif: o.tif,
        isTrigger: !!o.trigger,
        triggerPx: o.trigger ? String(o.trigger.px) : undefined,
        triggerCondition: o.parent !== undefined ? 'Waits for entry to fill' : undefined,
      })),
    twaps: ps.twaps
      .filter((t) => t.status === 'activated' && onDex(t.coin, dex))
      .map((t) => ({ id: t.id, coin: t.coin, isBuy: t.isBuy, sz: t.sz, executedSz: t.executed, executedNtl: t.executedNtl, minutes: t.minutes, start: t.start, reduceOnly: t.reduceOnly })),
  };
}

/** Recent fills for the trade history and PnL cards. */
export function useRecentFills(enabled: boolean): Fill[] | null {
  const w = useWallet();
  const [fills, setFills] = useState<Fill[] | null>(null);
  const user = w.tradeAccount;
  useEffect(() => {
    if (!enabled) return;
    if (w.paper) {
      setFills(
        w.paperState.fills
          .slice()
          .reverse()
          .map((f) => ({
            coin: f.coin,
            px: String(f.px),
            sz: String(f.sz),
            side: f.side,
            time: f.time,
            startPosition: '0',
            dir: f.dir,
            closedPnl: String(f.closedPnl),
            hash: `paper-${f.oid}-${f.time}`,
            oid: f.oid,
            crossed: true,
            fee: String(f.fee),
          })),
      );
      return;
    }
    if (!user) return setFills(null);
    const ac = new AbortController();
    fetchFills(user, ac.signal)
      .then((f) => setFills(f.sort((a, b) => b.time - a.time)))
      .catch(() => {});
    return () => ac.abort();
  }, [enabled, user, w.paper, w.paperState.fills.length, w.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  return fills;
}
