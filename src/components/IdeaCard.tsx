import { useEffect, useState } from 'react';
import { fetchFillsSince, info, type Market, type RawCandle } from '../hl/api';
import { fmtCompact, fmtUsd, shortAddr } from '../hl/stats';
import type { Idea, Profile } from '../social/client';

interface Outcome {
  movePct: number; // price move since posting, in the idea's direction
  hit: 'target' | 'stop' | null;
  fills: number;
  realized: number;
}

/** Checks what happened after the idea was posted: price path vs target/stop, and the author's own trades. */
async function evaluate(idea: Idea, last: number): Promise<Outcome> {
  const t0 = Date.parse(idea.created_at);
  const [candles, fills] = await Promise.all([
    info<RawCandle[]>({ type: 'candleSnapshot', req: { coin: idea.coin, interval: '15m', startTime: t0, endTime: Date.now() } }),
    fetchFillsSince(idea.author, t0),
  ]);
  let hit: Outcome['hit'] = null;
  const long = idea.direction === 'long';
  for (const c of candles) {
    const hi = Number(c.h);
    const lo = Number(c.l);
    const stopHit = idea.stop !== null && (long ? lo <= idea.stop : hi >= idea.stop);
    const targetHit = idea.target !== null && (long ? hi >= idea.target : lo <= idea.target);
    // If both land in one 15m bar we cannot tell which came first; count it as the stop.
    if (stopHit) {
      hit = 'stop';
      break;
    }
    if (targetHit) {
      hit = 'target';
      break;
    }
  }
  const mine = fills.filter((f) => f.coin === idea.coin);
  const move = ((last - idea.mark_at_post) / idea.mark_at_post) * 100 * (long ? 1 : -1);
  return { movePct: move, hit, fills: mine.length, realized: mine.reduce((s, f) => s + Number(f.closedPnl) - Number(f.fee), 0) };
}

export function IdeaCard({ idea, profile, market, onRoute }: { idea: Idea; profile?: Profile; market?: Market; onRoute: (h: string) => void }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const last = market ? Number(market.ctx.markPx) : idea.mark_at_post;

  useEffect(() => {
    let alive = true;
    evaluate(idea, last)
      .then((o) => alive && setOutcome(o))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [idea.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pos = idea.snapshot.position;
  const szi = pos ? Number(pos.szi) : 0;
  const aligned = szi !== 0 && (szi > 0) === (idea.direction === 'long');
  const name = profile?.display_name ?? shortAddr(idea.author);

  return (
    <div className="idea">
      <div className="idea-head">
        <button className="link" onClick={() => onRoute(`#/wallet/${idea.author}`)}>
          {name}
        </button>
        <span className="muted small">{new Date(idea.created_at).toLocaleString()}</span>
        <span className="verified small" title={idea.author}>
          ✓ signed by {shortAddr(idea.author)}
        </span>
      </div>
      <div className="idea-title">
        <span className={idea.direction === 'long' ? 'up' : 'down'}>{idea.direction.toUpperCase()}</span>{' '}
        <button className="link" onClick={() => onRoute(`#/trade/${idea.coin}?wallet=${idea.author}`)}>
          {idea.coin}
        </button>
        {idea.timeframe && <span className="muted"> · {idea.timeframe}</span>}
        <span className="muted small">
          {' '}
          · posted at {idea.mark_at_post}
          {idea.entry ? ` · entry ${idea.entry}` : ''}
          {idea.target ? ` · target ${idea.target}` : ''}
          {idea.stop ? ` · stop ${idea.stop}` : ''}
        </span>
      </div>
      <p className="idea-body">{idea.body}</p>
      <div className="idea-proof">
        <span className={szi === 0 ? 'muted' : aligned ? 'up' : 'warn-text'}>
          {szi === 0
            ? 'No position in this market when posted'
            : `${aligned ? '✓ ' : '⚠ '}Was ${szi > 0 ? 'long' : 'short'} ${Math.abs(szi)} (${fmtCompact(Number(pos!.positionValue))}) when posted`}
        </span>
        {idea.snapshot.allTimePnl !== null && <span className="muted">All-time PnL then {fmtUsd(Number(idea.snapshot.allTimePnl))}</span>}
        {outcome ? (
          <>
            <span className={outcome.movePct >= 0 ? 'up' : 'down'}>
              {outcome.movePct >= 0 ? '+' : ''}
              {outcome.movePct.toFixed(2)}% in the idea's direction
            </span>
            {outcome.hit && <span className={outcome.hit === 'target' ? 'up' : 'down'}>{outcome.hit === 'target' ? 'Target hit' : 'Stop hit'}</span>}
            <span className="muted">
              Author traded it since: {outcome.fills ? `${outcome.fills} fills, ${fmtUsd(outcome.realized, 2)} realized` : 'no fills'}
            </span>
          </>
        ) : (
          <span className="muted">Checking outcome…</span>
        )}
      </div>
    </div>
  );
}
