import { useMemo, useState } from 'react';
import type { Market } from '../hl/api';
import { fmtUsd } from '../hl/stats';
import { errorText, useWallet } from '../wallet/WalletContext';
import { useRecentFills, type AccountView, type PositionRow } from '../wallet/useAccount';
import { cancelAll, closeAll, closePosition, isTpsl, linePrice, reversePosition, setPositionTpsl, tpslKind } from '../wallet/actions';
import { ShareCard, tradeFromFill, type ShareTrade } from './ShareCard';

interface Props {
  market: Market;
  markets: Market[];
  account: AccountView | null;
  onMarket: (name: string) => void;
}

type Tab = 'positions' | 'orders' | 'twap' | 'trades';

/** Balance, positions, orders, TWAPs and recent trades for the account being traded. */
export function AccountPanel({ market, markets, account, onMarket }: Props) {
  const w = useWallet();
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<Tab>('positions');
  const [tpslFor, setTpslFor] = useState<string | null>(null);
  const [share, setShare] = useState<ShareTrade | null>(null);
  const fills = useRecentFills(tab === 'trades');

  const run = async (f: () => Promise<string>) => {
    setMsg('');
    try {
      setMsg(await f());
    } catch (e) {
      setMsg(errorText(e));
    }
  };

  const closing = useMemo(() => (fills ?? []).filter((f) => Number(f.closedPnl) !== 0).slice(0, 50), [fills]);

  if (!account) {
    if (!w.address && !w.paper) return null;
    return <div className="account muted small pad">Loading account…</div>;
  }
  const venue = market.dex ? market.dexLabel : 'Hyperliquid perps';
  const { positions, orders, twaps } = account;
  const ready = w.tradingReady;
  const find = (c: string) => markets.find((m) => m.name === c);
  const tpslOf = (coin: string) => orders.filter((o) => o.coin === coin && isTpsl(o));
  const acctName = account.source === 'paper' ? 'Paper account' : (w.accounts.find((a) => a.address === account.account)?.name ?? 'Account');

  const sharePosition = (p: PositionRow) => {
    const m = find(p.coin);
    setShare({
      coin: p.coin,
      side: p.szi > 0 ? 'long' : 'short',
      pct: p.returnOnEquity,
      pctLabel: 'ROE',
      pnl: p.unrealizedPnl,
      entry: p.entryPx,
      exit: m ? Number(m.ctx.markPx) : p.entryPx,
      status: 'open',
      time: Date.now(),
      wallet: account.source === 'paper' ? null : account.account,
      paper: account.source === 'paper',
    });
  };

  return (
    <div className="account">
      <div className="account-head">
        <div className="seg small-seg">
          <button className={tab === 'positions' ? 'on' : ''} onClick={() => setTab('positions')}>
            Positions ({positions.length})
          </button>
          <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>
            Open orders ({orders.length})
          </button>
          <button className={tab === 'twap' ? 'on' : ''} onClick={() => setTab('twap')}>
            TWAP ({twaps.length})
          </button>
          <button className={tab === 'trades' ? 'on' : ''} onClick={() => setTab('trades')}>
            Trades
          </button>
        </div>
        <span className="muted small">
          {acctName} · {venue}: value {fmtUsd(account.accountValue, 2)} · withdrawable {fmtUsd(account.withdrawable, 2)}
        </span>
        <span className="account-actions">
          <button className="danger small" disabled={!ready || !positions.length} onClick={() => void run(() => closeAll(w, markets, positions))} title="Market-close every position on this venue">
            Close all
          </button>
          <button className="small" disabled={!ready || !orders.length} onClick={() => void run(() => cancelAll(w, markets, orders))} title="Cancel every open order on this venue">
            Cancel all
          </button>
        </span>
        {msg && <span className="small">{msg}</span>}
      </div>
      {tab === 'positions' &&
        (positions.length === 0 ? (
          <div className="muted small pad">No open positions on {venue}.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Size</th>
                <th>Entry</th>
                <th>Unrealized</th>
                <th>Liq. price</th>
                <th>TP / SL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const ts = tpslOf(p.coin);
                const tpO = ts.find((o) => tpslKind(o) === 'tp');
                const slO = ts.find((o) => tpslKind(o) === 'sl');
                return [
                  <tr key={p.coin}>
                    <td>
                      <button className="link" onClick={() => onMarket(p.coin)}>
                        {p.coin}
                      </button>
                      {p.leverage && <span className="muted small"> {p.leverage}x {p.leverageType}</span>}
                    </td>
                    <td className={p.szi >= 0 ? 'up' : 'down'}>{p.szi}</td>
                    <td>{Number(p.entryPx.toPrecision(6))}</td>
                    <td className={p.unrealizedPnl >= 0 ? 'up' : 'down'}>
                      {fmtUsd(p.unrealizedPnl, 2)} <span className="small">({(p.returnOnEquity * 100).toFixed(1)}%)</span>
                    </td>
                    <td className="warn-text">{p.liquidationPx ? Number(p.liquidationPx.toPrecision(6)) : '–'}</td>
                    <td className="small">
                      <span className="up">{tpO ? linePrice(tpO) : '–'}</span> / <span className="down">{slO ? linePrice(slO) : '–'}</span>
                    </td>
                    <td className="row-actions">
                      <button className="link" disabled={!ready} onClick={() => void run(() => closePosition(w, markets, p))}>
                        Close
                      </button>
                      <button className="link" disabled={!ready} onClick={() => void run(() => reversePosition(w, markets, p))} title="Flip to the same size the other way">
                        Reverse
                      </button>
                      <button className="link" disabled={!ready} onClick={() => setTpslFor(tpslFor === p.coin ? null : p.coin)}>
                        TP/SL
                      </button>
                      <button className="link" onClick={() => sharePosition(p)}>
                        Share
                      </button>
                    </td>
                  </tr>,
                  tpslFor === p.coin && (
                    <tr key={`${p.coin}-tpsl`}>
                      <td colSpan={7}>
                        <TpslForm
                          p={p}
                          onCancel={() => setTpslFor(null)}
                          onSubmit={(tp, sl) => {
                            const m = find(p.coin);
                            if (!m) return;
                            setTpslFor(null);
                            void run(() => setPositionTpsl(w, m, p, tp, sl));
                          }}
                        />
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        ))}
      {tab === 'orders' &&
        (orders.length === 0 ? (
          <div className="muted small pad">No open orders on {venue}.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th>Price</th>
                <th>Size</th>
                <th>Type</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.oid}>
                  <td>{o.coin}</td>
                  <td className={o.side === 'B' ? 'up' : 'down'}>{o.side === 'B' ? 'Buy' : 'Sell'}</td>
                  <td>{linePrice(o)}</td>
                  <td>{o.sz}</td>
                  <td>
                    {o.orderType}
                    {o.reduceOnly ? ' · reduce' : ''}
                    {o.triggerCondition && o.triggerCondition !== 'N/A' ? <span className="muted"> · {o.triggerCondition}</span> : ''}
                  </td>
                  <td>
                    <button
                      className="link"
                      disabled={!ready}
                      onClick={() => {
                        const m = find(o.coin);
                        if (m) void run(async () => (await w.cancelOrder(m.index, o.oid), `Cancelled order ${o.oid}.`));
                      }}
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {tab === 'twap' &&
        (twaps.length === 0 ? (
          <div className="muted small pad">No running TWAP orders. Start one from the ticket's TWAP tab.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Side</th>
                <th>Progress</th>
                <th>Avg price</th>
                <th>Time</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {twaps.map((t) => {
                const done = t.sz ? t.executedSz / t.sz : 0;
                const elapsed = Math.min(1, (Date.now() - t.start) / (t.minutes * 60_000));
                return (
                  <tr key={t.id}>
                    <td>{t.coin}</td>
                    <td className={t.isBuy ? 'up' : 'down'}>{t.isBuy ? 'Buy' : 'Sell'}</td>
                    <td>
                      <div className="progress" title={`${t.executedSz} of ${t.sz}`}>
                        <div style={{ width: `${done * 100}%` }} />
                      </div>
                      <span className="small">
                        {Number(t.executedSz.toPrecision(6))} / {t.sz} ({(done * 100).toFixed(0)}%)
                      </span>
                    </td>
                    <td>{t.executedSz ? Number((t.executedNtl / t.executedSz).toPrecision(6)) : '–'}</td>
                    <td className="small">
                      {Math.round(elapsed * t.minutes)} of {t.minutes} min
                    </td>
                    <td>
                      <button
                        className="link"
                        disabled={!ready}
                        onClick={() => {
                          const m = find(t.coin);
                          if (m) void run(async () => (await w.twapCancel(m.index, t.id), `Stopped TWAP ${t.id}.`));
                        }}
                      >
                        Stop
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
      {tab === 'trades' &&
        (fills === null ? (
          <div className="muted small pad">Loading trades…</div>
        ) : closing.length === 0 ? (
          <div className="muted small pad">No closed trades yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Trade</th>
                <th>Price</th>
                <th>Size</th>
                <th>Realized</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {closing.map((f) => (
                <tr key={`${f.hash}-${f.tid ?? f.oid}-${f.time}`}>
                  <td className="small">{new Date(f.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{f.coin}</td>
                  <td>{f.dir}</td>
                  <td>{f.px}</td>
                  <td>{f.sz}</td>
                  <td className={Number(f.closedPnl) >= 0 ? 'up' : 'down'}>{fmtUsd(Number(f.closedPnl), 2)}</td>
                  <td>
                    <button className="link" onClick={() => setShare(tradeFromFill(f, account.source === 'paper' ? null : account.account, account.source === 'paper'))}>
                      Share
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
      {share && <ShareCard trade={share} onClose={() => setShare(null)} />}
    </div>
  );
}

function TpslForm({ p, onSubmit, onCancel }: { p: PositionRow; onSubmit: (tp: number | null, sl: number | null) => void; onCancel: () => void }) {
  const long = p.szi > 0;
  const [tp, setTp] = useState(String(Number((p.entryPx * (long ? 1.02 : 0.98)).toPrecision(5))));
  const [sl, setSl] = useState(String(Number((p.entryPx * (long ? 0.99 : 1.01)).toPrecision(5))));
  const n = (s: string) => (Number(s) > 0 ? Number(s) : null);
  const bad = (n(tp) && (long ? n(tp)! <= p.entryPx : n(tp)! >= p.entryPx)) || (n(sl) && (long ? n(sl)! >= p.entryPx : n(sl)! <= p.entryPx));
  return (
    <form
      className="tpsl-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!bad) onSubmit(n(tp), n(sl));
      }}
    >
      <label>
        Take-profit <input inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="none" />
      </label>
      <label>
        Stop <input inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="none" />
      </label>
      <button type="submit" disabled={!!bad}>
        Set for whole position
      </button>
      <button type="button" className="link" onClick={onCancel}>
        Cancel
      </button>
      {bad && <span className="warn-text small">{long ? 'For a long, TP above and stop below the entry.' : 'For a short, TP below and stop above the entry.'}</span>}
      <span className="muted small">Drag the lines on the chart to move them later.</span>
    </form>
  );
}
