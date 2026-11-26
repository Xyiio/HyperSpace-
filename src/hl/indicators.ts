// Built-in indicators. Pure functions over candles; each returns arrays aligned to the input,
// with NaN where there is not enough history yet.

export interface Candle {
  t: number; // open time, ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export function sma(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** EMA seeded with the SMA of the first n values. */
export function ema(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  let seed = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(prev)) {
      seed += v;
      count++;
      if (count === n) {
        prev = seed / n;
        out[i] = prev;
      }
      continue;
    }
    prev = v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function bollinger(values: number[], n: number, mult: number) {
  const mid = sma(values, n);
  const upper = new Array<number>(values.length).fill(NaN);
  const lower = new Array<number>(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

/** Wilder's RSI. */
export function rsi(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0);
    const l = Math.max(-d, 0);
    if (i <= n) {
      gain += g;
      loss += l;
      if (i === n) {
        gain /= n;
        loss /= n;
        out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
      }
    } else {
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}

export function macd(values: number[], fast: number, slow: number, signal: number) {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line = values.map((_, i) => f[i] - s[i]);
  const sig = ema(line, signal);
  const hist = line.map((v, i) => v - sig[i]);
  return { line, signal: sig, hist };
}

/**
 * VWAP that resets at each UTC day boundary, using the typical price.
 * If the data starts mid-day, that first partial day is left blank rather than shown wrong.
 */
export function vwap(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  const partialDay = candles.length && candles[0].t % 86_400_000 !== 0 ? Math.floor(candles[0].t / 86_400_000) : null;
  let day = -1;
  let pv = 0;
  let vol = 0;
  candles.forEach((k, i) => {
    const d = Math.floor(k.t / 86_400_000);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const tp = (k.h + k.l + k.c) / 3;
    pv += tp * k.v;
    vol += k.v;
    if (d !== partialDay) out[i] = vol > 0 ? pv / vol : tp;
  });
  return out;
}

// ---------- Catalogue used by the UI ----------

export type BuiltinKind = 'sma' | 'ema' | 'bb' | 'vwap' | 'rsi' | 'macd';
export type IndicatorKind = BuiltinKind | 'script';

export interface IndicatorConfig {
  id: string;
  kind: IndicatorKind;
  params: number[];
  color: string;
  // HyperScript indicators carry their own code and input values.
  name?: string;
  code?: string;
  scriptId?: string;
  inputs?: Record<string, number>;
}

export const INDICATOR_INFO: Record<BuiltinKind, { label: string; params: { name: string; def: number }[]; pane: boolean }> = {
  sma: { label: 'Simple moving average', params: [{ name: 'Length', def: 20 }], pane: false },
  ema: { label: 'Exponential moving average', params: [{ name: 'Length', def: 50 }], pane: false },
  bb: { label: 'Bollinger Bands', params: [{ name: 'Length', def: 20 }, { name: 'Std dev', def: 2 }], pane: false },
  vwap: { label: 'VWAP (daily, UTC)', params: [], pane: false },
  rsi: { label: 'RSI', params: [{ name: 'Length', def: 14 }], pane: true },
  macd: { label: 'MACD', params: [{ name: 'Fast', def: 12 }, { name: 'Slow', def: 26 }, { name: 'Signal', def: 9 }], pane: true },
};

export const PALETTE = ['#f5c542', '#a78bfa', '#60a5fa', '#f472b6', '#fb923c', '#4ade80'];

export const shortName = (c: IndicatorConfig) =>
  c.kind === 'script' ? (c.name ?? 'Script') : `${c.kind.toUpperCase()}${c.params.length ? ` ${c.params.join(', ')}` : ''}`;
