// Drawing tools: trend line, horizontal line, rectangle, Fib retracement, freehand pen, text box,
// and up/down arrow markers. Points are stored as (time ms, price) so drawings survive zoom,
// interval changes and reloads.
import { BasePrimitive, TimeMapper } from './primitives';
import type { IPrimitivePaneRenderer } from 'lightweight-charts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

export type DrawingKind = 'trend' | 'hline' | 'rect' | 'fib' | 'pen' | 'text' | 'arrowUp' | 'arrowDown';
export interface Pt {
  t: number;
  p: number;
}
export interface Drawing {
  id: string;
  kind: DrawingKind;
  a: Pt;
  b: Pt; // equals a for one-point drawings
  color: string;
  pts?: Pt[]; // freehand path
  text?: string; // text box contents
}

/** How a drawing is placed: one click, two clicks, or press-and-drag. */
export type PlaceMode = 'one' | 'two' | 'drag';

export const DRAWING_INFO: Record<DrawingKind, { label: string; icon: string; place: PlaceMode; key: string }> = {
  trend: { label: 'Trend line', icon: '╱', place: 'two', key: 'T' },
  hline: { label: 'Horizontal line', icon: '─', place: 'one', key: 'H' },
  rect: { label: 'Rectangle', icon: '▭', place: 'two', key: 'R' },
  fib: { label: 'Fib retracement', icon: 'Fib', place: 'two', key: 'F' },
  pen: { label: 'Freehand pen', icon: '✎', place: 'drag', key: 'P' },
  text: { label: 'Text box', icon: 'Aa', place: 'one', key: 'X' },
  arrowUp: { label: 'Arrow up', icon: '▲', place: 'one', key: 'U' },
  arrowDown: { label: 'Arrow down', icon: '▼', place: 'one', key: 'D' },
};

export const DRAW_COLORS = ['#f5c542', '#26c6da', '#a78bfa', '#f472b6', '#34d399', '#f87171', '#e5e7eb', '#fb923c'];

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

const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const MONO = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
const TEXT_PAD = 6;
const LINE_H = 16;

export class DrawingsPrimitive extends BasePrimitive {
  drawings: Drawing[] = [];
  draft: Drawing | null = null; // being placed, follows the cursor
  selected: string | null = null;
  decimals = 2;
  private measure: CanvasRenderingContext2D | null = null;

  constructor(mapper: TimeMapper) {
    super(mapper, 'top');
  }

  /** Width and height of a text box, in pixels. */
  textBox(text: string) {
    if (!this.measure) this.measure = document.createElement('canvas').getContext('2d');
    const lines = (text || ' ').split('\n');
    let w = 0;
    if (this.measure) {
      this.measure.font = FONT;
      for (const l of lines) w = Math.max(w, this.measure.measureText(l).width);
    }
    return { w: w + TEXT_PAD * 2, h: lines.length * LINE_H + TEXT_PAD };
  }

