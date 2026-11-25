import { useEffect, useRef, useState } from 'react';
import type { Market, Trade } from '../hl/api';
import { hlSocket } from '../hl/ws';
import { fmtCompact, priceDecimals, shortAddr } from '../hl/stats';

const KEEP = 80;

export function TradeTape({ market, bigTradeUsd, onWallet }: { market: Market; bigTradeUsd: number; onWallet: (addr: string) => void }) {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [bigOnly, setBigOnly] = useState(false);
  const buf = useRef<Trade[]>([]);

  useEffect(() => {
    buf.current = [];
    setTrades([]);
    const unsub = hlSocket.subscribe({ type: 'trades', coin: market.name }, (ts: Trade[]) => {
      buf.current = [...ts.slice().reverse(), ...buf.current].slice(0, 400);
    });
    const timer = window.setInterval(() => setTrades(buf.current), 300);
    return () => {
      unsub();
      window.clearInterval(timer);
    };
  }, [market.name]);

  const dec = priceDecimals(Number(market.ctx.markPx), market.szDecimals);
  const shown = (bigOnly ? trades.filter((t) => Number(t.px) * Number(t.sz) >= bigTradeUsd) : trades).slice(0, KEEP);

  return (
    <div className="tape">
      <div className="tape-head">
        <span>Trades</span>
        <label className="check">
          <input type="checkbox" checked={bigOnly} onChange={(e) => setBigOnly(e.target.checked)} /> ≥ {fmtCompact(bigTradeUsd)} only
        </label>
      </div>
      <div className="tape-rows">
        {shown.length === 0 && <div className="panel-empty">Waiting for trades…</div>}
        {shown.map((t) => {
          const ntl = Number(t.px) * Number(t.sz);
          const big = ntl >= bigTradeUsd;
          // users = [buyer, seller]; the aggressor is the buyer on B, seller on A.
          const taker = t.users ? (t.side === 'B' ? t.users[0] : t.users[1]) : null;
          return (
            <div key={`${t.tid}-${t.hash}`} className={`tape-row ${t.side === 'B' ? 'buy' : 'sell'} ${big ? 'big' : ''}`}>
              <span>{Number(t.px).toFixed(dec)}</span>
              <span>{fmtCompact(ntl)}</span>
              <span>{new Date(t.time).toLocaleTimeString([], { hour12: false })}</span>
              {taker ? (
                <button className="link" onClick={() => onWallet(taker)} title="Open this taker's verified PnL">
                  {shortAddr(taker)}
                </button>
              ) : (
                <span />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
