// Historical order levels: where the market has bought and sold.
//
// 1. Volume profile: traded volume at each price over the loaded candles, split into buying and
//    selling by where each candle closed in its range (a close at the high counts as all buying).
//    Hyperliquid's API has no historical order book, so this is the history we can show for any
//    market immediately, and it is what marks the levels where big buying or selling happened.
// 2. Book history: the order-book heatmap is saved in this browser (IndexedDB) per market, so the
//    resting-order history keeps building across visits instead of starting empty each time.
import { BasePrimitive, TimeMapper, type BookSnapshot } from './primitives';
import type { Candle } from './indicators';
import type { IPrimitivePaneRenderer } from 'lightweight-charts';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface ProfileRow {
  px: number; // bucket centre
  buy: number; // USD
  sell: number;
}

export interface VolumeProfile {
  rows: ProfileRow[];
  step: number;
  poc: number; // price with the most volume
  vah: number; // value area high (70% of volume)
  val: number; // value area low
}

export function volumeProfile(candles: Candle[], buckets = 80): VolumeProfile | null {
  if (candles.length < 2) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const k of candles) {
    lo = Math.min(lo, k.l);
    hi = Math.max(hi, k.h);
  }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / buckets;
  const rows: ProfileRow[] = Array.from({ length: buckets }, (_, i) => ({ px: lo + (i + 0.5) * step, buy: 0, sell: 0 }));
  for (const k of candles) {
    const usd = k.v * ((k.h + k.l + k.c) / 3);
    if (!(usd > 0)) continue;
    const range = k.h - k.l;
    const buyShare = range > 0 ? (k.c - k.l) / range : k.c >= k.o ? 1 : 0;
    // Spread the candle's volume evenly across the buckets its range covers.
    const i0 = Math.max(0, Math.min(buckets - 1, Math.floor((k.l - lo) / step)));
    const i1 = Math.max(0, Math.min(buckets - 1, Math.floor((k.h - lo) / step)));
    const per = usd / (i1 - i0 + 1);
    for (let i = i0; i <= i1; i++) {
      rows[i].buy += per * buyShare;
      rows[i].sell += per * (1 - buyShare);
    }
  }
  const total = rows.reduce((s, r) => s + r.buy + r.sell, 0);
  let pocI = 0;
  rows.forEach((r, i) => {
    if (r.buy + r.sell > rows[pocI].buy + rows[pocI].sell) pocI = i;
  });
  // Value area: grow out from the POC until 70% of volume is covered.
  let a = pocI;
  let b = pocI;
  let covered = rows[pocI].buy + rows[pocI].sell;
  while (covered < total * 0.7 && (a > 0 || b < buckets - 1)) {
    const up = b < buckets - 1 ? rows[b + 1].buy + rows[b + 1].sell : -1;
    const dn = a > 0 ? rows[a - 1].buy + rows[a - 1].sell : -1;
    if (up >= dn) covered += rows[++b].buy + rows[b].sell;
    else covered += rows[--a].buy + rows[a].sell;
  }
  return { rows, step, poc: rows[pocI].px, vah: rows[b].px + step / 2, val: rows[a].px - step / 2 };
}

/** Horizontal histogram on the left edge: buying in the up colour, selling in the down colour. */
export class VolumeProfilePrimitive extends BasePrimitive {
  profile: VolumeProfile | null = null;
  enabled = false;
  up = '#34d399';
  down = '#f87171';

  constructor(mapper: TimeMapper) {
    super(mapper, 'bottom');
  }

  protected draw(target: Target) {
    const vp = this.profile;
    if (!this.enabled || !vp) return;
    const max = Math.max(...vp.rows.map((r) => r.buy + r.sell), 1);
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const maxW = Math.min(220, mediaSize.width * 0.3);
      for (const r of vp.rows) {
        const yTop = this.y(r.px + vp.step / 2);
        const yBot = this.y(r.px - vp.step / 2);
        if (yTop === null || yBot === null) continue;
        const top = Math.min(yTop, yBot);
        const h = Math.max(1, Math.abs(yBot - yTop) - 1);
        if (top > mediaSize.height || top + h < 0) continue;
        const inValue = r.px >= vp.val && r.px <= vp.vah;
        const a = inValue ? 0.45 : 0.22;
        const wb = (r.buy / max) * maxW;
        const ws = (r.sell / max) * maxW;
        ctx.globalAlpha = a;
        ctx.fillStyle = this.up;
        ctx.fillRect(0, top, wb, h);
        ctx.fillStyle = this.down;
        ctx.fillRect(wb, top, ws, h);
      }
      ctx.globalAlpha = 1;
      const yp = this.y(vp.poc);
      if (yp !== null) {
        ctx.strokeStyle = '#f5c542';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yp);
        ctx.lineTo(mediaSize.width, yp);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#f5c542';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText('Most traded (POC)', 4, yp - 4);
      }
    });
  }
}

// ---------- Book history in IndexedDB ----------

const DB = 'hyperspace';
const STORE = 'bookHistory';
const KEEP_MS = 24 * 3600_000;

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

const histKey = (coin: string, nSigFigs: number | null) => `${coin}|${nSigFigs ?? 'tick'}`;

/** Saved book snapshots for a market (last 24h), oldest first. */
export async function loadBookHistory(coin: string, nSigFigs: number | null): Promise<BookSnapshot[]> {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const req = db.transaction(STORE).objectStore(STORE).get(histKey(coin, nSigFigs));
    req.onsuccess = () => {
      const cutoff = Date.now() - KEEP_MS;
      resolve(((req.result as BookSnapshot[] | undefined) ?? []).filter((s) => s.t >= cutoff));
    };
    req.onerror = () => resolve([]);
  });
}

/**
 * Save snapshots, thinned so older history takes less room: every column from the last 2 hours,
 * one every 10 seconds before that, back to 24 hours.
 */
export async function saveBookHistory(coin: string, nSigFigs: number | null, snaps: BookSnapshot[]) {
  const db = await openDb();
  if (!db) return;
  const out = thinSnapshots(snaps);
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(out, histKey(coin, nSigFigs));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

/** Columns stored per market: the in-memory heatmap keeps the same thinning. */
export function thinSnapshots(snaps: BookSnapshot[]): BookSnapshot[] {
  const now = Date.now();
  const out: BookSnapshot[] = [];
  let lastOld = 0;
  for (const s of snaps) {
    if (s.t < now - KEEP_MS) continue;
    if (s.t < now - 2 * 3600_000) {
      if (s.t - lastOld < 10_000) continue;
      lastOld = s.t;
    }
    out.push(s);
  }
  return out;
}
