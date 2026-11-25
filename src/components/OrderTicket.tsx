import { useMemo, useState } from 'react';
import type { Market } from '../hl/api';
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BP, buildOrderAction, builderFeeUsd, type Tif } from '../hl/order';
import { fmtUsd, priceDecimals, roundPrice } from '../hl/stats';

export function OrderTicket({ market, price, onPrice }: { market: Market; price: number | null; onPrice: (px: number | null) => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [usd, setUsd] = useState('1000');
  const [tif, setTif] = useState<Tif>('Gtc');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [showPayload, setShowPayload] = useState(false);

  const mark = Number(market.ctx.markPx);
  const px = price === null ? null : roundPrice(price, market.szDecimals);
  const pxDec = priceDecimals(px ?? mark, market.szDecimals);
  const sz = px ? Number((Number(usd) / px).toFixed(market.szDecimals)) : 0;
  const notional = px ? sz * px : 0;

  const action = useMemo(
    () =>
      px && sz > 0
        ? buildOrderAction({ asset: market.index, isBuy: side === 'buy', px, sz, pxDecimals: pxDec, szDecimals: market.szDecimals, reduceOnly, tif })
        : null,
    [px, sz, side, tif, reduceOnly, market.index, market.szDecimals, pxDec],
  );

  const vsMark = px ? ((px - mark) / mark) * 100 : 0;
  const crosses = px !== null && ((side === 'buy' && px > mark) || (side === 'sell' && px < mark));

  return (
    <div className="ticket">
      <div className="ticket-head">Order ticket · {market.name}-PERP</div>
      <div className="seg">
        <button className={side === 'buy' ? 'on buy' : ''} onClick={() => setSide('buy')}>Buy / Long</button>
        <button className={side === 'sell' ? 'on sell' : ''} onClick={() => setSide('sell')}>Sell / Short</button>
      </div>
      <label>
        Limit price
        <input
          inputMode="decimal"
          placeholder="Click the chart or book"
          value={px === null ? '' : px.toFixed(pxDec)}
          onChange={(e) => onPrice(e.target.value === '' ? null : Number(e.target.value))}
        />
      </label>
      {px !== null && (
        <div className={`hint ${crosses ? 'warn' : ''}`}>
          {vsMark >= 0 ? '+' : ''}
          {vsMark.toFixed(2)}% vs mark{crosses ? ' · crosses the book, fills as taker' : ''}
        </div>
      )}
      <label>
        Size (USD)
        <input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} />
      </label>
      <div className="row">
        <label>
          Time in force
          <select value={tif} onChange={(e) => setTif(e.target.value as Tif)}>
            <option value="Gtc">GTC</option>
            <option value="Alo">Post only</option>
            <option value="Ioc">IOC</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> Reduce only
        </label>
      </div>
      <dl className="ticket-sum">
        <dt>Size</dt>
        <dd>
          {sz || '–'} {market.name}
        </dd>
        <dt>Notional</dt>
        <dd>{fmtUsd(notional, 2)}</dd>
        <dt>Builder fee ({(BUILDER_FEE_TENTHS_BP / 10).toFixed(1)} bp)</dt>
        <dd>{BUILDER_ADDRESS ? fmtUsd(builderFeeUsd(notional), 2) : 'not configured'}</dd>
      </dl>
      <button className={`submit ${side}`} disabled title="Wallet signing ships in phase 1">
        Connect wallet to trade (phase 1)
      </button>
      <button className="link small" onClick={() => setShowPayload((s) => !s)} disabled={!action}>
        {showPayload ? 'Hide' : 'Show'} signed action payload
      </button>
      {showPayload && action && <pre className="payload">{JSON.stringify(action, null, 2)}</pre>}
    </div>
  );
}
