// One-click trading actions shared by the account panel, the chart lines and the hotkeys.
import type { Market, OpenOrder } from '../hl/api';
import { limitWire, marketWire, reverseOf, triggerWire, type AnyOrderWire } from '../hl/orders';
import type { OrderResult } from './WalletContext';
import type { PositionRow } from './useAccount';

export interface Trader {
  placeOrders: (orders: AnyOrderWire[], grouping?: 'na' | 'normalTpsl' | 'positionTpsl') => Promise<OrderResult[]>;
  cancelOrders: (c: { a: number; o: number }[]) => Promise<void>;
  modifyOrder: (oid: number, order: AnyOrderWire) => Promise<OrderResult>;
}

const find = (markets: Market[], coin: string) => markets.find((m) => m.name === coin);
const mark = (m: Market) => Number(m.ctx.markPx);

export function describe(r: OrderResult, coin: string, verb = 'Order') {
  if (r.kind === 'error') return r.message;
  if (r.kind === 'filled') return `${verb} filled: ${r.totalSz} ${coin} at ${r.avgPx}.`;
  return `${verb} resting${r.oid ? ` (id ${r.oid})` : ''}.`;
}

export async function marketOrder(t: Trader, m: Market, isBuy: boolean, size: number, reduceOnly = false) {
  const [r] = await t.placeOrders([marketWire(m, isBuy, mark(m), size, reduceOnly)]);
  return describe(r, m.symbol, isBuy ? 'Buy' : 'Sell');
}

export async function closePosition(t: Trader, markets: Market[], p: PositionRow) {
  const m = find(markets, p.coin);
  if (!m) return `Unknown market ${p.coin}.`;
  const [r] = await t.placeOrders([marketWire(m, p.szi < 0, mark(m), Math.abs(p.szi), true)]);
  return describe(r, p.coin, 'Close');
}

export async function closeAll(t: Trader, markets: Market[], positions: PositionRow[]) {
  const orders = positions.flatMap((p) => {
    const m = find(markets, p.coin);
    return m ? [marketWire(m, p.szi < 0, mark(m), Math.abs(p.szi), true)] : [];
  });
  if (!orders.length) return 'No positions to close.';
  const rs = await t.placeOrders(orders);
  const bad = rs.filter((r) => r.kind === 'error');
  return bad.length ? `Closed ${rs.length - bad.length} of ${rs.length}: ${(bad[0] as { message: string }).message}` : `Closed ${rs.length} position${rs.length > 1 ? 's' : ''}.`;
}

/** Flip a position: one market order for twice its size the other way. */
export async function reversePosition(t: Trader, markets: Market[], p: PositionRow) {
  const m = find(markets, p.coin);
  if (!m) return `Unknown market ${p.coin}.`;
  const { isBuy, size } = reverseOf(p.szi);
  const [r] = await t.placeOrders([marketWire(m, isBuy, mark(m), size)]);
  return describe(r, p.coin, 'Reverse');
}

export async function cancelAll(t: Trader, markets: Market[], orders: OpenOrder[]) {
  const list = orders.flatMap((o) => {
    const m = find(markets, o.coin);
    return m ? [{ a: m.index, o: o.oid }] : [];
  });
  if (!list.length) return 'No open orders.';
  await t.cancelOrders(list);
  return `Cancelled ${list.length} order${list.length > 1 ? 's' : ''}.`;
}

/** Take-profit and/or stop for a whole position. */
export async function setPositionTpsl(t: Trader, m: Market, p: PositionRow, tp: number | null, sl: number | null) {
  const close = p.szi < 0;
  const orders = [
    ...(tp ? [triggerWire(m, close, tp, Math.abs(p.szi), 'tp')] : []),
    ...(sl ? [triggerWire(m, close, sl, Math.abs(p.szi), 'sl')] : []),
  ];
  if (!orders.length) return 'Enter a take-profit or a stop.';
  const rs = await t.placeOrders(orders, 'positionTpsl');
  const bad = rs.find((r) => r.kind === 'error') as { message: string } | undefined;
  return bad ? bad.message : `Set ${[tp && 'take-profit', sl && 'stop'].filter(Boolean).join(' and ')} on ${p.coin}.`;
}

export const isTpsl = (o: OpenOrder) => !!o.isTrigger || /take profit|stop/i.test(o.orderType);
export const tpslKind = (o: OpenOrder): 'tp' | 'sl' => (/take profit/i.test(o.orderType) ? 'tp' : 'sl');
/** The price an order line sits at: the trigger for TP/SL, the limit otherwise. */
export const linePrice = (o: OpenOrder) => Number(isTpsl(o) && o.triggerPx ? o.triggerPx : o.limitPx);

/** Move a resting order (limit or TP/SL) to a new price. */
export async function moveOrder(t: Trader, m: Market, o: OpenOrder, price: number) {
  const isBuy = o.side === 'B';
  const wire: AnyOrderWire = isTpsl(o)
    ? triggerWire(m, isBuy, price, Number(o.sz), tpslKind(o))
    : limitWire(m, isBuy, price, Number(o.sz), (o.tif as 'Gtc' | 'Alo' | 'Ioc' | null) === 'Alo' ? 'Alo' : 'Gtc', o.reduceOnly);
  const r = await t.modifyOrder(o.oid, wire);
  return r.kind === 'error' ? r.message : `Moved ${isTpsl(o) ? (tpslKind(o) === 'tp' ? 'take-profit' : 'stop') : 'order'} to ${wire.t && 'trigger' in wire.t ? wire.t.trigger.triggerPx : wire.p}.`;
}
