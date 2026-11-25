import { useMemo, useState } from 'react';
import type { Market } from '../hl/api';
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BP, buildOrderAction, builderFeeUsd, type Tif } from '../hl/order';
import { fmtUsd, priceDecimals, roundPrice } from '../hl/stats';
import { useWallet, type OrderWire } from '../wallet/WalletContext';
import { APP_URL, IS_TESTNET } from '../hl/network';

type Kind = 'limit' | 'market';
const MARKET_SLIPPAGE = 0.01; // IOC limit 1% through the mark; Hyperliquid has no true market orders

export function OrderTicket({ market, price, onPrice }: { market: Market; price: number | null; onPrice: (px: number | null) => void }) {
  const wallet = useWallet();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [kind, setKind] = useState<Kind>('limit');
  const [usd, setUsd] = useState('100');
  const [tif, setTif] = useState<Tif>('Gtc');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [showPayload, setShowPayload] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const mark = Number(market.ctx.markPx);
  const isBuy = side === 'buy';
  const rawPx = kind === 'market' ? mark * (isBuy ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE) : price;
  const px = rawPx === null ? null : roundPrice(rawPx, market.szDecimals);
  const pxDec = priceDecimals(px ?? mark, market.szDecimals);
  const sz = px ? Number((Number(usd) / px).toFixed(market.szDecimals)) : 0;
  const notional = px ? sz * px : 0;
  const orderTif: Tif = kind === 'market' ? 'Ioc' : tif;

  const action = useMemo(
    () =>
      px && sz > 0
        ? buildOrderAction({ asset: market.index, isBuy, px, sz, pxDecimals: pxDec, szDecimals: market.szDecimals, reduceOnly, tif: orderTif })
        : null,
    [px, sz, isBuy, orderTif, reduceOnly, market.index, market.szDecimals, pxDec],
  );

  const vsMark = px ? ((px - mark) / mark) * 100 : 0;
  const crosses = kind === 'limit' && px !== null && ((isBuy && px > mark) || (!isBuy && px < mark));
  const tooSmall = notional > 0 && notional < 10;

  const submit = async () => {
    if (!action) return;
    // Mainnet orders need a second click so a stray click on the chart never sends one.
    if (!IS_TESTNET && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setSending(true);
    setResult(null);
    const r = await wallet.placeOrder((action.orders as OrderWire[])[0]);
    setSending(false);
    if (r.kind === 'resting') setResult({ ok: true, text: `Order resting (id ${r.oid}).` });
    else if (r.kind === 'filled') setResult({ ok: true, text: `Filled ${r.totalSz} ${market.symbol} at ${r.avgPx}.` });
    else setResult({ ok: false, text: r.message });
  };

  let button: { label: string; onClick?: () => void; disabled?: boolean } = { label: '' };
  if (!wallet.address) button = { label: 'Connect a wallet to trade', disabled: true };
  else if (!wallet.tradingReady)
    button = {
      label: wallet.enabling ? 'Check your wallet…' : wallet.checking ? 'Checking…' : 'Enable trading',
      onClick: () => void wallet.enableTrading(),
      disabled: wallet.enabling || wallet.checking,
    };
  else if (!action) button = { label: kind === 'limit' ? 'Pick a price' : 'Enter a size', disabled: true };
  else if (tooSmall) button = { label: 'Minimum order is $10', disabled: true };
  else
    button = {
      label: sending
        ? 'Sending…'
        : confirming
          ? `Confirm ${isBuy ? 'buy' : 'sell'} ${sz} ${market.symbol} on mainnet`
          : `${isBuy ? 'Buy' : 'Sell'} ${sz} ${market.symbol}`,
      onClick: () => void submit(),
      disabled: sending,
    };

  return (
    <div className="ticket">
      <div className="ticket-head">
        Order ticket · {market.name}
        {IS_TESTNET && <span className="badge">testnet</span>}
      </div>
      <div className="seg">
        <button className={isBuy ? 'on buy' : ''} onClick={() => (setSide('buy'), setConfirming(false))}>
          Buy / Long
        </button>
        <button className={!isBuy ? 'on sell' : ''} onClick={() => (setSide('sell'), setConfirming(false))}>
          Sell / Short
        </button>
      </div>
      <div className="seg small-seg">
        <button className={kind === 'limit' ? 'on' : ''} onClick={() => (setKind('limit'), setConfirming(false))}>
          Limit
        </button>
        <button className={kind === 'market' ? 'on' : ''} onClick={() => (setKind('market'), setConfirming(false))}>
          Market
        </button>
      </div>
      {kind === 'limit' ? (
        <label>
          Limit price
          <input
            inputMode="decimal"
            placeholder="Click the chart or book"
            value={px === null ? '' : px.toFixed(pxDec)}
            onChange={(e) => (onPrice(e.target.value === '' ? null : Number(e.target.value)), setConfirming(false))}
          />
        </label>
      ) : (
        <div className="hint">Fills now at up to {(MARKET_SLIPPAGE * 100).toFixed(0)}% from the mark ({px?.toFixed(pxDec)} worst price)</div>
      )}
      {kind === 'limit' && px !== null && (
        <div className={`hint ${crosses ? 'warn' : ''}`}>
          {vsMark >= 0 ? '+' : ''}
          {vsMark.toFixed(2)}% vs mark{crosses ? ' · crosses the book, fills as taker' : ''}
        </div>
      )}
      <label>
        Size (USD)
        <input inputMode="decimal" value={usd} onChange={(e) => (setUsd(e.target.value), setConfirming(false))} />
      </label>
      <div className="row">
        {kind === 'limit' && (
          <label>
            Time in force
            <select value={tif} onChange={(e) => setTif(e.target.value as Tif)}>
              <option value="Gtc">GTC</option>
              <option value="Alo">Post only</option>
              <option value="Ioc">IOC</option>
            </select>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} /> Reduce only
        </label>
      </div>
      <dl className="ticket-sum">
        <dt>Size</dt>
        <dd>
          {sz || '–'} {market.symbol}
        </dd>
        <dt>Notional</dt>
        <dd>{fmtUsd(notional, 2)}</dd>
        <dt>Builder fee ({(BUILDER_FEE_TENTHS_BP / 10).toFixed(1)} bp)</dt>
        <dd>{BUILDER_ADDRESS ? fmtUsd(builderFeeUsd(notional), 2) : 'none'}</dd>
      </dl>
      <button className={`submit ${side} ${confirming ? 'confirm' : ''}`} disabled={button.disabled} onClick={button.onClick}>
        {button.label}
      </button>
      {wallet.address && !wallet.tradingReady && !wallet.checking && (
        <div className="hint">
          One-time setup: your wallet signs an approval for a trading key kept in this browser{BUILDER_ADDRESS ? ', plus the HyperSpace builder fee' : ''}. The key can place and
          cancel orders but cannot withdraw funds. Your account needs USDC deposited on{' '}
          <a href={APP_URL} target="_blank" rel="noreferrer">
            Hyperliquid
          </a>
          .
        </div>
      )}
      {wallet.error && <div className="hint warn">{wallet.error}</div>}
      {result && <div className={`hint ${result.ok ? 'ok' : 'warn'}`}>{result.text}</div>}
      <button className="link small" onClick={() => setShowPayload((s) => !s)} disabled={!action}>
        {showPayload ? 'Hide' : 'Show'} order payload
      </button>
      {showPayload && action && <pre className="payload">{JSON.stringify(action, null, 2)}</pre>}
    </div>
  );
}
