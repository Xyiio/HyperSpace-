// Paper trading: a practice account on live Hyperliquid prices with pretend USDC.
// Orders use the same wire format as real ones, so the order ticket, chart lines and hotkeys
// work unchanged. Fills happen at the live mid (taker) or at the order price when a resting
// order is crossed (maker). Fees follow Hyperliquid's base tier. Nothing here touches the network.
import type { AnyOrderWire, Grouping } from '../hl/orders';

export const PAPER_START_USD = 10_000;
const TAKER_FEE = 0.00045;
const MAKER_FEE = 0.00015;
const TWAP_SLICE_MS = 30_000;
const KEEP_FILLS = 500;

export interface PaperOrder {
  oid: number;
  coin: string;
  a: number;
  isBuy: boolean;
  px: number;
  sz: number;
  origSz: number;
  reduceOnly: boolean;
  tif: 'Gtc' | 'Ioc' | 'Alo';
  trigger?: { px: number; tpsl: 'tp' | 'sl' };
  /** TP/SL of a bracket wait for this entry order to fill. */
  parent?: number;
  ts: number;
}

export interface PaperFill {
  coin: string;
  px: number;
  sz: number;
  side: 'B' | 'A';
  time: number;
  dir: string;
  closedPnl: number;
  fee: number;
  oid: number;
}

export interface PaperTwap {
  id: number;
  coin: string;
  a: number;
  isBuy: boolean;
  sz: number;
  executed: number;
  executedNtl: number;
  minutes: number;
  reduceOnly: boolean;
  start: number;
  lastSlice: number;
  status: 'activated' | 'finished' | 'terminated';
}

export interface PaperState {
  v: 1;
  balance: number; // cash: deposits plus realized PnL minus fees
  positions: Record<string, { szi: number; entryPx: number; maxLev: number }>;
  orders: PaperOrder[];
  fills: PaperFill[];
  twaps: PaperTwap[];
  nextId: number;
  mids: Record<string, number>;
}

export type PaperResult = { kind: 'resting'; oid: number } | { kind: 'filled'; oid: number; avgPx: string; totalSz: string } | { kind: 'error'; message: string };

export const newPaper = (balance = PAPER_START_USD): PaperState => ({ v: 1, balance, positions: {}, orders: [], fills: [], twaps: [], nextId: 1, mids: {} });

const clone = (s: PaperState): PaperState => structuredClone(s);

function dirOf(prev: number, isBuy: boolean, closing: boolean) {
  if (closing) return prev > 0 ? 'Close Long' : 'Close Short';
  return isBuy ? 'Open Long' : 'Open Short';
}

/** Applies a fill to the position and balance. Returns the size actually filled. */
function applyFill(s: PaperState, coin: string, isBuy: boolean, px: number, size: number, maker: boolean, oid: number, now: number, maxLev: number, reduceOnly: boolean): number {
  const pos = s.positions[coin] ?? { szi: 0, entryPx: 0, maxLev };
  const opposing = pos.szi !== 0 && pos.szi > 0 !== isBuy;
  if (reduceOnly) {
    if (!opposing) return 0;
    size = Math.min(size, Math.abs(pos.szi));
  }
  if (size <= 0) return 0;
  const fee = px * size * (maker ? MAKER_FEE : TAKER_FEE);
  let remaining = size;
  if (opposing) {
    const closeSz = Math.min(Math.abs(pos.szi), remaining);
    const pnl = closeSz * (px - pos.entryPx) * Math.sign(pos.szi);
    s.fills.push({ coin, px, sz: closeSz, side: isBuy ? 'B' : 'A', time: now, dir: dirOf(pos.szi, isBuy, true), closedPnl: pnl, fee: fee * (closeSz / size), oid });
    s.balance += pnl;
    pos.szi += isBuy ? closeSz : -closeSz;
    remaining -= closeSz;
    if (Math.abs(pos.szi) < 1e-12) pos.szi = 0;
  }
  if (remaining > 0) {
    const abs = Math.abs(pos.szi);
    pos.entryPx = abs === 0 ? px : (abs * pos.entryPx + remaining * px) / (abs + remaining);
    pos.szi += isBuy ? remaining : -remaining;
    s.fills.push({ coin, px, sz: remaining, side: isBuy ? 'B' : 'A', time: now, dir: dirOf(pos.szi, isBuy, false), closedPnl: 0, fee: fee * (remaining / size), oid });
  }
  s.balance -= fee;
  pos.maxLev = maxLev;
  if (pos.szi === 0) delete s.positions[coin];
  else s.positions[coin] = pos;
  if (s.fills.length > KEEP_FILLS) s.fills.splice(0, s.fills.length - KEEP_FILLS);
  // A flat position cancels its TP/SL.
  if (!s.positions[coin]) s.orders = s.orders.filter((o) => !(o.coin === coin && o.trigger && o.parent === undefined));
  return size;
}

