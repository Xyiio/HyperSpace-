// Verified PnL badges: a small "+$120k 30d" next to a name, read live from the wallet's
// Hyperliquid portfolio, so claims in chat and ideas come with on-chain proof.
import { useEffect, useState } from 'react';
import { fetchPortfolio } from '../hl/api';
import { fmtCompact, periodSummary } from '../hl/stats';
import { addAlert, removeAlert, useAlerts } from '../alerts/store';
import type { Scorecard } from './client';

interface Badge {
  pnl30d: number;
  accountValue: number;
}

const cache = new Map<string, { at: number; badge: Badge | null }>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
const TTL = 10 * 60_000;

function runQueue() {
  while (running < 3 && queue.length) {
    const job = queue.shift()!;
    running++;
    void job().finally(() => {
      running--;
      runQueue();
    });
  }
}

const pending = new Map<string, Promise<Badge | null>>();

export function loadBadge(address: string): Promise<Badge | null> {
  const a = address.toLowerCase();
  const c = cache.get(a);
  if (c && Date.now() - c.at < TTL) return Promise.resolve(c.badge);
  if (pending.has(a)) return pending.get(a)!;
  const p = new Promise<Badge | null>((resolve) => {
    queue.push(async () => {
      try {
        const port = await fetchPortfolio(a);
        const s = periodSummary(port, 'month');
        const badge = s ? { pnl30d: s.pnl, accountValue: s.endValue } : null;
        cache.set(a, { at: Date.now(), badge });
        resolve(badge);
      } catch {
        resolve(null);
      } finally {
        pending.delete(a);
      }
    });
    runQueue();
  });
  pending.set(a, p);
  return p;
}

export function PnlBadge({ address }: { address: string }) {
  const [b, setB] = useState<Badge | null>(() => cache.get(address.toLowerCase())?.badge ?? null);
  useEffect(() => {
    let alive = true;
    loadBadge(address).then((x) => alive && setB(x));
    return () => {
      alive = false;
    };
  }, [address]);
  if (!b || (b.pnl30d === 0 && b.accountValue === 0)) return null;
  return (
    <span className={`pnl-badge ${b.pnl30d >= 0 ? 'up' : 'down'}`} title={`Verified on Hyperliquid: 30-day PnL ${fmtCompact(b.pnl30d)}, account value ${fmtCompact(b.accountValue)}`}>
      {b.pnl30d >= 0 ? '+' : ''}
      {fmtCompact(b.pnl30d)} 30d
    </span>
  );
}

/** "Watch" a wallet: get an alert whenever it opens, adds to or closes a position. */
export function WatchButton({ address, label, className = 'link small' }: { address: string; label?: string; className?: string }) {
  const alerts = useAlerts();
  const a = address.toLowerCase();
  const existing = alerts.find((x) => x.kind === 'wallet' && x.address === a);
  const [msg, setMsg] = useState('');
  return (
    <>
      <button
        className={className}
        title={existing ? 'Stop watching this wallet' : 'Alert me when this wallet trades'}
        onClick={() => {
          if (existing) return removeAlert(existing.id);
          const err = addAlert({ kind: 'wallet', address: a, label, repeat: true });
          setMsg(err ?? '');
        }}
      >
        {existing ? '★ Watching' : '☆ Watch'}
      </button>
      {msg && <span className="warn-text small"> {msg}</span>}
    </>
  );
}

/** Idea hit rate, e.g. "62% hit · 13 ideas". */
export function HitRateBadge({ card }: { card?: Scorecard | null }) {
  if (!card || !card.resolved) return null;
  const rate = card.hit_rate ?? card.targets / card.resolved;
  return (
    <span className="pnl-badge" title={`${card.targets} of ${card.resolved} resolved ideas hit their target before the stop (${card.ideas} posted)`}>
      {(rate * 100).toFixed(0)}% hit · {card.resolved}
    </span>
  );
}
