import { useEffect, useMemo, useState } from 'react';
import { INTERVALS, type Interval, type Market, type Trade } from '../hl/api';
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
  const [last, setLast] = useState<number | null>(null);
  const [status, setStatus] = useState<SocketStatus>('closed');
  const [query, setQuery] = useState('');

  useEffect(() => hlSocket.onStatus(setStatus), []);
  // Last trade price works the same on the main dex and on HIP-3 dexes.
  useEffect(() => {
    setLast(null);
    return hlSocket.subscribe({ type: 'trades', coin: market.name }, (ts: Trade[]) => {
      const t = ts[ts.length - 1];
      if (t) setLast(Number(t.px));
    });
  }, [market.name]);

  // Group markets by dex: crypto perps first, then each HIP-3 dex (stocks, indices, commodities, FX).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, Market[]>();
    for (const m of markets) {
      if (q && !m.name.toLowerCase().includes(q) && !m.dexLabel.toLowerCase().includes(q)) continue;
      const label = m.dex ? `${m.dexLabel} (HIP-3: stocks, commodities, FX)` : 'Hyperliquid crypto perps';
      map.set(label, [...(map.get(label) ?? []), m]);
    }
    return [...map.entries()];
  }, [markets, query]);

  const px = last ?? Number(market.ctx.markPx);
  const prev = Number(market.ctx.prevDayPx);
  const chg = ((px - prev) / prev) * 100;
  const dec = priceDecimals(px, market.szDecimals);
  const funding = Number(market.ctx.funding) * 100;

  return (
    <div className="market-bar">
      <div className="picker">
        <input className="coin-search" placeholder="Search TSLA, GOLD, BTC…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select className="coin-select" value={market.name} onChange={(e) => onMarket(e.target.value)}>
          {!groups.some(([, ms]) => ms.includes(market)) && <option value={market.name}>{market.name}</option>}
          {groups.map(([label, ms]) => (
            <optgroup key={label} label={label}>
              {ms.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {market.dex && <span className="badge" title="HIP-3 builder-deployed market">{market.dexLabel}</span>}
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
