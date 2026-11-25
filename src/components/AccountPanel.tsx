import { useEffect, useState } from 'react';
import { fetchClearinghouse, fetchOpenOrders, type ClearinghouseState, type Market, type OpenOrder } from '../hl/api';
import { fmtUsd, priceDecimals, roundPrice } from '../hl/stats';
import { floatToWire } from '../hl/order';
import { errorText, useWallet } from '../wallet/WalletContext';

interface Props {
  market: Market;
  markets: Market[];
  onOpenOrders: (orders: OpenOrder[]) => void;
  onMarket: (name: string) => void;
}

/** Balance, positions and open orders for the connected wallet on the current market's dex. */
export function AccountPanel({ market, markets, onOpenOrders, onMarket }: Props) {
  const w = useWallet();
  const [state, setState] = useState<ClearinghouseState | null>(null);
  const [orders, setOrders] = useState<OpenOrder[]>([]);
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState<'positions' | 'orders'>('positions');

  useEffect(() => {
    setState(null);
    setOrders([]);
    onOpenOrders([]);
    if (!w.address) return;
    const user = w.address;
    let alive = true;
    const load = async () => {
      try {
        const [s, o] = await Promise.all([fetchClearinghouse(user, undefined, market.dex), fetchOpenOrders(user, market.dex)]);
        if (!alive) return;
        setState(s);
        setOrders(o);
        onOpenOrders(o);
      } catch {
        /* keep the last good view; next poll retries */
      }
    };
    void load();
    const t = window.setInterval(load, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [w.address, market.dex, w.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!w.address) return null;
  const find = (coin: string) => markets.find((m) => m.name === coin);

  const cancel = async (o: OpenOrder) => {
    const m = find(o.coin);
    if (!m) return;
    setMsg('');
    try {
      await w.cancelOrder(m.index, o.oid);
      setMsg(`Cancelled order ${o.oid}.`);
    } catch (e) {
      setMsg(errorText(e));
    }
  };

  const close = async (coin: string, szi: number) => {
    const m = find(coin);
    if (!m) return;
    const isBuy = szi < 0;
    const mark = Number(m.ctx.markPx);
    const px = roundPrice(mark * (isBuy ? 1.01 : 0.99), m.szDecimals);
    setMsg('');
    const r = await w.placeOrder({
      a: m.index,
      b: isBuy,
      p: floatToWire(px, priceDecimals(px, m.szDecimals)),
      s: floatToWire(Math.abs(szi), m.szDecimals),
      r: true,
      t: { limit: { tif: 'Ioc' } },
    });
    setMsg(r.kind === 'error' ? r.message : r.kind === 'filled' ? `Closed ${r.totalSz} ${coin} at ${r.avgPx}.` : `Close order resting (id ${r.oid}).`);
  };

  const positions = state?.assetPositions ?? [];
  const venue = market.dex ? market.dexLabel : 'Hyperliquid perps';

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
        </div>
        {state && (
          <span className="muted small">
            {venue}: account value {fmtUsd(Number(state.marginSummary.accountValue), 2)} · withdrawable {fmtUsd(Number(state.withdrawable), 2)}
          </span>
        )}
        {msg && <span className="small">{msg}</span>}
      </div>
      {tab === 'positions' ? (
        positions.length === 0 ? (
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
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map(({ position: p }) => (
                <tr key={p.coin}>
                  <td>
                    <button className="link" onClick={() => onMarket(p.coin)}>
                      {p.coin}
                    </button>
                  </td>
                  <td className={Number(p.szi) >= 0 ? 'up' : 'down'}>{p.szi}</td>
                  <td>{p.entryPx ?? '–'}</td>
                  <td className={Number(p.unrealizedPnl) >= 0 ? 'up' : 'down'}>{fmtUsd(Number(p.unrealizedPnl), 2)}</td>
                  <td>{p.liquidationPx ?? '–'}</td>
                  <td>
                    <button className="link" disabled={!w.tradingReady} onClick={() => void close(p.coin, Number(p.szi))}>
                      Close at market
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : orders.length === 0 ? (
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
                <td>{o.limitPx}</td>
                <td>{o.sz}</td>
                <td>
                  {o.orderType}
                  {o.reduceOnly ? ' · reduce' : ''}
                </td>
                <td>
                  <button className="link" disabled={!w.tradingReady} onClick={() => void cancel(o)}>
                    Cancel
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
