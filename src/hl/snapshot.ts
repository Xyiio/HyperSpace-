// Chart snapshot links: the market, timeframe, drawings and built-in indicators packed into
// the URL (deflate + base64url), so a shared link opens the same chart in HyperSpace with no
// backend. HyperScript indicators are left out to keep links short.
import type { Interval } from './api';
import type { Drawing } from './drawings';
import type { IndicatorConfig } from './indicators';

export interface Snapshot {
  v: 1;
  coin: string;
  vs: string | null;
  interval: Interval;
  drawings: Drawing[];
  indicators: IndicatorConfig[];
  at: number;
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([data as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Rounds coordinates so links stay short. */
function slim(d: Drawing): Drawing {
  const r = (p: { t: number; p: number }) => ({ t: Math.round(p.t), p: Number(p.p.toPrecision(7)) });
  return { ...d, a: r(d.a), b: r(d.b), ...(d.pts ? { pts: d.pts.filter((_, i, all) => all.length < 200 || i % Math.ceil(all.length / 200) === 0).map(r) } : {}) };
}

export async function encodeSnapshot(s: Omit<Snapshot, 'v' | 'at'>): Promise<string> {
  const body: Snapshot = { v: 1, at: Date.now(), ...s, drawings: s.drawings.map(slim), indicators: s.indicators.filter((i) => i.kind !== 'script') };
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return b64url(await pipe(bytes, new CompressionStream('deflate-raw')));
}

export async function decodeSnapshot(code: string): Promise<Snapshot | null> {
  try {
    const json = new TextDecoder().decode(await pipe(fromB64url(code), new DecompressionStream('deflate-raw')));
    const s = JSON.parse(json) as Snapshot;
    return s.v === 1 && typeof s.coin === 'string' && Array.isArray(s.drawings) ? s : null;
  } catch {
    return null;
  }
}

export function snapshotUrl(code: string, coin: string) {
  return `${location.origin}${location.pathname}#/trade/${encodeURIComponent(coin)}?snap=${code}`;
}
