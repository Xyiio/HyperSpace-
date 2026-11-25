// Next-candle prediction ("ghost candle").
//
// A small, transparent model, not a promise. It blends three signals into a score from -1 to 1:
//   - trend: fast EMA vs slow EMA, measured in ATRs
//   - stretch: RSI far from 50 leans the other way (mean reversion)
//   - order book: resting bid vs ask size near the price, from Hyperliquid's live book
// The expected move is the score times half an ATR, and the wicks come from the ATR too.
// We also backtest the direction call (without the book term, which has no history) on the
// loaded candles, so the chart can show how often it would have been right.
import { ema, rsi, type Candle } from './indicators';
import { BasePrimitive, TimeMapper } from './primitives';
import { withAlpha } from './chartStyle';
import type { IPrimitivePaneRenderer } from 'lightweight-charts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface Prediction {
  t: number; // open time of the predicted bar
  o: number;
  h: number;
  l: number;
  c: number;
  score: number; // -1..1
  parts: { trend: number; stretch: number; book: number };
  hitRate: number | null; // share of past bars where the direction call was right
  tested: number;
}

/** Wilder's average true range. */
export function atr(candles: Candle[], n: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  let sum = 0;
  let prev = NaN;
  for (let i = 1; i < candles.length; i++) {
    const k = candles[i];
    const pc = candles[i - 1].c;
    const tr = Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
    if (i <= n) {
      sum += tr;
      if (i === n) out[i] = prev = sum / n;
    } else {
      out[i] = prev = (prev * (n - 1) + tr) / n;
    }
  }
  return out;
}

const W = { trend: 0.55, stretch: 0.2, book: 0.25 };

function signals(closes: number[], fast: number[], slow: number[], r: number[], a: number[], i: number) {
  if ([fast[i], slow[i], r[i], a[i]].some((v) => Number.isNaN(v)) || a[i] <= 0) return null;
  const trend = Math.tanh((fast[i] - slow[i]) / a[i]);
  const stretch = Math.max(-1, Math.min(1, (50 - r[i]) / 30));
  return { trend, stretch, close: closes[i] };
}

/** Bid share minus ask share of resting size within 0.5% of the mid, from -1 to 1. */
export function bookImbalance(bids: [number, number][], asks: [number, number][], mid: number) {
  const near = (lv: [number, number][]) => lv.filter(([px]) => Math.abs(px - mid) / mid <= 0.005).reduce((s, [px, sz]) => s + px * sz, 0);
  const b = near(bids);
  const s = near(asks);
  return b + s > 0 ? (b - s) / (b + s) : 0;
}

export function predictNext(candles: Candle[], intervalMs: number, imbalance: number): Prediction | null {
  if (candles.length < 60) return null;
  const closes = candles.map((k) => k.c);
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  const last = candles.length - 1;

  // Backtest the direction call on completed bars (the last bar is still forming).
  let right = 0;
  let tested = 0;
  for (let i = 30; i < last - 1; i++) {
    const s = signals(closes, fast, slow, r, a, i);
    if (!s) continue;
    const score = (W.trend * s.trend + W.stretch * s.stretch) / (W.trend + W.stretch);
    if (Math.abs(score) < 0.05) continue;
    const move = closes[i + 1] - closes[i];
    if (move === 0) continue;
    tested++;
    if (Math.sign(move) === Math.sign(score)) right++;
  }

  const s = signals(closes, fast, slow, r, a, last);
  if (!s) return null;
  const book = Math.max(-1, Math.min(1, imbalance));
  const score = W.trend * s.trend + W.stretch * s.stretch + W.book * book;
  const atrNow = a[last];
  const o = s.close;
  const c = o + score * 0.5 * atrNow;
  const wick = 0.3 * atrNow;
  return {
    t: candles[last].t + intervalMs,
    o,
    c,
    h: Math.max(o, c) + wick * (score < 0 ? 0.6 : 1),
    l: Math.min(o, c) - wick * (score > 0 ? 0.6 : 1),
    score,
    parts: { trend: s.trend, stretch: s.stretch, book },
    hitRate: tested ? right / tested : null,
    tested,
  };
}

/** Draws the predicted candle one slot to the right of the last bar, in dulled colours with a dashed outline. */
export class GhostCandlePrimitive extends BasePrimitive {
  prediction: Prediction | null = null;
  enabled = false;
  up = '#34d399';
  down = '#f87171';

  constructor(mapper: TimeMapper) {
    super(mapper, 'top');
  }

  protected draw(target: Target) {
    const p = this.prediction;
    if (!this.enabled || !p || !this.chart) return;
    const x = this.x(p.t);
    const xPrev = this.x(p.t - this.mapper.intervalMs);
    const yo = this.y(p.o);
    const yc = this.y(p.c);
    const yh = this.y(p.h);
    const yl = this.y(p.l);
    if (x === null || xPrev === null || yo === null || yc === null || yh === null || yl === null) return;
    const spacing = Math.max(3, x - xPrev);
    const half = Math.max(3, spacing * 0.4);
    const col = p.c >= p.o ? this.up : this.down;
    target.useMediaCoordinateSpace(({ context: ctx }) => {
      ctx.strokeStyle = withAlpha(col, 0.75);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yh);
      ctx.lineTo(x, yl);
      ctx.stroke();
      const top = Math.min(yo, yc);
      const h = Math.max(2, Math.abs(yc - yo));
      ctx.fillStyle = withAlpha(col, 0.4);
      ctx.fillRect(x - half, top, half * 2, h);
      ctx.setLineDash([3, 2]);
      ctx.strokeRect(x - half, top, half * 2, h);
      ctx.setLineDash([]);
      // Label above the wick, on a dark chip so it reads over the heatmap.
      ctx.font = '10px system-ui, sans-serif';
      const label = 'next?';
      const tw = ctx.measureText(label).width;
      const ly = Math.min(yh, yl) - 16;
      ctx.fillStyle = 'rgba(11,15,20,0.85)';
      ctx.fillRect(x - tw / 2 - 3, ly, tw + 6, 13);
      ctx.fillStyle = withAlpha(col, 0.95);
      ctx.fillText(label, x - tw / 2, ly + 10);
    });
  }
}