export function accountValue(s: PaperState): number {
  let v = s.balance;
  for (const [coin, p] of Object.entries(s.positions)) v += p.szi * ((s.mids[coin] ?? p.entryPx) - p.entryPx);
  return v;
}

function marginUsed(s: PaperState, extraCoin?: string, extraNtl = 0): number {
  let m = 0;
  for (const [coin, p] of Object.entries(s.positions)) m += (Math.abs(p.szi) * (s.mids[coin] ?? p.entryPx)) / p.maxLev;
  if (extraCoin) m += extraNtl;
  return m;
}

export interface CoinInfo {
  coin: string;
  maxLeverage: number;
}

/**
 * Places orders. `coinOf` maps an asset id to its coin and max leverage.
 * Market (IOC) orders and limit orders that cross fill at once at the mid.
 */
export function place(state: PaperState, orders: AnyOrderWire[], grouping: Grouping, coinOf: (a: number) => CoinInfo | undefined, now = Date.now()): { state: PaperState; results: PaperResult[] } {
  const s = clone(state);
  const results: PaperResult[] = [];
  let parentOid: number | undefined;
  let parentFilled = false;
  orders.forEach((w, i) => {
    const info = coinOf(w.a);
    if (!info) return results.push({ kind: 'error', message: 'Unknown market.' });
    const mid = s.mids[info.coin];
    if (!mid) return results.push({ kind: 'error', message: 'No live price yet for this market; try again in a moment.' });
    const px = Number(w.p);
    const size = Number(w.s);
    const oid = s.nextId++;
    if ('trigger' in w.t) {
      const isChild = grouping === 'normalTpsl' && i > 0 && parentOid !== undefined;
      s.orders.push({
        oid,
        coin: info.coin,
        a: w.a,
        isBuy: w.b,
        px,
        sz: size,
        origSz: size,
        reduceOnly: true,
        tif: 'Gtc',
        trigger: { px: Number(w.t.trigger.triggerPx), tpsl: w.t.trigger.tpsl },
        ...(isChild && !parentFilled ? { parent: parentOid } : {}),
        ts: now,
      });
      return results.push({ kind: 'resting', oid });
    }
    const tif = w.t.limit.tif;
    const crosses = w.b ? px >= mid : px <= mid;
    // Margin check for orders that add to a position.
    const pos = s.positions[info.coin];
    const adds = !pos || pos.szi > 0 === w.b;
    if (!w.r && adds && marginUsed(s, info.coin, (size * mid) / info.maxLeverage) > accountValue(s) + 1e-9)
      return results.push({ kind: 'error', message: 'Insufficient margin in the paper account.' });
    if (i === 0) parentOid = oid;
    if (crosses) {
      if (tif === 'Alo') return results.push({ kind: 'error', message: 'Post only order would have immediately matched.' });
      const filled = applyFill(s, info.coin, w.b, mid, size, false, oid, now, info.maxLeverage, w.r);
      if (filled <= 0) return results.push({ kind: 'error', message: 'Reduce only order would increase the position.' });
      if (i === 0) parentFilled = true;
      return results.push({ kind: 'filled', oid, avgPx: String(mid), totalSz: String(filled) });
    }
    if (tif === 'Ioc') return results.push({ kind: 'error', message: 'Order could not immediately match against any resting orders.' });
    s.orders.push({ oid, coin: info.coin, a: w.a, isBuy: w.b, px, sz: size, origSz: size, reduceOnly: w.r, tif, ts: now });
    results.push({ kind: 'resting', oid });
  });
  return { state: s, results };
}

