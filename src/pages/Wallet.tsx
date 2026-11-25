import { useEffect, useMemo, useState } from 'react';
import {
  fetchClearinghouse,
  fetchFills,
  fetchPortfolio,
  isAddress,
  type ClearinghouseState,
  type Fill,
  type Portfolio,
  type PortfolioPeriod,
} from '../hl/api';
import { fillStats, fmtUsd, periodSummary, shortAddr } from '../hl/stats';
import { PnlChart } from '../components/PnlChart';

const PERIODS: { key: PortfolioPeriod; label: string }[] = [
  { key: 'day', label: '24h' },
  { key: 'week', label: '7d' },
  { key: 'month', label: '30d' },
  { key: 'allTime', label: 'All time' },
];

const signed = (n: number) => <span className={n >= 0 ? 'up' : 'down'}>{fmtUsd(n)}</span>;

interface Data {
  portfolio: Portfolio;
  fills: Fill[];
  state: ClearinghouseState;
  fetchedAt: number;
}

export function Wallet({ address, onRoute }: { address: string | null; onRoute: (hash: string) => void }) {
  const [input, setInput] = useState(address ?? '');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<PortfolioPeriod>('allTime');

  useEffect(() => {
    setInput(address ?? '');
    setData(null);
    setError('');
    if (!address) return;
    const ac = new AbortController();
    Promise.all([fetchPortfolio(address, ac.signal), fetchFills(address, ac.signal), fetchClearinghouse(address, ac.signal)])
      .then(([portfolio, fills, state]) => setData({ portfolio, fills, state, fetchedAt: Date.now() }))
      .catch((e) => !ac.signal.aborted && setError(e.message));
    return () => ac.abort();
  }, [address]);

  const summary = useMemo(() => (data ? periodSummary(data.portfolio, period) : null), [data, period]);
  const stats = useMemo(() => (data ? fillStats(data.fills) : null), [data]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const a = input.trim().toLowerCase();
    if (isAddress(a)) onRoute(`#/wallet/${a}`);
    else setError('Enter a 42-character 0x address.');
  };

  return (
    <div className="wallet">
      <form className="wallet-form" onSubmit={submit}>
        <input placeholder="Any Hyperliquid address: 0x…" value={input} onChange={(e) => setInput(e.target.value)} />
        <button type="submit">Verify PnL</button>
      </form>
      {error && <div className="error">{error}</div>}
      {!address && (
        <div className="explainer">
          <h2>Verified PnL, straight from the chain</h2>
          <p>
            Every number on this page is read live from Hyperliquid's public API for the address you enter. Nothing is self-reported, so a
            chartist's track record can be checked by anyone. Click any wallet in the trade tape to land here.
          </p>
        </div>
      )}
      {address && !data && !error && <div className="panel-empty">Reading {shortAddr(address)} from Hyperliquid…</div>}
      {address && data && summary && stats && (
        <>
          <div className="wallet-head">
            <div>
              <div className="addr">{address}</div>
              <div className="verified">
                ✓ Verified on-chain · read from Hyperliquid at {new Date(data.fetchedAt).toLocaleString()} ·{' '}
                <a href={`https://app.hyperliquid.xyz/explorer/address/${address}`} target="_blank" rel="noreferrer">
                  explorer
                </a>
              </div>
            </div>
            <div className="seg">
              {PERIODS.map((p) => (
                <button key={p.key} className={p.key === period ? 'on' : ''} onClick={() => setPeriod(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="cards">
            <div className="card">
              <small>PnL ({PERIODS.find((p) => p.key === period)!.label})</small>
              <b>{signed(summary.pnl)}</b>
            </div>
            <div className="card">
              <small>Account value now</small>
              <b>{fmtUsd(Number(data.state.marginSummary.accountValue))}</b>
            </div>
            <div className="card">
              <small>Max drawdown</small>
              <b>{(summary.maxDrawdown * 100).toFixed(1)}%</b>
            </div>
            <div className="card">
              <small>Volume</small>
              <b>{fmtUsd(summary.volume)}</b>
            </div>
            <div className="card">
              <small>Win rate (last {stats.fills} fills)</small>
              <b>{stats.winRate === null ? '–' : `${(stats.winRate * 100).toFixed(0)}% of ${stats.closing}`}</b>
            </div>
            <div className="card">
              <small>Liquidations (same fills)</small>
              <b className={stats.liquidations ? 'down' : ''}>{stats.liquidations}</b>
            </div>
          </div>

          {summary.series.length > 1 ? <PnlChart series={summary.series} /> : <div className="panel-empty">No history for this period.</div>}

          <h3>Open positions</h3>
          {data.state.assetPositions.length === 0 ? (
            <div className="muted">No open perp positions.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Coin</th>
                  <th>Size</th>
                  <th>Entry</th>
                  <th>Value</th>
                  <th>Unrealized</th>
                  <th>Liq. price</th>
                  <th>Leverage</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.state.assetPositions.map(({ position: p }) => (
                  <tr key={p.coin}>
                    <td>{p.coin}</td>
                    <td className={Number(p.szi) >= 0 ? 'up' : 'down'}>{p.szi}</td>
                    <td>{p.entryPx ?? '–'}</td>
                    <td>{fmtUsd(Number(p.positionValue))}</td>
                    <td>{signed(Number(p.unrealizedPnl))}</td>
                    <td>{p.liquidationPx ?? '–'}</td>
                    <td>
                      {p.leverage.value}x {p.leverage.type}
                    </td>
                    <td>
                      <button className="link" onClick={() => onRoute(`#/trade/${p.coin}?wallet=${address}`)}>
                        Chart
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>
            Realized PnL by coin <span className="muted">(last {stats.fills} fills, net of fees {signed(stats.net)})</span>
          </h3>
          <table>
            <thead>
              <tr>
                <th>Coin</th>
                <th>Closed trades</th>
                <th>Win rate</th>
                <th>Realized</th>
                <th>Fees</th>
                <th>Volume</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {stats.byCoin.slice(0, 25).map((c) => (
                <tr key={c.coin}>
                  <td>{c.coin}</td>
                  <td>{c.trades}</td>
                  <td>{c.trades ? `${((c.wins / c.trades) * 100).toFixed(0)}%` : '–'}</td>
                  <td>{signed(c.realized)}</td>
                  <td>{fmtUsd(c.fees, 2)}</td>
                  <td>{fmtUsd(c.volume)}</td>
                  <td>
                    <button className="link" onClick={() => onRoute(`#/trade/${c.coin}?wallet=${address}`)}>
                      Fills on chart
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">
            Period PnL and account value come from Hyperliquid's portfolio history. Win rate and per-coin numbers use the most recent{' '}
            {stats.fills} fills the API returns (up to 2,000), counting each fill with closed PnL as one closed trade.
          </p>
        </>
      )}
    </div>
  );
}
