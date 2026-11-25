// Drawing tools: trend line, horizontal line, rectangle, Fibonacci retracement.
// Points are stored as (time ms, price) so drawings survive zoom, interval changes and reloads.
import { BasePrimitive, TimeMapper } from './primitives';
import type { IPrimitivePaneRenderer } from 'lightweight-charts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

export type DrawingKind = 'trend' | 'hline' | 'rect' | 'fib';
export interface Pt {
  t: number;
  p: number;
}
export interface Drawing {
  id: string;
  kind: DrawingKind;
  a: Pt;
  b: Pt; // equals a for hline
  color: string;
}

export const DRAWING_INFO: Record<DrawingKind, { label: string; points: 1 | 2; key: string }> = {
  trend: { label: 'Trend line', points: 2, key: 'T' },
  hline: { label: 'Horizontal line', points: 1, key: 'H' },
  rect: { label: 'Rectangle', points: 2, key: 'R' },
  fib: { label: 'Fib retracement', points: 2, key: 'F' },
};

export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];

const storageKey = (coin: string) => `hs.drawings.${coin}`;

export function loadDrawings(coin: string): Drawing[] {
  try {
    const raw = localStorage.getItem(storageKey(coin));
    return raw ? (JSON.parse(raw) as Drawing[]) : [];
  } catch {
    return [];
  }
}

export function saveDrawings(coin: string, list: Drawing[]) {
  try {
    if (list.length) localStorage.setItem(storageKey(coin), JSON.stringify(list));
    else localStorage.removeItem(storageKey(coin));
  } catch {
    /* storage unavailable: drawings last for this page load */
  }
}

/** Distance from point to segment, in pixels. */
function segDist(px: number, py: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0;
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export class DrawingsPrimitive extends BasePrimitive {
  drawings: Drawing[] = [];
  draft: Drawing | null = null; // being placed, follows the cursor
  selected: string | null = null;
  decimals = 2;

  constructor(mapper: TimeMapper) {
    super(mapper, 'top');
  }

  /** Id of the drawing under a pane point, if any (8px tolerance). */
  hit(px: number, py: number): string | null {
    const tol = 8;
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      const g = this.geom(d);
      if (!g) continue;
      const { x1, y1, x2, y2 } = g;
      if (d.kind === 'hline' && Math.abs(py - y1) <= tol) return d.id;
      if (d.kind === 'trend' && segDist(px, py, x1, y1, x2, y2) <= tol) return d.id;
      if (d.kind === 'rect' && px >= Math.min(x1, x2) - tol && px <= Math.max(x1, x2) + tol && py >= Math.min(y1, y2) - tol && py <= Math.max(y1, y2) + tol)
        return d.id;
      if (d.kind === 'fib' && px >= Math.min(x1, x2) - tol) {
        for (const lv of FIB_LEVELS) {
          const y = this.y(d.b.p + (d.a.p - d.b.p) * lv);
          if (y !== null && Math.abs(py - y) <= tol) return d.id;
        }
      }
    }
    return null;
  }

  private geom(d: Drawing) {
    const x1 = this.x(d.a.t);
    const x2 = this.x(d.b.t);
    const y1 = this.y(d.a.p);
    const y2 = this.y(d.b.p);
    if (x1 === null || x2 === null || y1 === null || y2 === null) return null;
    return { x1, y1, x2, y2 };
  }

  protected draw(target: Target) {
    const all = this.draft ? [...this.drawings, this.draft] : this.drawings;
    if (all.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      for (const d of all) {
        const g = this.geom(d);
        if (!g) continue;
        const { x1, y1, x2, y2 } = g;
        const sel = d.id === this.selected || d === this.draft;
        ctx.strokeStyle = d.color;
        ctx.fillStyle = d.color;
        ctx.lineWidth = sel ? 2 : 1.25;
        ctx.setLineDash([]);
        if (d.kind === 'trend') {
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
        } else if (d.kind === 'hline') {
          ctx.beginPath();
          ctx.moveTo(0, y1);
          ctx.lineTo(mediaSize.width, y1);
          ctx.stroke();
          ctx.fillText(d.a.p.toFixed(this.decimals), 6, y1 - 4);
        } else if (d.kind === 'rect') {
          ctx.globalAlpha = 0.12;
          ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          ctx.globalAlpha = 1;
          ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
        } else if (d.kind === 'fib') {
          const left = Math.min(x1, x2);
          const right = Math.max(x1, x2, mediaSize.width - 60);
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x2, y2);
          ctx.stroke();
          ctx.setLineDash([]);
          // When the levels are packed tightly, label only the ends so the text stays readable.
          const yA = this.y(d.a.p);
          const yB = this.y(d.b.p);
          const tight = yA !== null && yB !== null && Math.abs(yA - yB) < 90;
          for (const lv of FIB_LEVELS) {
            const price = d.b.p + (d.a.p - d.b.p) * lv;
            const y = this.y(price);
            if (y === null) continue;
            ctx.globalAlpha = lv === 0 || lv === 1 ? 1 : 0.75;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            ctx.stroke();
            if (!tight || lv === 0 || lv === 1) ctx.fillText(`${lv} (${price.toFixed(this.decimals)})`, left + 4, y - 3);
          }
          ctx.globalAlpha = 1;
        }
        if (sel) {
          for (const [hx, hy] of d.kind === 'hline' ? [[x1, y1]] : [[x1, y1], [x2, y2]]) {
            ctx.beginPath();
            ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = '#0b0f14';
            ctx.fill();
            ctx.stroke();
          }
        }
      }
    });
  }
}