  /** Id of the drawing under a pane point, if any (8px tolerance). */
  hit(px: number, py: number): string | null {
    const tol = 8;
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      const g = this.geom(d);
      if (!g) continue;
      const { x1, y1, x2, y2 } = g;
      switch (d.kind) {
        case 'hline':
          if (Math.abs(py - y1) <= tol) return d.id;
          break;
        case 'trend':
          if (segDist(px, py, x1, y1, x2, y2) <= tol) return d.id;
          break;
        case 'rect':
          if (px >= Math.min(x1, x2) - tol && px <= Math.max(x1, x2) + tol && py >= Math.min(y1, y2) - tol && py <= Math.max(y1, y2) + tol) return d.id;
          break;
        case 'fib':
          if (px >= Math.min(x1, x2) - tol) {
            for (const lv of FIB_LEVELS) {
              const y = this.y(d.b.p + (d.a.p - d.b.p) * lv);
              if (y !== null && Math.abs(py - y) <= tol) return d.id;
            }
          }
          break;
        case 'pen': {
          const pts = this.path(d);
          for (let j = 1; j < pts.length; j++) if (segDist(px, py, pts[j - 1][0], pts[j - 1][1], pts[j][0], pts[j][1]) <= tol) return d.id;
          break;
        }
        case 'text': {
          const { w, h } = this.textBox(d.text ?? '');
          if (px >= x1 - 2 && px <= x1 + w + 2 && py >= y1 - 2 && py <= y1 + h + 2) return d.id;
          break;
        }
        case 'arrowUp':
          if (Math.abs(px - x1) <= 10 && py >= y1 - 4 && py <= y1 + 26) return d.id;
          break;
        case 'arrowDown':
          if (Math.abs(px - x1) <= 10 && py <= y1 + 4 && py >= y1 - 26) return d.id;
          break;
      }
    }
    return null;
  }

  /** 'a' or 'b' when (px, py) is on an end-point handle of a two-point drawing. */
  handleAt(id: string, px: number, py: number): 'a' | 'b' | null {
    const d = this.drawings.find((x) => x.id === id);
    if (!d || !(d.kind === 'trend' || d.kind === 'rect' || d.kind === 'fib')) return null;
    const g = this.geom(d);
    if (!g) return null;
    if (Math.hypot(px - g.x1, py - g.y1) <= 9) return 'a';
    if (Math.hypot(px - g.x2, py - g.y2) <= 9) return 'b';
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

  private path(d: Drawing): [number, number][] {
    const out: [number, number][] = [];
    for (const pt of d.pts ?? []) {
      const x = this.x(pt.t);
      const y = this.y(pt.p);
      if (x !== null && y !== null) out.push([x, y]);
    }
    return out;
  }

  protected draw(target: Target) {
    const all = this.draft ? [...this.drawings, this.draft] : this.drawings;
    if (all.length === 0) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      for (const d of all) {
        const g = this.geom(d);
        if (!g) continue;
        const { x1, y1, x2, y2 } = g;
        const sel = d.id === this.selected || d === this.draft;
        ctx.strokeStyle = d.color;
        ctx.fillStyle = d.color;
        ctx.lineWidth = sel ? 2 : 1.25;
        ctx.setLineDash([]);
        ctx.font = MONO;
        let handles: [number, number][] = [
          [x1, y1],
          [x2, y2],
        ];
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
          handles = [[x1, y1]];
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
          const tight = Math.abs(y1 - y2) < 90;
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
        } else if (d.kind === 'pen') {
          const pts = this.path(d);
          if (pts.length > 1) {
            ctx.lineWidth = sel ? 2.5 : 2;
            // Smooth the path: curve through the midpoints, using each recorded point as the control.
            ctx.beginPath();
            ctx.moveTo(pts[0][0], pts[0][1]);
            for (let j = 1; j < pts.length - 1; j++) {
              const mx = (pts[j][0] + pts[j + 1][0]) / 2;
              const my = (pts[j][1] + pts[j + 1][1]) / 2;
              ctx.quadraticCurveTo(pts[j][0], pts[j][1], mx, my);
            }
            const last = pts[pts.length - 1];
            ctx.lineTo(last[0], last[1]);
            ctx.stroke();
          }
          handles = pts.length ? [pts[0], pts[pts.length - 1]] : [];
        } else if (d.kind === 'text') {
          const { w, h } = this.textBox(d.text ?? '');
          ctx.fillStyle = 'rgba(11,15,20,0.85)';
          ctx.fillRect(x1, y1, w, h);
          ctx.strokeRect(x1, y1, w, h);
          ctx.fillStyle = d.color;
          ctx.font = FONT;
          ctx.textBaseline = 'top';
          (d.text || '').split('\n').forEach((line, i) => ctx.fillText(line, x1 + TEXT_PAD, y1 + TEXT_PAD / 2 + 2 + i * LINE_H));
          ctx.textBaseline = 'alphabetic';
          handles = [[x1, y1]];
        } else if (d.kind === 'arrowUp' || d.kind === 'arrowDown') {
          // The tip sits on the clicked price; the arrow points at it from below (up) or above (down).
          const s = d.kind === 'arrowUp' ? 1 : -1;
          ctx.beginPath();
          ctx.moveTo(x1, y1);
          ctx.lineTo(x1 - 8, y1 + s * 10);
          ctx.lineTo(x1 - 3, y1 + s * 10);
          ctx.lineTo(x1 - 3, y1 + s * 22);
          ctx.lineTo(x1 + 3, y1 + s * 22);
          ctx.lineTo(x1 + 3, y1 + s * 10);
          ctx.lineTo(x1 + 8, y1 + s * 10);
          ctx.closePath();
          ctx.fill();
          handles = sel ? [[x1, y1]] : [];
        }
        if (sel) {
          for (const [hx, hy] of handles) {
            ctx.beginPath();
            ctx.arc(hx, hy, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = '#0b0f14';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = d.color;
            ctx.stroke();
          }
        }
      }
    });
  }
}
