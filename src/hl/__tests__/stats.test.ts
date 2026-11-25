import { describe, expect, it } from 'vitest';
import { bookToSnapshot, fillStats, periodSummary, priceDecimals, roundPrice } from '../stats';
import { floatToWire } from '../order';
import type { Fill, Portfolio } from '../api';

const fill = (p: Partial<Fill>): Fill => ({
  coin: 'BTC', px: '100', sz: '1', side: 'B', time: 1, startPosition: '0', dir: 'Open Long',
  closedPnl: '0', hash: '0x', oid: 1, crossed: true, fee: '0.1', ...p,
});

describe('priceDecimals', () => {
  it('follows 5 significant figures and 6 - szDecimals', () => {
    expect(priceDecimals(97123, 5)).toBe(0);
    expect(priceDecimals(3412.5, 4)).toBe(1);
    expect(priceDecimals(1.2345, 0)).toBe(4);
    expect(priceDecimals(0.000123, 0)).toBe(6);
    expect(priceDecimals(0.000123, 2)).toBe(4);
    expect(roundPrice(97123.7, 5)).toBe(97124);
  });
});

describe('floatToWire', () => {
  it('strips trailing zeros', () => {
    expect(floatToWire(100, 2)).toBe('100');
    expect(floatToWire(0.1, 4)).toBe('0.1');
    expect(floatToWire(1.23456, 3)).toBe('1.235');
  });
});

describe('bookToSnapshot', () => {
  it('derives the bucket size from level spacing', () => {
    const s = bookToSnapshot({
      coin: 'BTC', time: 5,
      levels: [[{ px: '100', sz: '1', n: 1 }, { px: '90', sz: '2', n: 1 }], [{ px: '110', sz: '3', n: 2 }, { px: '120', sz: '1', n: 1 }]],
    });
    expect(s.step).toBe(10);
    expect(s.bids).toEqual([[100, 1], [90, 2]]);
    expect(s.t).toBe(5);
  });
});

describe('fillStats', () => {
  it('counts closing fills, wins, fees and liquidations', () => {
    const s = fillStats([
      fill({ time: 1 }),
      fill({ time: 2, side: 'A', dir: 'Close Long', closedPnl: '50', fee: '0.2' }),
      fill({ time: 3, coin: 'ETH', closedPnl: '-20', liquidation: { markPx: '1', method: 'market' } }),
    ]);
    expect(s.closing).toBe(2);
    expect(s.wins).toBe(1);
    expect(s.winRate).toBe(0.5);
    expect(s.realized).toBe(30);
    expect(s.fees).toBeCloseTo(0.4);
    expect(s.net).toBeCloseTo(29.6);
    expect(s.liquidations).toBe(1);
    expect(s.bestTrade).toBe(50);
    expect(s.worstTrade).toBe(-20);
    expect(s.byCoin.map((c) => c.coin)).toEqual(['BTC', 'ETH']);
  });
});

describe('periodSummary', () => {
  it('computes PnL change and max drawdown', () => {
    const p: Portfolio = [['allTime', {
      accountValueHistory: [[1, '100'], [2, '200'], [3, '150'], [4, '180']],
      pnlHistory: [[1, '0'], [2, '100'], [3, '50'], [4, '80']],
      vlm: '1000',
    }]];
    const s = periodSummary(p, 'allTime')!;
    expect(s.pnl).toBe(80);
    expect(s.maxDrawdown).toBeCloseTo(0.25);
    expect(s.volume).toBe(1000);
    expect(periodSummary(p, 'day')).toBeNull();
  });
});
