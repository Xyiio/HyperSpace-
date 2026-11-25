// Thin client for Hyperliquid's public Info API.
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
// Request and response shapes mirror the official Python SDK (hyperliquid/info.py).

export const API_URL = 'https://api.hyperliquid.xyz';
export const WS_URL = 'wss://api.hyperliquid.xyz/ws';

export async function info<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_URL}/info`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${String(body.type)} failed: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ---------- Markets ----------

export interface PerpAsset {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  isDelisted?: boolean;
}

export interface PerpAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
  midPx: string | null;
}

export interface Market extends PerpAsset {
  index: number; // asset id used in order actions
  ctx: PerpAssetCtx;
}

export async function fetchMarkets(signal?: AbortSignal): Promise<Market[]> {
  const [meta, ctxs] = await info<[{ universe: PerpAsset[] }, PerpAssetCtx[]]>({ type: 'metaAndAssetCtxs' }, signal);
  return meta.universe
    .map((a, i) => ({ ...a, index: i, ctx: ctxs[i] }))
    .filter((m) => !m.isDelisted && m.ctx)
    .sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm));
}

// ---------- Candles ----------

export const INTERVALS = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Interval = (typeof INTERVALS)[number];

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export interface RawCandle {
  t: number; // open time, ms
  T: number; // close time, ms
  s: string; // coin
  i: string; // interval
  o: string;
  c: string;
  h: string;
  l: string;
  v: string; // base volume
  n: number; // trade count
}

export function fetchCandles(coin: string, interval: Interval, bars = 500, signal?: AbortSignal) {
  const endTime = Date.now();
  const startTime = endTime - bars * INTERVAL_MS[interval];
  return info<RawCandle[]>({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime } }, signal);
}

// ---------- Order book and trades (WebSocket payloads) ----------

export interface BookLevel {
  px: string;
  sz: string;
  n: number; // number of orders at the level
}

export interface L2Book {
  coin: string;
  time: number;
  levels: [BookLevel[], BookLevel[]]; // [bids, asks]
}

export interface Trade {
  coin: string;
  side: 'B' | 'A'; // aggressor side: B = buy, A = sell
  px: string;
  sz: string;
  time: number;
  hash: string;
  tid: number;
  users?: [string, string]; // [buyer, seller]
}

// ---------- Wallets ----------

export type PortfolioPeriod =
  | 'day'
  | 'week'
  | 'month'
  | 'allTime'
  | 'perpDay'
  | 'perpWeek'
  | 'perpMonth'
  | 'perpAllTime';

export interface PortfolioSeries {
  accountValueHistory: [number, string][];
  pnlHistory: [number, string][];
  vlm: string;
}

export type Portfolio = [PortfolioPeriod, PortfolioSeries][];

export function fetchPortfolio(user: string, signal?: AbortSignal) {
  return info<Portfolio>({ type: 'portfolio', user }, signal);
}

export interface Fill {
  coin: string;
  px: string;
  sz: string;
  side: 'B' | 'A';
  time: number;
  startPosition: string;
  dir: string; // "Open Long", "Close Short", ...
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  feeToken?: string;
  tid?: number;
  builderFee?: string;
  liquidation?: { liquidatedUser?: string; markPx: string; method: string };
}

// Returns at most the 2000 most recent fills.
export function fetchFills(user: string, signal?: AbortSignal) {
  return info<Fill[]>({ type: 'userFills', user }, signal);
}

export interface AssetPosition {
  type: string;
  position: {
    coin: string;
    szi: string;
    entryPx: string | null;
    positionValue: string;
    unrealizedPnl: string;
    returnOnEquity: string;
    liquidationPx: string | null;
    leverage: { type: 'cross' | 'isolated'; value: number };
    marginUsed: string;
  };
}

export interface ClearinghouseState {
  assetPositions: AssetPosition[];
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  withdrawable: string;
  time: number;
}

export function fetchClearinghouse(user: string, signal?: AbortSignal) {
  return info<ClearinghouseState>({ type: 'clearinghouseState', user }, signal);
}

export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
