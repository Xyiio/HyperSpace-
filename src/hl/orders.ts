// Order building beyond a single limit order: brackets (entry + take-profit + stop), scale
// ladders, risk-based sizing and trigger orders. Pure functions so they can be unit-tested.
// Wire shapes follow Hyperliquid's exchange API (see hyperliquid-python-sdk signing.py).
import { floatToWire } from './order';
import { priceDecimals, roundPrice } from './stats';

export type Tif = 'Gtc' | 'Ioc' | 'Alo';

export interface LimitWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: Tif } };
}

export interface TriggerWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { trigger: { isMarket: boolean; triggerPx: string; tpsl: 'tp' | 'sl' } };
}

export type AnyOrderWire = LimitWire | TriggerWire;
export type Grouping = 'na' | 'normalTpsl' | 'positionTpsl';

/** What the order code needs to know about a market. */
export interface MarketSpec {
  index: number;
  szDecimals: number;
}

const px = (m: MarketSpec, p: number) => {
  const r = roundPrice(p, m.szDecimals);
  return floatToWire(r, priceDecimals(r, m.szDecimals));
};
const sz = (m: MarketSpec, s: number) => floatToWire(s, m.szDecimals);

/** Round a size down to the market's lot size. */
export const floorSize = (s: number, szDecimals: number) => Math.floor(s * 10 ** szDecimals + 1e-9) / 10 ** szDecimals;

export function limitWire(m: MarketSpec, isBuy: boolean, price: number, size: number, tif: Tif = 'Gtc', reduceOnly = false): LimitWire {
  return { a: m.index, b: isBuy, p: px(m, price), s: sz(m, size), r: reduceOnly, t: { limit: { tif } } };
}

/** IOC limit through the mark: Hyperliquid has no true market orders. */
export const MARKET_SLIPPAGE = 0.01;
export function marketWire(m: MarketSpec, isBuy: boolean, mark: number, size: number, reduceOnly = false, slippage = MARKET_SLIPPAGE): LimitWire {
  return limitWire(m, isBuy, mark * (isBuy ? 1 + slippage : 1 - slippage), size, 'Ioc', reduceOnly);
}

/**
 * A take-profit or stop that closes `size` when the mark reaches `trigger`. It executes as a
 * market order with up to 10% slippage, which is how Hyperliquid's own app sends them.
 * `isBuy` is the side of the closing order (a long's TP and SL are sells).
 */
export function triggerWire(m: MarketSpec, isBuy: boolean, trigger: number, size: number, tpsl: 'tp' | 'sl'): TriggerWire {
  const worst = trigger * (isBuy ? 1.1 : 0.9);
  return { a: m.index, b: isBuy, p: px(m, worst), s: sz(m, size), r: true, t: { trigger: { isMarket: true, triggerPx: px(m, trigger), tpsl } } };
}

export interface BracketInput {
  isBuy: boolean;
  entry: LimitWire;
  size: number;
  takeProfit: number | null;
  stopLoss: number | null;
}

/** Entry plus optional TP and SL in one request. With either set, the group is `normalTpsl`. */
export function bracket(m: MarketSpec, b: BracketInput): { orders: AnyOrderWire[]; grouping: Grouping } {
  const orders: AnyOrderWire[] = [b.entry];
  if (b.takeProfit) orders.push(triggerWire(m, !b.isBuy, b.takeProfit, b.size, 'tp'));
  if (b.stopLoss) orders.push(triggerWire(m, !b.isBuy, b.stopLoss, b.size, 'sl'));
  return { orders, grouping: orders.length > 1 ? 'normalTpsl' : 'na' };
}

/** Checks a bracket's levels against the entry; returns an error message or null. */
export function bracketError(isBuy: boolean, entry: number, tp: number | null, sl: number | null): string | null {
  if (tp !== null && (isBuy ? tp <= entry : tp >= entry)) return `Take-profit must be ${isBuy ? 'above' : 'below'} the entry.`;
  if (sl !== null && (isBuy ? sl >= entry : sl <= entry)) return `Stop must be ${isBuy ? 'below' : 'above'} the entry.`;
  return null;
}

/** Size (in coins) so that being stopped out loses `riskUsd`. */
export function riskSize(entry: number, stop: number, riskUsd: number): number {
  const d = Math.abs(entry - stop);
  return d > 0 && riskUsd > 0 ? riskUsd / d : 0;
}

export type ScaleSkew = 'even' | 'moreFar' | 'moreNear';

/**
 * Splits `totalSize` across `count` limit prices from `from` to `to` (inclusive).
 * `moreFar` puts more size at `to`, `moreNear` more at `from`.
 */
export function scaleLadder(from: number, to: number, count: number, totalSize: number, skew: ScaleSkew = 'even'): { px: number; sz: number }[] {
  const n = Math.max(1, Math.floor(count));
  const w = Array.from({ length: n }, (_, i) => (skew === 'even' ? 1 : skew === 'moreFar' ? i + 1 : n - i));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map((wi, i) => ({ px: n === 1 ? from : from + ((to - from) * i) / (n - 1), sz: (totalSize * wi) / sum }));
}

export function scaleWires(m: MarketSpec, isBuy: boolean, ladder: { px: number; sz: number }[], tif: Tif = 'Gtc', reduceOnly = false): LimitWire[] {
  return ladder.map((l) => ({ ...l, sz: floorSize(l.sz, m.szDecimals) })).filter((l) => l.sz > 0).map((l) => limitWire(m, isBuy, l.px, l.sz, tif, reduceOnly));
}

/**
 * Rough liquidation price for an isolated position at `leverage`, using Hyperliquid's maintenance
 * margin of half the initial margin at max leverage. Cross positions depend on the whole account.
 */
export function estLiqPrice(entry: number, isLong: boolean, leverage: number, maxLeverage: number): number {
  const mmr = 1 / (2 * maxLeverage);
  const im = 1 / Math.max(1, leverage);
  // Liquidation when margin + PnL falls to maintenance: long p = e(1-im)/(1-mmr), short p = e(1+im)/(1+mmr).
  return isLong ? (entry * (1 - im)) / (1 - mmr) : (entry * (1 + im)) / (1 + mmr);
}

/** The side and size that flips a position: twice its size the other way. */
export function reverseOf(szi: number) {
  return { isBuy: szi < 0, size: Math.abs(szi) * 2 };
}
