import { useEffect, useMemo, useState } from 'react';
import type { Market } from '../hl/api';
import { BUILDER_ADDRESS, BUILDER_FEE_TENTHS_BP, builderFeeUsd } from '../hl/order';
import {
  MARKET_SLIPPAGE,
  bracket,
  bracketError,
  floorSize,
  limitWire,
  marketWire,
  riskSize,
  scaleLadder,
  scaleWires,
  type AnyOrderWire,
  type Grouping,
  type ScaleSkew,
  type Tif,
} from '../hl/orders';
import { fmtUsd, priceDecimals, roundPrice } from '../hl/stats';
import { useWallet } from '../wallet/WalletContext';
import { APP_URL, IS_TESTNET } from '../hl/network';
import type { AccountView } from '../wallet/useAccount';

type Kind = 'limit' | 'market' | 'scale' | 'twap';
type SizeMode = 'usd' | 'risk';

/** Levels of the order being set up, previewed as dashed lines on the chart. */
export interface StagedLevels {
  entry: number | null;
  tp: number | null;
  sl: number | null;
  ladder: number[];
  isBuy: boolean;
}

export interface HotkeySettings {
  enabled: boolean;
  usd: number;
}

interface Props {
  market: Market;
  price: number | null;
  onPrice: (px: number | null) => void;
  account: AccountView | null;
  onStaged?: (l: StagedLevels | null) => void;
  hotkeys: HotkeySettings;
  onHotkeys: (h: HotkeySettings) => void;
}

const num = (s: string) => (s.trim() === '' ? null : Number(s) > 0 ? Number(s) : null);

