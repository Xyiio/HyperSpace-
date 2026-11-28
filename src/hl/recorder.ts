// Records every market's open interest, price, funding and volume while HyperSpace is open,
// because Hyperliquid's API only serves the current values. Samples are kept in IndexedDB:
// one every 5 minutes for the last 24 hours, then one every 30 minutes back to 7 days.
// The recorder also spots new listings by comparing market names with the last known set.
import type { Market } from './api';
import { NETWORK } from './network';

export interface MarketSample {
  t: number;
  /** coin → [open interest in coins, mark price, funding rate per hour, 24h volume USD] */
  d: Record<string, [number, number, number, number]>;
}

const DB = 'hyperspace-markets';
const STORE = 'samples';
const KEY = `all.${NETWORK}`;
const EVERY_MS = 5 * 60_000;
const FINE_MS = 24 * 3600_000;
const KEEP_MS = 7 * 24 * 3600_000;

let cache: MarketSample[] | null = null;
let loading: Promise<MarketSample[]> | null = null;
const listeners = new Set<() => void>();

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

export function loadSamples(): Promise<MarketSample[]> {
  if (cache) return Promise.resolve(cache);
  loading ??= openDb().then(
    (db) =>
      new Promise<MarketSample[]>((resolve) => {
        if (!db) return resolve((cache = []));
        const req = db.transaction(STORE).objectStore(STORE).get(KEY);
        req.onsuccess = () => resolve((cache = (req.result as MarketSample[] | undefined) ?? []));
        req.onerror = () => resolve((cache = []));
      }),
  );
  return loading;
}

async function save(samples: MarketSample[]) {
  const db = await openDb();
  if (!db) return;
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(samples, KEY);
}

/** Older samples are thinned to one per 30 minutes. */
export function thin(samples: MarketSample[], now = Date.now()): MarketSample[] {
  const out: MarketSample[] = [];
  let lastOld = 0;
  for (const s of samples) {
    if (s.t < now - KEEP_MS) continue;
    if (s.t < now - FINE_MS) {
      if (s.t - lastOld < 30 * 60_000) continue;
      lastOld = s.t;
    }
    out.push(s);
  }
  return out;
}

/** Call on every markets refresh; stores a sample at most every 5 minutes. */
export async function recordMarkets(markets: Market[], now = Date.now()) {
  const samples = await loadSamples();
  const last = samples[samples.length - 1];
  if (last && now - last.t < EVERY_MS) return;
  const d: MarketSample['d'] = {};
  for (const m of markets) d[m.name] = [Number(m.ctx.openInterest), Number(m.ctx.markPx), Number(m.ctx.funding), Number(m.ctx.dayNtlVlm)];
  cache = thin([...samples, { t: now, d }], now);
  listeners.forEach((l) => l());
  await save(cache);
}

export function onSamples(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Open interest in USD for one coin over time. */
export function oiSeries(samples: MarketSample[], coin: string): { t: number; v: number }[] {
  return samples.flatMap((s) => (s.d[coin] ? [{ t: s.t, v: s.d[coin][0] * s.d[coin][1] }] : []));
}

/**
 * Change in open interest (USD) over `windowMs`, using the oldest sample at least that old,
 * or the oldest sample there is. `since` says how far back the comparison really goes.
 */
export function oiChange(samples: MarketSample[], m: Market, windowMs: number, now = Date.now()): { pct: number; since: number } | null {
  if (!samples.length) return null;
  const target = now - windowMs;
  let base = samples[0];
  for (const s of samples) {
    if (s.t <= target) base = s;
    else break;
  }
  const b = base.d[m.name];
  if (!b || now - base.t < 60_000) return null;
  const then = b[0] * b[1];
  const nowUsd = Number(m.ctx.openInterest) * Number(m.ctx.markPx);
  return then > 0 ? { pct: (nowUsd - then) / then, since: base.t } : null;
}

// ---------- New listings ----------

const KNOWN = `hs.knownMarkets.${NETWORK}`;

/** Names that were not in the last known set. The first run only remembers the set. */
export function newListings(markets: Market[]): string[] {
  let known: string[] | null = null;
  try {
    known = JSON.parse(localStorage.getItem(KNOWN) ?? 'null');
  } catch {
    known = null;
  }
  const names = markets.map((m) => m.name);
  try {
    localStorage.setItem(KNOWN, JSON.stringify(names));
  } catch {
    /* not persisted */
  }
  if (!known) return [];
  const set = new Set(known);
  return names.filter((n) => !set.has(n));
}

/** Markets first seen in this browser within the last 7 days, for "New" badges. */
const FIRST_SEEN = `hs.firstSeen.${NETWORK}`;
export function markFirstSeen(names: string[], now = Date.now()) {
  try {
    const m = JSON.parse(localStorage.getItem(FIRST_SEEN) ?? '{}') as Record<string, number>;
    for (const n of names) m[n] ??= now;
    for (const [k, t] of Object.entries(m)) if (now - t > 7 * 86_400_000) delete m[k];
    localStorage.setItem(FIRST_SEEN, JSON.stringify(m));
  } catch {
    /* not persisted */
  }
}
export function recentListings(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(FIRST_SEEN) ?? '{}');
  } catch {
    return {};
  }
}
