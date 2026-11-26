import { describe, expect, it } from 'vitest';
import { EXAMPLES, ScriptError, check, run, type ScriptCandle } from '../hyperscript';
import { ema, rsi, sma } from '../../hl/indicators';

const candles: ScriptCandle[] = Array.from({ length: 300 }, (_, i) => {
  const c = 100 + Math.sin(i / 7) * 10 + i * 0.05;
  return { t: 1_700_000_000_000 + i * 60_000, o: c - 0.5, h: c + 1, l: c - 1, c, v: 10 + (i % 5) };
});
const closes = candles.map((k) => k.c);
const close = (a: Float64Array, b: number[]) => a.forEach((v, i) => (Number.isNaN(b[i]) ? expect(v).toBeNaN() : expect(v).toBeCloseTo(b[i], 8)));

describe('HyperScript', () => {
  it('matches the built-in indicators', () => {
    const out = run('plot(sma(close, 20))\nplot(ema(close, 50))\nplot(rsi(close, 14))', candles);
    close(out.plots[0].values, sma(closes, 20));
    close(out.plots[1].values, ema(closes, 50));
    close(out.plots[2].values, rsi(closes, 14));
  });

  it('handles operators, precedence, lookback and ternaries', () => {
    const out = run('x = 1 + 2 * 3\nplot(close - close[1])\nplot(close > open ? 1 : -1)\nplot(x + 0 * close)', candles);
    expect(out.plots[0].values[0]).toBeNaN();
    expect(out.plots[0].values[5]).toBeCloseTo(closes[5] - closes[4], 10);
    expect(out.plots[1].values[3]).toBe(1);
    expect(out.plots[2].values[10]).toBe(7);
  });

  it('reads inputs with overrides and indicator options', () => {
    const src = 'indicator("Test", overlay = false)\nn = input("Length", 10)\nplot(sma(close, n))';
    const a = run(src, candles);
    expect(a.name).toBe('Test');
    expect(a.overlay).toBe(false);
    expect(a.inputs).toEqual([{ name: 'Length', def: 10 }]);
    const b = run(src, candles, { Length: 30 });
    close(b.plots[0].values, sma(closes, 30));
  });

  it('marks crossovers as shapes', () => {
    const out = run('plotshape(crossover(close, sma(close, 10)), "x", "up")', candles);
    expect(out.shapes[0].bars.length).toBeGreaterThan(2);
  });

  it('reports errors with line numbers', () => {
    expect(check('a = 1\nb = foo(2)')?.message).toBe('Line 2: Unknown function foo()');
    expect(check('plot(close')).toBeInstanceOf(ScriptError);
    expect(check('x = sma(close, 10\nplot(x)')?.message).toBe('Line 1: "(" after sma is never closed');
    expect(check('close = 1')?.message).toMatch(/built in/);
    expect(check('plot(sma(close, 0))')?.message).toMatch(/Length/);
  });

  it('cannot reach JavaScript', () => {
    expect(check('constructor("alert(1)")')).toBeInstanceOf(ScriptError);
    expect(check('x = window')?.message).toMatch(/Unknown name/);
  });

  it('runs every example', () => {
    for (const ex of EXAMPLES) {
      const out = run(ex.code, candles);
      expect(out.plots.length).toBeGreaterThan(0);
    }
  });
});
