import { describe, expect, it } from 'vitest';
import { bollinger, ema, macd, rsi, sma, vwap } from '../indicators';

describe('indicators', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  it('sma', () => {
    const s = sma(xs, 3);
    expect(s.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(s[2]).toBe(2);
    expect(s[9]).toBe(9);
  });
  it('ema seeds with the sma and converges on a constant', () => {
    expect(ema(xs, 3)[2]).toBe(2);
    expect(ema(xs, 3)[3]).toBeCloseTo(3);
    expect(ema(new Array(50).fill(5), 10)[49]).toBeCloseTo(5);
  });
  it('bollinger bands are symmetric around the mean', () => {
    const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
    expect(b.mid[7]).toBe(5);
    expect(b.upper[7]).toBeCloseTo(9);
    expect(b.lower[7]).toBeCloseTo(1);
  });
  it('rsi is 100 on a straight rise and 50 on alternating equal moves', () => {
    expect(rsi(xs, 5)[9]).toBe(100);
    const alt = Array.from({ length: 30 }, (_, i) => (i % 2 ? 11 : 10));
    expect(rsi(alt, 14)[29]).toBeGreaterThan(45);
    expect(rsi(alt, 14)[29]).toBeLessThan(55);
  });
  it('macd is zero on a flat series', () => {
    const m = macd(new Array(60).fill(3), 12, 26, 9);
    expect(m.line[59]).toBeCloseTo(0);
    expect(m.hist[59]).toBeCloseTo(0);
  });
  it('vwap resets each UTC day', () => {
    const day = 86_400_000;
    const v = vwap([
      { t: 0, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: 60_000, o: 3, h: 3, l: 3, c: 3, v: 1 },
      { t: day, o: 10, h: 10, l: 10, c: 10, v: 5 },
    ]);
    expect(v[1]).toBe(2);
    expect(v[2]).toBe(10);
    // A series that starts mid-day leaves that day blank.
    const w = vwap([
      { t: 3_600_000, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { t: day, o: 4, h: 4, l: 4, c: 4, v: 1 },
    ]);
    expect(Number.isNaN(w[0])).toBe(true);
    expect(w[1]).toBe(4);
  });
});
