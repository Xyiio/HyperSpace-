import { describe, expect, it } from 'vitest';
import { bracket, bracketError, estLiqPrice, limitWire, reverseOf, riskSize, scaleLadder, scaleWires, triggerWire } from '../orders';

const BTC = { index: 0, szDecimals: 5 };

describe('order building', () => {
  it('sizes a trade from the stop and the dollars at risk', () => {
    expect(riskSize(100_000, 98_000, 100)).toBeCloseTo(0.05);
    expect(riskSize(100, 100, 100)).toBe(0);
  });

  it('builds a bracket with normalTpsl grouping', () => {
    const entry = limitWire(BTC, true, 100_000, 0.01);
    const b = bracket(BTC, { isBuy: true, entry, size: 0.01, takeProfit: 105_000, stopLoss: 98_000 });
    expect(b.grouping).toBe('normalTpsl');
    expect(b.orders).toHaveLength(3);
    expect(b.orders[1]).toMatchObject({ b: false, r: true, t: { trigger: { tpsl: 'tp', triggerPx: '105000', isMarket: true } } });
    expect(b.orders[2]).toMatchObject({ b: false, t: { trigger: { tpsl: 'sl', triggerPx: '98000' } } });
    expect(bracket(BTC, { isBuy: true, entry, size: 0.01, takeProfit: null, stopLoss: null }).grouping).toBe('na');
  });

  it('checks bracket levels', () => {
    expect(bracketError(true, 100, 110, 90)).toBeNull();
    expect(bracketError(true, 100, 90, null)).toMatch(/above/);
    expect(bracketError(false, 100, null, 90)).toMatch(/above/);
  });

  it('gives trigger orders a worst price 10% through the trigger', () => {
    expect(triggerWire(BTC, false, 100_000, 0.01, 'sl').p).toBe('90000');
    expect(triggerWire(BTC, true, 100_000, 0.01, 'sl').p).toBe('110000');
  });

  it('spreads a ladder evenly or skewed', () => {
    const even = scaleLadder(95_000, 90_000, 10, 1);
    expect(even[0].px).toBe(95_000);
    expect(even[9].px).toBe(90_000);
    expect(even.reduce((s, l) => s + l.sz, 0)).toBeCloseTo(1);
    const far = scaleLadder(100, 90, 4, 10, 'moreFar');
    expect(far[3].sz).toBeGreaterThan(far[0].sz);
    expect(scaleWires(BTC, true, even)).toHaveLength(10);
  });

  it('estimates an isolated liquidation price', () => {
    // 10x long at 100 with 40x max: liq ≈ 100 * 0.9 / 0.9875
    expect(estLiqPrice(100, true, 10, 40)).toBeCloseTo(91.139, 2);
    expect(estLiqPrice(100, false, 10, 40)).toBeCloseTo(108.64, 1);
  });

  it('reverses a position with twice its size', () => {
    expect(reverseOf(-0.5)).toEqual({ isBuy: true, size: 1 });
  });
});
