import { useEffect, useState } from 'react';
import type { L2Book, Market } from '../hl/api';
import { hlSocket } from '../hl/ws';
import { priceDecimals } from '../hl/stats';

const ROWS = 14;

export function BookLadder({ market, nSigFigs, onPricePick }: { market: Market; nSigFigs: number | null; onPricePick: (px: number) => void }) {
  const [book, setBook] = useState<L2Book | null>(null);

  useEffect(() => {
    setBook(null);
    let last = 0;
    return hlSocket.subscribe({ type: 'l2Book', coin: market.name, nSigFigs }, (b: L2Book) => {
      const now = Date.now();
      if (now - last < 250) return;
      last = now;
      setBook(b);
    });
  }, [market.name, nSigFigs]);

  if (!book) return <div className="panel-empty">Waiting for order book…</div>;
  const dec = priceDecimals(Number(book.levels[0][0]?.px ?? market.ctx.markPx), market.szDecimals);
  const bids = book.levels[0].slice(0, ROWS);
  const asks = book.levels[1].slice(0, ROWS).reverse();
  const max = Math.max(...[...bids, ...asks].map((l) => Number(l.sz)), 1e-9);
  const bestBid = Number(bids[0]?.px ?? 0);
  const bestAsk = Number(asks[asks.length - 1]?.px ?? 0);
  const spread = bestAsk - bestBid;

  const row = (l: { px: string; sz: string; n: number }, side: 'bid' | 'ask') => (
    <button key={side + l.px} className={`ladder-row ${side}`} onClick={() => onPricePick(Number(l.px))} title="Stage an order at this price">
      <span className="bar" style={{ width: `${(Number(l.sz) / max) * 100}%` }} />
      <span className="px">{Number(l.px).toFixed(dec)}</span>
      <span className="sz">{Number(l.sz).toLocaleString('en-US', { maximumFractionDigits: market.szDecimals })}</span>
      <span className="n">{l.n}</span>
    </button>
  );

  return (
    <div className="ladder">
      <div className="ladder-head">
        <span>Price</span>
        <span>Size ({market.name})</span>
        <span>Orders</span>
      </div>
      {asks.map((l) => row(l, 'ask'))}
      <div className="ladder-spread">
        Spread {spread.toFixed(dec)} ({((spread / bestBid) * 10_000).toFixed(1)} bp)
      </div>
      {bids.map((l) => row(l, 'bid'))}
    </div>
  );
}