export function cancel(state: PaperState, oids: number[]): PaperState {
  const s = clone(state);
  const drop = new Set(oids);
  // Cancelling a bracket entry also cancels its waiting TP/SL.
  s.orders = s.orders.filter((o) => !drop.has(o.oid) && !(o.parent !== undefined && drop.has(o.parent)));
  return s;
}

/** Moves a resting order to a new price (and trigger price for TP/SL). */
export function modify(state: PaperState, oid: number, px: number, triggerPx?: number): PaperState {
  const s = clone(state);
  const o = s.orders.find((x) => x.oid === oid);
  if (o) {
    o.px = px;
    if (o.trigger && triggerPx !== undefined) o.trigger.px = triggerPx;
  }
  return s;
}

export function startTwap(state: PaperState, w: { a: number; b: boolean; s: string; r: boolean; m: number }, coinOf: (a: number) => CoinInfo | undefined, now = Date.now()): { state: PaperState; result: { kind: 'running'; twapId: number } | { kind: 'error'; message: string } } {
  const info = coinOf(w.a);
  if (!info) return { state, result: { kind: 'error', message: 'Unknown market.' } };
  const s = clone(state);
  const id = s.nextId++;
  s.twaps.push({ id, coin: info.coin, a: w.a, isBuy: w.b, sz: Number(w.s), executed: 0, executedNtl: 0, minutes: w.m, reduceOnly: w.r, start: now, lastSlice: now - TWAP_SLICE_MS, status: 'activated' });
  return { state: s, result: { kind: 'running', twapId: id } };
}

export function stopTwap(state: PaperState, id: number): PaperState {
  const s = clone(state);
  const t = s.twaps.find((x) => x.id === id);
  if (t && t.status === 'activated') t.status = 'terminated';
  return s;
}

/**
 * Feeds new mid prices: fills crossed limit orders, fires TP/SL, runs TWAP slices and
 * liquidates the account if equity falls below maintenance margin.
 * Returns the same object when nothing changed, so callers can skip saving.
 */
