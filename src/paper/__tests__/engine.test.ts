import { describe, expect, it } from 'vitest';
import { accountValue, cancel, newPaper, place, positionsView, startTwap, tick } from '../engine';
import { bracket, limitWire, marketWire, triggerWire } from '../../hl/orders';

const BTC = { index: 0, szDecimals: 5 };
const coinOf = (a: number) => (a === 0 ? { coin: 'BTC', maxLeverage: 40 } : undefined);
const byCoin = (c: string) => (c === 'BTC' ? { coin: 'BTC', maxLeverage: 40 } : undefined);
const withMid = (mid: number) => ({ ...newPaper(), mids: { BTC: mid } });

describe('paper engine', () => {
  it('fills a market buy at the mid and charges the taker fee', () => {
    const { state, results } = place(withMid(100_000), [marketWire(BTC, true, 100_000, 0.01)], 'na', coinOf, 1);
    expect(results[0].kind).toBe('filled');
    expect(state.positions.BTC.szi).toBeCloseTo(0.01);
    expect(state.positions.BTC.entryPx).toBe(100_000);
    expect(state.balance).toBeCloseTo(10_000 - 1000 * 0.00045);
  });

  it('rests a limit below the mid and fills it as maker when price falls through', () => {
    let { state } = place(withMid(100_000), [limitWire(BTC, true, 99_000, 0.01)], 'na', coinOf, 1);
    expect(state.orders).toHaveLength(1);
    state = tick(state, { BTC: 99_500 }, byCoin, 2);
    expect(state.orders).toHaveLength(1);
    state = tick(state, { BTC: 98_900 }, byCoin, 3);
    expect(state.orders).toHaveLength(0);
    expect(state.positions.BTC.entryPx).toBe(99_000);
    expect(state.fills.at(-1)!.fee).toBeCloseTo(990 * 0.00015);
  });

  it('rejects a post-only order that would cross', () => {
    const { results } = place(withMid(100_000), [limitWire(BTC, true, 100_500, 0.01, 'Alo')], 'na', coinOf);
    expect(results[0]).toMatchObject({ kind: 'error' });
  });

  it('realizes PnL on close and removes the position', () => {
    let { state } = place(withMid(100_000), [marketWire(BTC, true, 100_000, 0.1)], 'na', coinOf, 1);
    state = tick(state, { BTC: 101_000 }, byCoin, 2);
    expect(positionsView(state)[0].unrealizedPnl).toBeCloseTo(100);
    ({ state } = place(state, [marketWire(BTC, false, 101_000, 0.1, true)], 'na', coinOf, 3));
    expect(state.positions.BTC).toBeUndefined();
    expect(state.fills.at(-1)!.closedPnl).toBeCloseTo(100);
  });

  it('keeps bracket TP/SL waiting until the entry fills, then takes profit', () => {
    const entry = limitWire(BTC, true, 99_000, 0.01);
    const b = bracket(BTC, { isBuy: true, entry, size: 0.01, takeProfit: 101_000, stopLoss: 98_000 });
    let { state } = place(withMid(100_000), b.orders, b.grouping, coinOf, 1);
    expect(state.orders.filter((o) => o.parent !== undefined)).toHaveLength(2);
    // The take-profit level is reached before the entry fills: nothing happens.
    state = tick(state, { BTC: 101_500 }, byCoin, 2);
    expect(state.positions.BTC).toBeUndefined();
    state = tick(state, { BTC: 98_990 }, byCoin, 3);
    expect(state.positions.BTC.szi).toBeCloseTo(0.01);
    state = tick(state, { BTC: 101_200 }, byCoin, 4);
    expect(state.positions.BTC).toBeUndefined();
    expect(state.orders).toHaveLength(0); // the stop went with the position
  });

  it('cancels waiting TP/SL with their entry', () => {
    const b = bracket(BTC, { isBuy: true, entry: limitWire(BTC, true, 99_000, 0.01), size: 0.01, takeProfit: 101_000, stopLoss: null });
    const { state } = place(withMid(100_000), b.orders, b.grouping, coinOf, 1);
    expect(cancel(state, [state.orders[0].oid]).orders).toHaveLength(0);
  });

  it('stops out a short', () => {
    let { state } = place(withMid(100_000), [marketWire(BTC, false, 100_000, 0.01)], 'na', coinOf, 1);
    ({ state } = place(state, [triggerWire(BTC, true, 102_000, 0.01, 'sl')], 'positionTpsl', coinOf, 2));
    state = tick(state, { BTC: 102_100 }, byCoin, 3);
    expect(state.positions.BTC).toBeUndefined();
    expect(state.fills.at(-1)!.closedPnl).toBeCloseTo(-21);
  });

  it('runs a TWAP in 30-second slices', () => {
    let { state } = startTwap(withMid(100_000), { a: 0, b: true, s: '0.1', r: false, m: 5 }, coinOf, 0);
    state = tick(state, { BTC: 100_000 }, byCoin, 0);
    expect(state.twaps[0].executed).toBeCloseTo(0.01);
    state = tick(state, { BTC: 100_000 }, byCoin, 5 * 60_000);
    expect(state.twaps[0].executed).toBeCloseTo(0.1);
    expect(state.twaps[0].status).toBe('finished');
  });

  it('liquidates when equity falls below maintenance', () => {
    let { state } = place(withMid(100_000), [marketWire(BTC, true, 100_000, 3.9)], 'na', coinOf, 1);
    const liq = positionsView(state)[0].liquidationPx!;
    expect(liq).toBeGreaterThan(97_000);
    state = tick(state, { BTC: liq - 50 }, byCoin, 2);
    expect(state.positions.BTC).toBeUndefined();
    expect(state.fills.at(-1)!.dir).toBe('Liquidation');
    expect(accountValue(state)).toBeLessThan(10_000);
  });
});
