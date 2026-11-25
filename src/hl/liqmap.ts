// Liquidation map, built in the browser from public data.
//
// Hyperliquid has no "all positions" endpoint, so we discover wallets from the live trade stream
// (every trade carries both counterparties), then read each wallet's clearinghouseState to get its
// position and liquidation price on this market. Biggest traders are scanned first; each wallet is
// refreshed every few minutes. The result is an estimate: it covers only wallets seen trading
// since the page opened.
import { fetchClearinghouse, type Trade } from './api';
import { hlSocket } from './ws';
import { BasePrimitive, TimeMapper } from './primitives';
import type { IPrimitivePaneRenderer } from 'lightweight-charts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface LiqPosition {
  user: string;
  szi: number; // signed size: + long, - short
  liqPx: number;
  notional: number;
}

const SCANS_PER_SECOND = 2; // clearinghouseState weighs 2; this stays well under the 1200/min IP budget
const RESCAN_AFTER_MS = 3 * 60_000;
const MAX_WALLETS = 3000;

export class LiquidationScanner {
  positions = new Map<string, LiqPosition>();
  private seen = new Map<string, { volume: number; scannedAt: number }>();
  private unsub: (() => void) | null = null;
  private timer: number | undefined;
  private inFlight = 0;
  scanned = 0;

  constructor(
    private coin: string,
    private dex: string,
    private onChange: () => void,
  ) {}

  start() {
    this.unsub = hlSocket.subscribe({ type: 'trades', coin: this.coin }, (ts: Trade[]) => {
      for (const t of ts) {
        if (!t.users) continue;
        const ntl = Number(t.px) * Number(t.sz);
        for (const u of t.users) {
          const s = this.seen.get(u);
          if (s) s.volume += ntl;
          else if (this.seen.size < MAX_WALLETS) this.seen.set(u, { volume: ntl, scannedAt: 0 });
        }
      }
    });
    this.timer = window.setInterval(() => this.tick(), 1000 / SCANS_PER_SECOND);
  }

  stop() {
    this.unsub?.();
    window.clearInterval(this.timer);
  }

  get walletsSeen() {
    return this.seen.size;
  }

  private next(): string | null {
    const now = Date.now();
    let best: string | null = null;
    let bestScore = -1;
    for (const [u, s] of this.seen) {
      if (now - s.scannedAt < RESCAN_AFTER_MS) continue;
      // Never-scanned wallets first, then by traded volume.
      const score = (s.scannedAt === 0 ? 1e15 : 0) + s.volume;
      if (score > bestScore) {
        bestScore = score;
        best = u;
      }
    }
    return best;
  }

  private async tick() {
    if (this.inFlight >= 2) return;
    const user = this.next();
    if (!user) return;
    this.seen.get(user)!.scannedAt = Date.now();
    this.inFlight++;
    try {
      const st = await fetchClearinghouse(user, undefined, this.dex);
      this.scanned++;
      const p = st.assetPositions.find((a) => a.position.coin === this.coin)?.position;
      const liq = p?.liquidationPx ? Number(p.liquidationPx) : NaN;
      if (p && Number.isFinite(liq) && liq > 0 && Number(p.szi) !== 0) {
        this.positions.set(user, { user, szi: Number(p.szi), liqPx: liq, notional: Math.abs(Number(p.positionValue)) });
      } else {
        this.positions.delete(user);
      }
      this.onChange();
    } catch {
      /* rate-limited or network error: try this wallet again later */
    } finally {
      this.inFlight--;
    }
  }
}

/** A round bucket size near 0.2% of price (1, 2 or 5 times a power of ten). */
export function niceStep(px: number): number {
  const raw = px * 0.002;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const m = raw / pow;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * pow;
}

export interface LiqStats {
  wallets: number;
  scanned: number;
  positions: number;
  longs: number;
  shorts: number;
  below: { px: number; usd: number; pct: number } | null; // biggest long-liquidation cluster within 10% below
  above: { px: number; usd: number; pct: number } | null; // biggest short-liquidation cluster within 10% above
}

export interface LiqBucket {
  px: number;
  longs: number; // notional of longs liquidated at this level (below price)
  shorts: number; // notional of shorts liquidated at this level (above price)
}

export function bucketLiquidations(positions: Iterable<LiqPosition>, step: number): LiqBucket[] {
  const map = new Map<number, LiqBucket>();
  for (const p of positions) {
    const px = Math.round(p.liqPx / step) * step;
    const b = map.get(px) ?? { px, longs: 0, shorts: 0 };
    if (p.szi > 0) b.longs += p.notional;
    else b.shorts += p.notional;
    map.set(px, b);
  }
  return [...map.values()].sort((a, b) => a.px - b.px);
}

/** Horizontal bars along the right edge of the price pane: longs' liquidations in red, shorts' in green. */
export class LiquidationPrimitive extends BasePrimitive {
  buckets: LiqBucket[] = [];
  step = 1;
  enabled = false;

  constructor(mapper: TimeMapper) {
    super(mapper, 'normal');
  }

  protected draw(target: Target) {
    if (!this.enabled || this.buckets.length === 0) return;
    const max = Math.max(...this.buckets.map((b) => b.longs + b.shorts), 1);
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const maxW = Math.min(180, mediaSize.width * 0.25);
      for (const b of this.buckets) {
        const y1 = this.y(b.px + this.step / 2);
        const y2 = this.y(b.px - this.step / 2);
        if (y1 === null || y2 === null) continue;
        const top = Math.min(y1, y2);
        const h = Math.max(2, Math.abs(y2 - y1) - 1);
        if (top > mediaSize.height || top + h < 0) continue;
        const wl = (b.longs / max) * maxW;
        const ws = (b.shorts / max) * maxW;
        ctx.fillStyle = 'rgba(248,113,113,0.55)';
        ctx.fillRect(mediaSize.width - wl, top, wl, h);
        ctx.fillStyle = 'rgba(52,211,153,0.55)';
        ctx.fillRect(mediaSize.width - wl - ws, top, ws, h);
      }
    });
  }
}
