// Top Hyperliquid traders, from Hyperliquid's own on-chain leaderboard data.
import { useEffect, useMemo, useState } from 'react';
import { fetchLeaderboard } from '../social/client';
import { LB_WINDOWS, MIN_ROI_ACCOUNT, type Leaderboard as LB, type LbWindow } from '../../supabase/functions/_shared/leaderboard';
import { fmtCompact, fmtUsd, shortAddr } from '../hl/stats';
import { errorText } from '../wallet/WalletContext';

const WINDOW_LABEL: Record<LbWindow, string> = { day: '24 hours', week: '7 days', month: '30 days', allTime: 'All time' };

export function Leaderboard({ onRoute }: { onRoute: (h: string) => void }) {
  const [data, setData] = useState<(LB & { source: string }) | null>(null);
  const [error, setError] = useState('');
  const [win, setWin] = useState<LbWindow>('week');
  const [by, setBy] = useState<'pnl' | 'roi'>('pnl');
  const [q, setQ] = useState('');

  useEffect(() => {
    fetchLeaderboard()
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    const list = by === 'pnl' ? data.byPnl[win] : data.byRoi[win];
    const term = q.trim().toLowerCase();
    return list.filter((t) => !term || t.address.includes(term) || (t.name ?? '').toLowerCase().includes(term)).slice(0, 100);
  }, [data, win, by, q]);

  return (
    <div className="wallet leaderboard">
      <div className="explainer">
        <h2>Top traders on Hyperliquid</h2>
        <p>
          Ranked from Hyperliquid's own leaderboard data, which comes straight from on-chain accounts. Click a trader to see their verified PnL,
          or put their fills on your chart.
          {by === 'roi' && ` ROI ranking only includes accounts worth at least ${fmtUsd(MIN_ROI_ACCOUNT)}, and leaves out ROI above 1,000%, which in this data comes from deposits into near-empty accounts.`}
        </p>
      </div>
      <div className="lb-tools">
        <div className="seg">
          {LB_WINDOWS.map((w) => (
            <button key={w} className={win === w ? 'on' : ''} onClick={() => setWin(w)}>
              {WINDOW_LABEL[w]}
            </button>
          ))}
        </div>
        <div className="seg">
          <button className={by === 'pnl' ? 'on' : ''} onClick={() => setBy('pnl')}>
            By PnL
          </button>
          <button className={by === 'roi' ? 'on' : ''} onClick={() => setBy('roi')}>
            By ROI
          </button>
        </div>
        <input placeholder="Find a trader or address" value={q} onChange={(e) => setQ(e.target.value)} />
        {data && (
          <span className="muted small">
            {data.traders.toLocaleString()} accounts · updated {new Date(data.fetchedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {!data && !error && <div className="panel-empty">Loading Hyperliquid's leaderboard… (the full file is large; the first load can take a few seconds)</div>}
      {data && (
        <table className="lb-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Trader</th>
              <th>Account value</th>
              <th>PnL ({WINDOW_LABEL[win]})</th>
              <th>ROI</th>
              <th>Volume</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((t, i) => (
              <tr key={t.address}>
                <td className="muted">{i + 1}</td>
                <td>
                  <button className="link" onClick={() => onRoute(`#/wallet/${t.address}`)} title={t.address}>
                    {t.name ?? shortAddr(t.address)}
                  </button>
                </td>
                <td>{fmtCompact(t.accountValue)}</td>
                <td className={t.pnl >= 0 ? 'up' : 'down'}>{fmtUsd(t.pnl)}</td>
                <td className={t.roi >= 0 ? 'up' : 'down'}>
                  {t.roi >= 0 ? '+' : ''}
                  {(t.roi * 100).toFixed(1)}%
                </td>
                <td className="muted" title={t.volume ? undefined : 'No trading volume in this window: the PnL likely comes from vault shares or other non-trading gains.'}>
                  {t.volume ? fmtCompact(t.volume) : '– (no trading)'}
                </td>
                <td>
                  <button className="link small" onClick={() => onRoute(`#/trade/BTC?wallet=${t.address}`)}>
                    Fills on chart
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
