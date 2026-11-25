// Pure helpers: book → heatmap snapshot, and wallet fills → verified PnL stats.
import type { BookSnapshot } from './primitives';
import type { Fill, L2Book, Portfolio, PortfolioPeriod } from './api';

export function bookToSnapshot(book: L2Book, t = book.time): BookSnapshot {
  const bids = book.levels[0].map((l) => [Number(l.px), Number(l.sz)] as [number, number]);
  const asks = book.levels[1].map((l) => [Number(l.px), Number(l.sz)] as [number, number]);
  // Bucket size = smallest gap between neighbouring levels on either side.
  let step = Infinity;
  for (const side of [bids, asks]) {
    for (let i = 1; i < side.length; i++) {
      const d = Math.abs(side[i][0] - side[i - 1][0]);
      if (d > 0 && d < step) step = d;
    }
  }
  if (!Number.isFinite(step)) step = (bids[0]?.[0] ?? asks[0]?.[0] ?? 1) * 1e-4;
  return { t, step, bids, asks };
}

/** Price decimals Hyperliquid allows for a perp: at most 5 significant figures and 6 - szDecimals decimals. */
export function priceDecimals(px: number, szDecimals: number): number {
  if (!(px > 0)) return 2;
  const sig = Math.max(0, 5 - Math.floor(Math.log10(px)) - 1);
  return Math.max(0, Math.min(6 - szDecimals, sig));
}

/** Round a price to a valid Hyperliquid tick. */
export function roundPrice(px: number, szDecimals: number): number {
  const d = priceDecimals(px, szDecimals);
  return Number(px.toFixed(d));
}

export interface CoinStats {
  coin: string;
  trades: number; // closing fills
  wins: number;
  realized: number; // closed PnL, before fees
  fees: number;
  volume: number;
}

export interface FillStats {
  fills: number;
  closing: number;
  wins: number;
  winRate: number | null;
  realized: number;
  fees: number;
  net: number;
  volume: number;
  bestTrade: number;
  worstTrade: number;
  liquidations: number;
  firstTime: number | null;
  lastTime: number | null;
  byCoin: CoinStats[];
}

export function fillStats(fills: Fill[]): FillStats {
  const byCoin = new Map<string, CoinStats>();
  let closing = 0;
  let wins = 0;
  let realized = 0;
  let fees = 0;
  let volume = 0;
  let best = 0;
  let worst = 0;
  let liquidations = 0;
  let first: number | null = null;
  let last: number | null = null;
  for (const f of fills) {
    const pnl = Number(f.closedPnl);
    const fee = Number(f.fee) + Number(f.builderFee ?? 0);
    const ntl = Number(f.px) * Number(f.sz);
    const c = byCoin.get(f.coin) ?? { coin: f.coin, trades: 0, wins: 0, realized: 0, fees: 0, volume: 0 };
    c.fees += fee;
    c.volume += ntl;
    fees += fee;
    volume += ntl;
    if (pnl !== 0) {
      closing++;
      c.trades++;
      c.realized += pnl;
      realized += pnl;
      if (pnl > 0) {
        wins++;
        c.wins++;
      }
      best = Math.max(best, pnl);
      worst = Math.min(worst, pnl);
    }
    if (f.liquidation) liquidations++;
    first = first === null ? f.time : Math.min(first, f.time);
    last = last === null ? f.time : Math.max(last, f.time);
    byCoin.set(f.coin, c);
  }
  return {
    fills: fills.length,
    closing,
    wins,
    winRate: closing ? wins / closing : null,
    realized,
    fees,
    net: realized - fees,
    volume,
    bestTrade: best,
    worstTrade: worst,
    liquidations,
    firstTime: first,
    lastTime: last,
    byCoin: [...byCoin.values()].sort((a, b) => Math.abs(b.realized) - Math.abs(a.realized)),
  };
}

export interface PeriodSummary {
  pnl: number;
  startValue: number;
  endValue: number;
  maxDrawdown: number; // fraction of peak account value, 0..1
  volume: number;
  series: { t: number; pnl: number; value: number }[];
}

export function periodSummary(portfolio: Portfolio, period: PortfolioPeriod): PeriodSummary | null {
  const entry = portfolio.find(([p]) => p === period)?.[1];
  if (!entry) return null;
  const values = new Map(entry.accountValueHistory.map(([t, v]) => [t, Number(v)]));
  const series = entry.pnlHistory.map(([t, p]) => ({ t, pnl: Number(p), value: values.get(t) ?? NaN }));
  let peak = -Infinity;
  let maxDd = 0;
  for (const { value } of series) {
    if (!Number.isFinite(value)) continue;
    peak = Math.max(peak, value);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - value) / peak);
  }
  const av = entry.accountValueHistory;
  return {
    pnl: series.length ? series[series.length - 1].pnl - series[0].pnl : 0,
    startValue: av.length ? Number(av[0][1]) : 0,
    endValue: av.length ? Number(av[av.length - 1][1]) : 0,
    maxDrawdown: maxDd,
    volume: Number(entry.vlm),
    series,
  };
}

export const fmtUsd = (n: number, digits = 0) =>
  (n < 0 ? '-$' : '$') +
  Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const fmtCompact = (n: number) =>
  (n < 0 ? '-$' : '$') + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(Math.abs(n));

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
