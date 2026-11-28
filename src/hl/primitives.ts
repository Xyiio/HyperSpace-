// Custom lightweight-charts primitives: an order-book heatmap drawn behind the candles,
// and large-trade bubbles drawn on top. Both place points by wall-clock time, so they
// can sit between bar opens (sub-bar resolution).
import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  PrimitivePaneViewZOrder,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts';

type CanvasRenderingTarget2D = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface BookSnapshot {
  t: number; // ms
  step: number; // price bucket size
  bids: [number, number][]; // [px, sz]
  asks: [number, number][];
}

export interface BigTrade {
  t: number;
  px: number;
  notional: number;
  buy: boolean;
  liq?: boolean; // one side was Hyperliquid's liquidator
}

/** Shared time→x mapping for primitives attached to a candle series. */
export class TimeMapper {
  barTimesMs: number[] = [];
  intervalMs = 60_000;

  /** Fractional logical index for a wall-clock time. */
  logical(tMs: number): number | null {
    const bars = this.barTimesMs;
    if (bars.length === 0) return null;
    let lo = 0;
    let hi = bars.length - 1;
    if (tMs < bars[0]) return (tMs - bars[0]) / this.intervalMs;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bars[mid] <= tMs) lo = mid;
      else hi = mid - 1;
    }
    return lo + (tMs - bars[lo]) / this.intervalMs;
  }

  /** Inverse of logical(): wall-clock time for a fractional bar index (extrapolates past either end). */
  timeAt(logical: number): number | null {
    const bars = this.barTimesMs;
    if (bars.length === 0) return null;
    const i = Math.max(0, Math.min(bars.length - 1, Math.floor(logical)));
    return bars[i] + (logical - i) * this.intervalMs;
  }
}

export abstract class BasePrimitive implements ISeriesPrimitive<Time> {
  protected chart: IChartApi | null = null;
  protected series: ISeriesApi<SeriesType> | null = null;
  private requestUpdate: (() => void) | null = null;
  private readonly view: IPrimitivePaneView;

  constructor(protected mapper: TimeMapper, zOrder: PrimitivePaneViewZOrder) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { zOrder: () => zOrder, renderer: () => renderer };
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart as IChartApi;
    this.series = p.series as ISeriesApi<SeriesType>;
    this.requestUpdate = p.requestUpdate;
  }

  detached() {
    this.chart = this.series = this.requestUpdate = null;
  }

  paneViews() {
    return [this.view];
  }

  update() {
    this.requestUpdate?.();
  }

  x(tMs: number): number | null {
    const l = this.mapper.logical(tMs);
    if (l === null || !this.chart) return null;
    // logicalToCoordinate only resolves whole bar indices, so interpolate between two.
    const ts = this.chart.timeScale();
    const i = Math.floor(l);
    const a = ts.logicalToCoordinate(i as Logical);
    const b = ts.logicalToCoordinate((i + 1) as Logical);
    if (a === null || b === null) return null;
    return a + (l - i) * (b - a);
  }

  y(px: number): number | null {
    return this.series?.priceToCoordinate(px) ?? null;
  }

  protected abstract draw(target: CanvasRenderingTarget2D): void;
}

export class HeatmapPrimitive extends BasePrimitive {
  snapshots: BookSnapshot[] = [];
  enabled = true;

  constructor(mapper: TimeMapper) {
    super(mapper, 'bottom');
  }

  protected draw(target: CanvasRenderingTarget2D) {
    if (!this.enabled || !this.chart || !this.series || this.snapshots.length === 0) return;
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (!range) return;

    // Only snapshots whose column is on screen.
    const visible: { s: BookSnapshot; x0: number; x1: number }[] = [];
    const now = Date.now();
    for (let i = 0; i < this.snapshots.length; i++) {
      const s = this.snapshots[i];
      // A column lasts until the next snapshot, but never across a gap (the tab was closed).
      const next = Math.min(this.snapshots[i + 1]?.t ?? Math.max(now, s.t + 1000), s.t + 15_000);
      const x0 = this.x(s.t);
      const x1 = this.x(next);
      if (x0 === null || x1 === null) continue;
      if (x1 < 0) continue;
      visible.push({ s, x0, x1 });
    }
    if (visible.length === 0) return;

    // Normalise colour to the 97th-percentile resting notional on screen (square-root scaled),
    // so one whale wall does not wash out everything else.
    const sizes: number[] = [];
    for (const { s } of visible) {
      for (const [px, sz] of s.bids) sizes.push(px * sz);
      for (const [px, sz] of s.asks) sizes.push(px * sz);
    }
    sizes.sort((a, b) => a - b);
    const cap = sizes[Math.floor(sizes.length * 0.97)] || 1;

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr, bitmapSize }) => {
      const paint = (levels: [number, number][], step: number, x0: number, w: number, rgb: string) => {
        for (const [px, sz] of levels) {
          const yTop = this.y(px + step / 2);
          const yBot = this.y(px - step / 2);
          if (yTop === null || yBot === null) continue;
          const yy = Math.floor(Math.min(yTop, yBot) * vr);
          const h = Math.max(1, Math.ceil(Math.max(yTop, yBot) * vr) - yy);
          if (yy > bitmapSize.height || yy + h < 0) continue;
          const a = Math.min(1, Math.sqrt((px * sz) / cap));
          if (a < 0.05) continue;
          ctx.fillStyle = `rgba(${rgb},${(0.85 * a).toFixed(3)})`;
          ctx.fillRect(x0, yy, w, h);
        }
      };
      for (const { s, x0, x1 } of visible) {
        const bx0 = Math.round(x0 * hr);
        const w = Math.max(1, Math.round(x1 * hr) - bx0);
        paint(s.bids, s.step, bx0, w, '38,198,218');
        paint(s.asks, s.step, bx0, w, '255,150,64');
      }
    });
  }
}

export class TradeBubblesPrimitive extends BasePrimitive {
  trades: BigTrade[] = [];
  threshold = 100_000;

  constructor(mapper: TimeMapper) {
    super(mapper, 'top');
  }

  protected draw(target: CanvasRenderingTarget2D) {
    if (!this.chart || this.trades.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      for (const t of this.trades) {
        const x = this.x(t.t);
        const y = this.y(t.px);
        if (x === null || y === null || x < -30 || x > mediaSize.width + 30) continue;
        const r = Math.min(26, 3 + 4 * Math.sqrt(t.notional / this.threshold));
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = t.buy ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)';
        ctx.strokeStyle = t.liq ? 'rgba(250,204,21,1)' : t.buy ? 'rgba(52,211,153,0.95)' : 'rgba(248,113,113,0.95)';
        ctx.lineWidth = t.liq ? 2.5 : 1;
        ctx.fill();
        ctx.stroke();
        if (t.liq && r >= 8) {
          ctx.fillStyle = '#facc15';
          ctx.font = 'bold 9px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText('LIQ', x, y + 3);
          ctx.textAlign = 'left';
        }
      }
    });
  }
}
