// Spot prices for the spot-vs-perp premium. Hyperliquid's spot pairs use wrapped names for
// bridged assets (UBTC, UETH, USOL…), so a perp is matched to the most traded USDC pair whose
// base token is the perp's name or that name with a U prefix.
import { fetchSpot, type Market } from './api';

export interface SpotQuote {
  pair: string; // e.g. "UBTC/USDC"
  px: number;
  volume: number;
}

let cache: { at: number; map: Map<string, SpotQuote> } | null = null;
let inflight: Promise<Map<string, SpotQuote>> | null = null;

export function spotByBase(): Promise<Map<string, SpotQuote>> {
  if (cache && Date.now() - cache.at < 60_000) return Promise.resolve(cache.map);
  inflight ??= fetchSpot()
    .then(([meta, ctxs]) => {
      const tok = new Map(meta.tokens.map((t) => [t.index, t.name]));
      const map = new Map<string, SpotQuote>();
      for (const u of meta.universe) {
        const ctx = ctxs[u.index];
        if (!ctx || tok.get(u.tokens[1]) !== 'USDC') continue;
        const base = tok.get(u.tokens[0])!;
        const q = { pair: `${base}/USDC`, px: Number(ctx.midPx ?? ctx.markPx), volume: Number(ctx.dayNtlVlm) };
        const old = map.get(base);
        if (q.px > 0 && (!old || q.volume > old.volume)) map.set(base, q);
      }
      cache = { at: Date.now(), map };
      return map;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The spot quote for a main-dex perp, if a liquid one exists ($10k+ daily volume). */
export function spotFor(m: Market, map: Map<string, SpotQuote>): SpotQuote | null {
  if (m.dex) return null;
  const q = map.get(m.name) ?? map.get(`U${m.name}`) ?? null;
  return q && q.volume >= 10_000 ? q : null;
}

/** Perp price over spot, as a fraction: positive means the perp trades rich (longs paying up). */
export const premium = (perpPx: number, spotPx: number) => (spotPx > 0 ? perpPx / spotPx - 1 : 0);