export function tick(state: PaperState, mids: Record<string, number>, coinOf: (coin: string) => CoinInfo | undefined, now = Date.now()): PaperState {
  const relevant = new Set([...state.orders.map((o) => o.coin), ...Object.keys(state.positions), ...state.twaps.filter((t) => t.status === 'activated').map((t) => t.coin)]);
  const changedPx = [...relevant].some((c) => mids[c] !== undefined && mids[c] !== state.mids[c]);
  const twapDue = state.twaps.some((t) => t.status === 'activated' && now - t.lastSlice >= TWAP_SLICE_MS);
  if (!changedPx && !twapDue) return state;
  const s = clone(state);
  for (const c of relevant) if (mids[c] !== undefined) s.mids[c] = mids[c];
  const lev = (coin: string) => coinOf(coin)?.maxLeverage ?? 20;

  // Resting limit orders and active triggers.
  for (const o of [...s.orders]) {
    const mid = s.mids[o.coin];
    if (!mid || o.parent !== undefined) continue;
    let fill: { px: number; maker: boolean } | null = null;
    if (o.trigger) {
      const closingLong = !o.isBuy; // a sell trigger closes a long
      const t = o.trigger.px;
      const hit = o.trigger.tpsl === 'tp' ? (closingLong ? mid >= t : mid <= t) : closingLong ? mid <= t : mid >= t;
      if (hit) fill = { px: mid, maker: false };
    } else if (o.isBuy ? mid <= o.px : mid >= o.px) fill = { px: o.px, maker: true };
    if (!fill) continue;
    s.orders = s.orders.filter((x) => x.oid !== o.oid);
    applyFill(s, o.coin, o.isBuy, fill.px, o.sz, fill.maker, o.oid, now, lev(o.coin), o.reduceOnly);
    // An entry that filled activates its TP/SL.
    for (const c of s.orders) if (c.parent === o.oid) delete c.parent;
  }

  // TWAP slices: one every 30 seconds, sized so the order completes on time.
  for (const t of s.twaps) {
    if (t.status !== 'activated') continue;
    const mid = s.mids[t.coin];
    if (!mid) continue;
    const slices = Math.max(1, Math.round((t.minutes * 60_000) / TWAP_SLICE_MS));
    while (now - t.lastSlice >= TWAP_SLICE_MS && t.executed < t.sz - 1e-12) {
      t.lastSlice += TWAP_SLICE_MS;
      if (t.lastSlice > now) t.lastSlice = now;
      const sliceSz = Math.min(t.sz / slices, t.sz - t.executed);
      const filled = applyFill(s, t.coin, t.isBuy, mid, sliceSz, false, t.id, now, lev(t.coin), t.reduceOnly);
      t.executed += filled || sliceSz; // a reduce-only slice with nothing to reduce still counts as done
      t.executedNtl += filled * mid;
    }
    if (t.executed >= t.sz - 1e-12 || now - t.start > t.minutes * 60_000 + TWAP_SLICE_MS) t.status = 'finished';
  }

  // Liquidation: equity below maintenance margin (half the initial margin at max leverage).
  const mm = Object.entries(s.positions).reduce((m, [c, p]) => m + (Math.abs(p.szi) * (s.mids[c] ?? p.entryPx)) / (2 * p.maxLev), 0);
  if (mm > 0 && accountValue(s) < mm) {
    for (const [c, p] of Object.entries(s.positions)) {
      const before = s.fills.length;
      applyFill(s, c, p.szi < 0, s.mids[c] ?? p.entryPx, Math.abs(p.szi), false, 0, now, p.maxLev, true);
      for (let i = before; i < s.fills.length; i++) s.fills[i].dir = 'Liquidation';
    }
    s.orders = [];
  }
  return s;
}

export interface PaperPositionView {
  coin: string;
  szi: number;
  entryPx: number;
  mark: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  liquidationPx: number | null;
  marginUsed: number;
}

/** Liquidation price of one position, holding everything else in the account still. */
function liqPx(s: PaperState, coin: string): number | null {
  const p = s.positions[coin];
  if (!p) return null;
  const mmr = 1 / (2 * p.maxLev);
  const mark = s.mids[coin] ?? p.entryPx;
  const other = accountValue(s) - p.szi * (mark - p.entryPx);
  const a = Math.abs(p.szi);
  const px = p.szi > 0 ? (a * p.entryPx - other) / (a * (1 - mmr)) : (other + a * p.entryPx) / (a * (1 + mmr));
  return px > 0 && Number.isFinite(px) ? px : null;
}

export function positionsView(s: PaperState): PaperPositionView[] {
  return Object.entries(s.positions).map(([coin, p]) => {
    const mark = s.mids[coin] ?? p.entryPx;
    const upnl = p.szi * (mark - p.entryPx);
    const margin = (Math.abs(p.szi) * mark) / p.maxLev;
    return {
      coin,
      szi: p.szi,
      entryPx: p.entryPx,
      mark,
      positionValue: Math.abs(p.szi) * mark,
      unrealizedPnl: upnl,
      returnOnEquity: margin ? upnl / margin : 0,
      liquidationPx: liqPx(s, coin),
      marginUsed: margin,
    };
  });
}

export const withdrawable = (s: PaperState) => Math.max(0, accountValue(s) - marginUsed(s));
