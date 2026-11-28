// Thin client for Hyperliquid's public Info API.
// Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
// Request and response shapes mirror the official Python SDK (hyperliquid/info.py).

import { API_URL } from './network';
export { API_URL, WS_URL } from './network';

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
  dex: string; // '' = Hyperliquid's main perp dex; otherwise a HIP-3 builder-deployed dex
  dexLabel: string; // human name of the dex
  symbol: string; // name without the dex prefix, e.g. TSLA for xyz:TSLA
  ctx: PerpAssetCtx;
}

interface PerpDex {
  name: string;
  fullName: string;
}

// Asset ids: main dex = index; HIP-3 dex number i (1-based in perpDexs) = 110000 + (i - 1) * 10000 + index.
// Mirrors hyperliquid-python-sdk info.py.
const dexOffset = (i: number) => (i === 0 ? 0 : 110_000 + (i - 1) * 10_000);

/**
 * Every perp market on Hyperliquid: the main crypto dex plus every HIP-3 builder-deployed dex,
 * which is where tokenized stocks, indices, commodities and FX trade (e.g. xyz:TSLA, xyz:GOLD).
 */
export async function fetchMarkets(signal?: AbortSignal): Promise<Market[]> {
  const dexes = await info<(PerpDex | null)[]>({ type: 'perpDexs' }, signal);
  const lists = await Promise.all(
    dexes.map(async (d, i) => {
      const dex = d?.name ?? '';
      try {
        const [meta, ctxs] = await info<[{ universe: PerpAsset[] }, PerpAssetCtx[]]>({ type: 'metaAndAssetCtxs', dex }, signal);
        return meta.universe
          .map((a, j) => ({
            ...a,
            index: dexOffset(i) + j,
            dex,
            dexLabel: d ? d.fullName || d.name : 'Hyperliquid',
            symbol: a.name.includes(':') ? a.name.split(':')[1] : a.name,
            ctx: ctxs[j],
          }))
          .filter((m) => !m.isDelisted && m.ctx);
      } catch (e) {
        if (i === 0) throw e; // the main dex is required; a broken HIP-3 dex is skipped
        return [];
      }
    }),
  );
  return lists.map((l) => l.sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm))).flat();
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

/** Fills at or after startTime (ms), up to 2000 per call. */
export function fetchFillsSince(user: string, startTime: number, signal?: AbortSignal) {
  return info<Fill[]>({ type: 'userFillsByTime', user, startTime, aggregateByTime: true }, signal);
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

export function fetchClearinghouse(user: string, signal?: AbortSignal, dex = '') {
  return info<ClearinghouseState>({ type: 'clearinghouseState', user, dex }, signal);
}

export interface OpenOrder {
  coin: string;
  side: 'B' | 'A';
  limitPx: string;
  sz: string;
  origSz: string;
  oid: number;
  timestamp: number;
  orderType: string;
  reduceOnly: boolean;
  tif: string | null;
  // Trigger (take-profit / stop) orders.
  isTrigger?: boolean;
  triggerPx?: string;
  triggerCondition?: string;
  isPositionTpsl?: boolean;
}

export function fetchOpenOrders(user: string, dex = '', signal?: AbortSignal) {
  return info<OpenOrder[]>({ type: 'frontendOpenOrders', user, dex }, signal);
}

// ---------- Funding, open interest, spot, auctions ----------

export type Venue = 'HlPerp' | 'BinPerp' | 'BybitPerp';
export type PredictedFundings = [string, [Venue, { fundingRate: string; nextFundingTime: number; fundingIntervalHours?: number } | null][]][];

/** Next funding rate for every coin on Hyperliquid, Binance and Bybit (as Hyperliquid reports them). */
export const fetchPredictedFundings = (signal?: AbortSignal) => info<PredictedFundings>({ type: 'predictedFundings' }, signal);

export interface FundingPoint {
  coin: string;
  fundingRate: string;
  premium: string;
  time: number;
}

/** Hourly funding history (up to 500 rows per call). */
export const fetchFundingHistory = (coin: string, startTime: number, endTime?: number, signal?: AbortSignal) =>
  info<FundingPoint[]>({ type: 'fundingHistory', coin, startTime, ...(endTime ? { endTime } : {}) }, signal);

/** Markets whose open interest is at Hyperliquid's cap (no new positions can open). */
export const fetchOiCapped = (dex = '', signal?: AbortSignal) => info<string[]>({ type: 'perpsAtOpenInterestCap', ...(dex ? { dex } : {}) }, signal);

export interface SpotMeta {
  tokens: { name: string; index: number; szDecimals: number; fullName?: string | null }[];
  universe: { name: string; tokens: [number, number]; index: number; isCanonical: boolean }[];
}
export interface SpotCtx {
  coin: string;
  markPx: string;
  midPx: string | null;
  prevDayPx: string;
  dayNtlVlm: string;
}
export const fetchSpot = (signal?: AbortSignal) => info<[SpotMeta, SpotCtx[]]>({ type: 'spotMetaAndAssetCtxs' }, signal);

export interface GasAuction {
  startTimeSeconds: number;
  durationSeconds: number;
  startGas: string;
  currentGas: string | null;
  endGas: string | null;
}
/** Spot ticker (HIP-1) deploy auction. */
export const fetchSpotAuction = (signal?: AbortSignal) =>
  info<{ gasAuction: GasAuction }>({ type: 'spotDeployState', user: '0x0000000000000000000000000000000000000000' }, signal).then((r) => r.gasAuction);
/** HIP-3 perp dex deploy auction. */
export const fetchPerpAuction = (signal?: AbortSignal) => info<GasAuction>({ type: 'perpDeployAuctionStatus' }, signal);

export interface TwapState {
  coin: string;
  executedNtl: string;
  executedSz: string;
  minutes: number;
  randomize: boolean;
  reduceOnly: boolean;
  side: 'B' | 'A';
  sz: string;
  timestamp: number;
  user: string;
}
export interface TwapHistoryRow {
  time: number;
  state: TwapState;
  status: { status: 'finished' | 'activated' | 'terminated' | 'waitingForTrigger' | 'stopped' | 'error'; description?: string };
  twapId?: number;
}
export const fetchTwapHistory = (user: string, signal?: AbortSignal) => info<TwapHistoryRow[]>({ type: 'twapHistory', user }, signal);

export interface SubAccount {
  name: string;
  subAccountUser: string;
  master: string;
}
export const fetchSubAccounts = (user: string, signal?: AbortSignal) => info<SubAccount[] | null>({ type: 'subAccounts', user }, signal).then((r) => r ?? []);
export const fetchLeadingVaults = (user: string, signal?: AbortSignal) => info<{ address: string; name: string }[]>({ type: 'leadingVaults', user }, signal).catch(() => []);

/** Vault that runs Hyperliquid's backstop liquidations; trades against it are liquidations. */
export const HLP_LIQUIDATOR = '0x2e3d94f0562703b25c83308a05046ddaf9a8dd14';

export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