export function OrderTicket({ market, price, onPrice, account, onStaged, hotkeys, onHotkeys }: Props) {
  const wallet = useWallet();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [kind, setKind] = useState<Kind>('limit');
  const [sizeMode, setSizeMode] = useState<SizeMode>('usd');
  const [usd, setUsd] = useState('100');
  const [risk, setRisk] = useState('25');
  const [tif, setTif] = useState<Tif>('Gtc');
  const [reduceOnly, setReduceOnly] = useState(false);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  const [scaleTo, setScaleTo] = useState('');
  const [scaleN, setScaleN] = useState('10');
  const [skew, setSkew] = useState<ScaleSkew>('even');
  const [twapMin, setTwapMin] = useState('30');
  const [twapRandom, setTwapRandom] = useState(true);
  const [showPayload, setShowPayload] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [showKeys, setShowKeys] = useState(false);

  useEffect(() => {
    setTp('');
    setSl('');
    setScaleTo('');
    setResult(null);
  }, [market.name]);

  const mark = Number(market.ctx.markPx);
  const isBuy = side === 'buy';
  const reset = () => setConfirming(false);

  // Entry: the limit price, the market's worst price, or the first rung of a ladder.
  const entryRaw = kind === 'market' || kind === 'twap' ? mark * (kind === 'market' ? (isBuy ? 1 + MARKET_SLIPPAGE : 1 - MARKET_SLIPPAGE) : 1) : price;
  const entry = entryRaw === null ? null : roundPrice(entryRaw, market.szDecimals);
  const pxDec = priceDecimals(entry ?? mark, market.szDecimals);
  const tpPx = kind === 'scale' || kind === 'twap' ? null : num(tp);
  const slPx = kind === 'twap' ? null : num(sl);
  const to = num(scaleTo);
  const ladderPrices = kind === 'scale' && entry && to ? scaleLadder(entry, to, Number(scaleN) || 1, 1, skew) : [];
  const avgEntry = ladderPrices.length ? ladderPrices.reduce((s, l) => s + l.px * l.sz, 0) : kind === 'market' ? mark : entry;

  // Size: dollars, or what you are willing to lose at the stop.
  let coins = 0;
  if (sizeMode === 'risk') coins = avgEntry && slPx ? riskSize(avgEntry, slPx, Number(risk) || 0) : 0;
  else coins = avgEntry ? (Number(usd) || 0) / avgEntry : 0;
  coins = floorSize(coins, market.szDecimals);
  const notional = avgEntry ? coins * avgEntry : 0;
  const lossAtStop = avgEntry && slPx ? Math.abs(avgEntry - slPx) * coins : null;
  const gainAtTp = avgEntry && tpPx ? Math.abs(tpPx - avgEntry) * coins : null;
  const leverageUsed = account && account.accountValue > 0 ? notional / account.accountValue : null;

  const levelError = avgEntry && kind !== 'twap' ? bracketError(isBuy, kind === 'market' ? mark : avgEntry, tpPx, slPx) : null;

  // Build the request.
  const built = useMemo((): { orders: AnyOrderWire[]; grouping: Grouping } | null => {
    if (!entry || coins <= 0) return null;
    if (kind === 'scale') {
      if (!to) return null;
      const ladder = scaleLadder(entry, to, Number(scaleN) || 1, coins, skew);
      const orders = scaleWires(market, isBuy, ladder, tif === 'Ioc' ? 'Gtc' : tif, reduceOnly);
      return orders.length ? { orders, grouping: 'na' } : null;
    }
    if (kind === 'twap') return null;
    const entryWire = kind === 'market' ? marketWire(market, isBuy, mark, coins, reduceOnly) : limitWire(market, isBuy, entry, coins, tif, reduceOnly);
    if (reduceOnly) return { orders: [entryWire], grouping: 'na' };
    return bracket(market, { isBuy, entry: entryWire, size: coins, takeProfit: tpPx, stopLoss: slPx });
  }, [entry, coins, kind, to, scaleN, skew, market, isBuy, tif, reduceOnly, mark, tpPx, slPx]);

  const twapMinutes = Math.round(Number(twapMin));
  const twapOk = kind === 'twap' && coins > 0 && twapMinutes >= 5 && twapMinutes <= 1440;

  // Preview on the chart.
  useEffect(() => {
    if (!onStaged) return;
    if (kind === 'twap' || (!entry && !tpPx && !slPx)) return onStaged(null);
    onStaged({ entry: kind === 'market' ? null : entry, tp: tpPx, sl: slPx, ladder: ladderPrices.map((l) => l.px), isBuy });
  }, [kind, entry, tpPx, slPx, ladderPrices.map((l) => l.px).join(','), isBuy]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onStaged?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps

  const vsMark = entry && kind === 'limit' ? ((entry - mark) / mark) * 100 : 0;
  const crosses = kind === 'limit' && entry !== null && ((isBuy && entry > mark) || (!isBuy && entry < mark));
  const perOrder = kind === 'scale' && built ? notional / built.orders.length : notional;
  const tooSmall = notional > 0 && perOrder < 10;
  const ready = kind === 'twap' ? twapOk : !!built;

  const submit = async () => {
    if (!ready || levelError) return;
    // Mainnet orders need a second click so a stray click on the chart never sends one.
    if (!IS_TESTNET && !wallet.paper && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setSending(true);
    setResult(null);
    if (kind === 'twap') {
      const r = await wallet.twapOrder({ a: market.index, b: isBuy, s: String(coins), r: reduceOnly, m: twapMinutes, t: twapRandom });
      setResult(r.kind === 'running' ? { ok: true, text: `TWAP running (id ${r.twapId}): ${coins} ${market.symbol} over ${twapMinutes} min.` } : { ok: false, text: r.message });
    } else if (built) {
      const rs = await wallet.placeOrders(built.orders, built.grouping);
      const errs = rs.filter((r) => r.kind === 'error') as { message: string }[];
      const first = rs[0];
      if (errs.length === rs.length) setResult({ ok: false, text: errs[0].message });
      else if (kind === 'scale') setResult({ ok: errs.length === 0, text: `Placed ${rs.length - errs.length} of ${rs.length} ladder orders${errs.length ? `: ${errs[0].message}` : '.'}` });
      else {
        const head = first.kind === 'filled' ? `Filled ${first.totalSz} ${market.symbol} at ${first.avgPx}.` : first.kind === 'resting' ? `Order resting${first.oid ? ` (id ${first.oid})` : ''}.` : first.message;
        const extra = rs.length > 1 ? (errs.length ? ` TP/SL problem: ${errs[0].message}` : ' Take-profit / stop attached.') : '';
        setResult({ ok: first.kind !== 'error', text: head + extra });
      }
    }
    setSending(false);
  };

  let button: { label: string; onClick?: () => void; disabled?: boolean } = { label: '' };
  const verb = isBuy ? 'Buy' : 'Sell';
  if (!wallet.paper && !wallet.address) button = { label: 'Connect a wallet, or use paper trading', disabled: true };
  else if (!wallet.tradingReady)
    button = {
      label: wallet.enabling ? 'Check your wallet…' : wallet.checking ? 'Checking…' : 'Enable trading',
      onClick: () => void wallet.enableTrading(),
      disabled: wallet.enabling || wallet.checking,
    };
  else if (kind === 'limit' && !entry) button = { label: 'Pick a price', disabled: true };
  else if (kind === 'scale' && (!entry || !to)) button = { label: 'Set the ladder range', disabled: true };
  else if (sizeMode === 'risk' && !slPx) button = { label: 'Set a stop to size by risk', disabled: true };
  else if (!ready) button = { label: kind === 'twap' ? 'TWAP runs 5 to 1,440 minutes' : 'Enter a size', disabled: true };
  else if (levelError) button = { label: levelError, disabled: true };
  else if (tooSmall) button = { label: kind === 'scale' ? 'Each ladder order must be at least $10' : 'Minimum order is $10', disabled: true };
  else {
    const what = kind === 'scale' ? `${verb} ${coins} ${market.symbol} in ${built!.orders.length} orders` : kind === 'twap' ? `TWAP ${verb.toLowerCase()} ${coins} ${market.symbol}` : `${verb} ${coins} ${market.symbol}`;
    button = { label: sending ? 'Sending…' : confirming ? `Confirm: ${what} on mainnet` : what, onClick: () => void submit(), disabled: sending };
  }

  const pct = (p: number | null) => (p && avgEntry ? `${(((p - avgEntry) / avgEntry) * 100).toFixed(2)}%` : '');

  return (
    <div className="ticket">
      <div className="ticket-head">
        Order ticket · {market.name}
        {wallet.paper ? <span className="badge paper">paper</span> : IS_TESTNET && <span className="badge">testnet</span>}
      </div>
      <div className="seg">
        <button className={isBuy ? 'on buy' : ''} onClick={() => (setSide('buy'), reset())}>
          Buy / Long
        </button>
        <button className={!isBuy ? 'on sell' : ''} onClick={() => (setSide('sell'), reset())}>
          Sell / Short
        </button>
      </div>
      <div className="seg small-seg">
        {(['limit', 'market', 'scale', 'twap'] as Kind[]).map((k) => (
          <button key={k} className={kind === k ? 'on' : ''} onClick={() => (setKind(k), reset())} title={k === 'scale' ? 'Spread the order across a price range' : k === 'twap' ? "Hyperliquid's time-sliced order" : undefined}>
            {k === 'twap' ? 'TWAP' : k[0].toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      {kind === 'limit' || kind === 'scale' ? (
        <label>
          {kind === 'scale' ? 'From price' : 'Limit price'}
          <input
            inputMode="decimal"
            placeholder="Click the chart or book"
            value={entry === null ? '' : entry.toFixed(pxDec)}
            onChange={(e) => (onPrice(e.target.value === '' ? null : Number(e.target.value)), reset())}
          />
        </label>
      ) : kind === 'market' ? (
        <div className="hint">Fills now at up to {(MARKET_SLIPPAGE * 100).toFixed(0)}% from the mark ({entry?.toFixed(pxDec)} worst price)</div>
      ) : (
        <div className="row">
          <label>
            Minutes
            <input inputMode="numeric" value={twapMin} onChange={(e) => (setTwapMin(e.target.value), reset())} />
          </label>
          <label className="check" title="Vary slice timing so the order is harder to spot">
            <input type="checkbox" checked={twapRandom} onChange={(e) => setTwapRandom(e.target.checked)} /> Randomize
          </label>
        </div>
      )}
      {kind === 'scale' && (
        <>
          <label>
            To price
            <input inputMode="decimal" placeholder={isBuy ? 'Lower price' : 'Higher price'} value={scaleTo} onChange={(e) => (setScaleTo(e.target.value), reset())} />
          </label>
          <div className="row">
            <label>
              Orders
              <input inputMode="numeric" value={scaleN} onChange={(e) => (setScaleN(e.target.value), reset())} />
            </label>
            <label>
              Size spread
              <select value={skew} onChange={(e) => setSkew(e.target.value as ScaleSkew)}>
                <option value="even">Even</option>
                <option value="moreFar">More at the far end</option>
                <option value="moreNear">More near the start</option>
              </select>
            </label>
          </div>
        </>
      )}
      {kind === 'limit' && entry !== null && (
        <div className={`hint ${crosses ? 'warn' : ''}`}>
          {vsMark >= 0 ? '+' : ''}
          {vsMark.toFixed(2)}% vs mark{crosses ? ' · crosses the book, fills as taker' : ''}
        </div>
      )}
      <div className="row">
        <div className="seg small-seg">
          <button className={sizeMode === 'usd' ? 'on' : ''} onClick={() => setSizeMode('usd')}>
            Size $
          </button>
          <button className={sizeMode === 'risk' ? 'on' : ''} onClick={() => setSizeMode('risk')} title="Set your stop and the dollars you are willing to lose; HyperSpace works out the size">
            Risk $
          </button>
        </div>
        {sizeMode === 'usd' ? (
          <input aria-label="Size in USD" inputMode="decimal" value={usd} onChange={(e) => (setUsd(e.target.value), reset())} />
        ) : (
          <input aria-label="Dollars at risk" inputMode="decimal" value={risk} onChange={(e) => (setRisk(e.target.value), reset())} />
        )}
      </div>
      {kind !== 'twap' && (
        <div className="row tpsl">
          {kind !== 'scale' && (
            <label>
              Take-profit <span className="muted small">{pct(tpPx)}</span>
              <input inputMode="decimal" placeholder="optional" value={tp} onChange={(e) => (setTp(e.target.value), reset())} />
            </label>
          )}
          <label>
            Stop {sizeMode === 'risk' && <span className="warn-text small">required</span>} <span className="muted small">{pct(slPx)}</span>
            <input inputMode="decimal" placeholder={sizeMode === 'risk' ? 'needed for risk sizing' : 'optional'} value={sl} onChange={(e) => (setSl(e.target.value), reset())} />
          </label>
        </div>
      )}
      {kind === 'scale' && slPx && <div className="hint">The stop sizes the ladder by risk; place the stop itself from the position once filled.</div>}
      <div className="row">
        {(kind === 'limit' || kind === 'scale') && (
          <label>
            Time in force
            <select value={tif} onChange={(e) => setTif(e.target.value as Tif)}>
              <option value="Gtc">GTC</option>
              <option value="Alo">Post only</option>
              {kind === 'limit' && <option value="Ioc">IOC</option>}
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
          {coins || '–'} {market.symbol}
        </dd>
        <dt>Notional</dt>
        <dd>{fmtUsd(notional, 2)}</dd>
        {lossAtStop !== null && (
          <>
            <dt>Loss at stop</dt>
            <dd className="down">{fmtUsd(-lossAtStop, 2)}</dd>
          </>
        )}
        {gainAtTp !== null && (
          <>
            <dt>Gain at target</dt>
            <dd className="up">
              {fmtUsd(gainAtTp, 2)}
              {lossAtStop ? ` · ${(gainAtTp / lossAtStop).toFixed(1)}R` : ''}
            </dd>
          </>
        )}
        {leverageUsed !== null && notional > 0 && (
          <>
            <dt>Of account value</dt>
            <dd className={leverageUsed > 5 ? 'warn-text' : ''}>{leverageUsed.toFixed(2)}x</dd>
          </>
        )}
        <dt>Builder fee ({(BUILDER_FEE_TENTHS_BP / 10).toFixed(1)} bp)</dt>
        <dd>{BUILDER_ADDRESS && !wallet.paper ? fmtUsd(builderFeeUsd(notional), 2) : 'none'}</dd>
      </dl>
      <button className={`submit ${side} ${confirming ? 'confirm' : ''}`} disabled={button.disabled} onClick={button.onClick}>
        {button.label}
      </button>
      {!wallet.paper && wallet.address && !wallet.tradingReady && !wallet.checking && (
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
      <div className="ticket-foot">
        <label className="check" title="Practice on live prices with $10,000 of pretend USDC">
          <input type="checkbox" checked={wallet.paper} onChange={(e) => wallet.setPaper(e.target.checked)} /> Paper trading
        </label>
        {wallet.paper && (
          <button className="link small" onClick={() => wallet.resetPaper()} title="Start again with $10,000">
            Reset
          </button>
        )}
        <button className="link small" onClick={() => setShowKeys((s) => !s)}>
          Hotkeys {hotkeys.enabled ? 'on' : 'off'}
        </button>
        <button className="link small" onClick={() => setShowPayload((s) => !s)} disabled={!built}>
          {showPayload ? 'Hide' : 'Show'} payload
        </button>
      </div>
      {showKeys && (
        <div className="hotkeys">
          <label className="check">
            <input type="checkbox" checked={hotkeys.enabled} onChange={(e) => onHotkeys({ ...hotkeys, enabled: e.target.checked })} /> Trade from the keyboard
          </label>
          <label>
            Hotkey size $
            <input inputMode="decimal" value={hotkeys.usd} onChange={(e) => onHotkeys({ ...hotkeys, usd: Number(e.target.value) || 0 })} />
          </label>
          <table className="keys">
            <tbody>
              <tr><td><kbd>Shift</kbd>+<kbd>B</kbd></td><td>Market buy the hotkey size</td></tr>
              <tr><td><kbd>Shift</kbd>+<kbd>S</kbd></td><td>Market sell the hotkey size</td></tr>
              <tr><td><kbd>Shift</kbd>+<kbd>C</kbd></td><td>Close this market's position</td></tr>
              <tr><td><kbd>Shift</kbd>+<kbd>R</kbd></td><td>Reverse (flip) the position</td></tr>
              <tr><td><kbd>Shift</kbd>+<kbd>X</kbd></td><td>Cancel all orders on this market</td></tr>
            </tbody>
          </table>
          <div className="hint warn">Hotkeys send at once, with no confirm click{wallet.paper ? '' : ', on real money'}.</div>
        </div>
      )}
      {showPayload && built && <pre className="payload">{JSON.stringify({ type: 'order', orders: built.orders, grouping: built.grouping }, null, 2)}</pre>}
    </div>
  );
}
