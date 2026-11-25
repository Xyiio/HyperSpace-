import { useEffect, useState } from 'react';
import { INTERVALS, type Interval, type Market } from '../hl/api';
import { hlSocket, type SocketStatus } from '../hl/ws';
import { fmtCompact, priceDecimals } from '../hl/stats';

interface Props {
  markets: Market[];
  market: Market;
  onMarket: (name: string) => void;
  interval: Interval;
  onInterval: (i: Interval) => void;
}

export function MarketBar({ markets, market, onMarket, interval, onInterval }: Props) {
  const [mid, setMid] = useState<number | null>(null);
  const [status, setStatus] = useState<SocketStatus>('closed');

  useEffect(() => hlSocket.onStatus(setStatus), []);
  useEffect(() => {
    setMid(null);
    let last = 0;
    return hlSocket.subscribe({ type: 'allMids' }, (d: { mids: Record<string, string> }) => {
      const now = Date.now();
      if (now - last < 500) return;
      last = now;
      const m = d.mids?.[market.name];
      if (m) setMid(Number(m));
    });
  }, [market.name]);

  const px = mid ?? Number(market.ctx.markPx);
  const prev = Number(market.ctx.prevDayPx);
  const chg = ((px - prev) / prev) * 100;
  const dec = priceDecimals(px, market.szDecimals);
  const funding = Number(market.ctx.funding) * 100;

  return (
    <div className="market-bar">
      <select className="coin-select" value={market.name} onChange={(e) => onMarket(e.target.value)}>
        {markets.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}-PERP
          </option>
        ))}
      </select>
      <div className="stat big">{px.toFixed(dec)}</div>
      <div className={`stat ${chg >= 0 ? 'up' : 'down'}`}>
        <small>24h</small>
        {chg >= 0 ? '+' : ''}
        {chg.toFixed(2)}%
      </div>
      <div className="stat">
        <small>24h volume</small>
        {fmtCompact(Number(market.ctx.dayNtlVlm))}
      </div>
      <div className="stat">
        <small>Open interest</small>
        {fmtCompact(Number(market.ctx.openInterest) * px)}
      </div>
      <div className={`stat ${funding >= 0 ? 'up' : 'down'}`}>
        <small>Funding / 1h</small>
        {funding.toFixed(4)}%
      </div>
      <div className="intervals">
        {INTERVALS.map((i) => (
          <button key={i} className={i === interval ? 'on' : ''} onClick={() => onInterval(i)}>
            {i}
          </button>
        ))}
      </div>
      <span className={`dot ${status}`} title={`Live feed: ${status}`} />
    </div>
  );
}
