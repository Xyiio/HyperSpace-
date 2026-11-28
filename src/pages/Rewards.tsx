// Points, referrals and premium. Points track real use of HyperSpace ahead of the token;
// referrals share the builder fee with whoever brought a trader; premium is priced in the
// token and stays switched off until launch.
import { useEffect, useState } from 'react';
import { myPoints, myReferrer, pointsBoard, referralStats, setReferrer, socialEnabled, type PointsRow, type ReferralStats } from '../social/client';
import { fmtUsd, shortAddr } from '../hl/stats';
import { errorText, useWallet } from '../wallet/WalletContext';
import { BUILDER_ADDRESS } from '../hl/order';
import { PREMIUM_PLAN, TOKEN_LIVE, TOKEN_SYMBOL, FREE, PREMIUM } from '../token/premium';

export type RewardsTab = 'points' | 'referrals' | 'premium';

export const POINT_RULES: [string, string][] = [
  ['Trade idea posted', '5'],
  ['Idea that hit its target', '20'],
  ['Indicator published', '25'],
  ['Install of your indicator', '1'],
  ['Rating given', '1'],
  ['Trader you referred', '10'],
  ['Every $10,000 traded through HyperSpace', '1'],
];

const REF_KEY = 'hs.ref';
export const REFERRAL_SHARE_PCT = Number(import.meta.env.VITE_REFERRAL_SHARE_PCT ?? 20);

/** Remembers a ?ref=0x… referrer from the first visit (first link wins). */
export function captureReferral() {
  const q = new URLSearchParams(location.search);
  const hq = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const ref = (hq.get('ref') ?? q.get('ref') ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ref)) return;
  try {
    if (!localStorage.getItem(REF_KEY)) localStorage.setItem(REF_KEY, ref);
  } catch {
    /* ignore */
  }
}
const pendingReferrer = () => {
  try {
    return localStorage.getItem(REF_KEY);
  } catch {
    return null;
  }
};

export function Rewards({ tab, onRoute }: { tab: RewardsTab; onRoute: (h: string) => void }) {
  return (
    <div className="wallet rewards">
      <div className="community-tabs">
        {(['points', 'referrals', 'premium'] as RewardsTab[]).map((t) => (
          <a key={t} className={tab === t ? 'on' : ''} href={`#/rewards/${t}`}>
            {t[0].toUpperCase() + t.slice(1)}
          </a>
        ))}
      </div>
      {tab === 'points' && <Points onRoute={onRoute} />}
      {tab === 'referrals' && <Referrals onRoute={onRoute} />}
      {tab === 'premium' && <Premium />}
    </div>
  );
}

function Points({ onRoute }: { onRoute: (h: string) => void }) {
  const w = useWallet();
  const [board, setBoard] = useState<PointsRow[] | null>(null);
  const [mine, setMine] = useState<PointsRow | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!socialEnabled) return;
    pointsBoard().then(setBoard).catch((e) => setErr(errorText(e)));
  }, []);
  useEffect(() => {
    if (socialEnabled && w.address) myPoints(w.address).then(setMine).catch(() => {});
  }, [w.address]);

  return (
    <>
      <div className="explainer">
        <h2>Points</h2>
        <p>
          Points record real use of HyperSpace: trading through it, sharing ideas that work, and building indicators people install. They are a public
          activity score. <strong>Points are not tokens, have no cash value, and are not a promise of an airdrop or any future reward.</strong>
        </p>
      </div>
      <div className="oi-grid">
        <section className="card-block">
          <h3>How points are earned</h3>
          <table className="lb-table">
            <tbody>
              {POINT_RULES.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">Trading points count fills that paid the HyperSpace builder fee, read from Hyperliquid. Paper trades earn nothing.</p>
        </section>
        <section className="card-block">
          <h3>Your points</h3>
          {!socialEnabled ? (
            <div className="muted small">Points need the HyperSpace backend (see README).</div>
          ) : !w.address ? (
            <div className="muted small">Connect a wallet to see your points.</div>
          ) : !mine ? (
            <div className="muted small">No points yet. Post an idea, publish an indicator, or trade from the chart.</div>
          ) : (
            <>
              <div className="big-num">{mine.total.toLocaleString()}</div>
              <div className="small muted">
                ideas {mine.ideas} · targets hit {mine.targets} · indicators {mine.scripts} · installs {mine.installs} · ratings {mine.ratings_given} · referrals {mine.referrals} · trading{' '}
                {mine.trading}
              </div>
            </>
          )}
        </section>
      </div>
      {err && <div className="error">{err}</div>}
      {board && (
        <table className="lb-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Wallet</th>
              <th>Points</th>
              <th>Trading</th>
              <th>Ideas</th>
              <th>Indicators</th>
            </tr>
          </thead>
          <tbody>
            {board.map((r, i) => (
              <tr key={r.address}>
                <td className="muted">{i + 1}</td>
                <td>
                  <button className="link" onClick={() => onRoute(`#/wallet/${r.address}`)}>
                    {shortAddr(r.address)}
                  </button>
                </td>
                <td>{r.total.toLocaleString()}</td>
                <td>{r.trading}</td>
                <td>{r.ideas + r.targets}</td>
                <td>{r.scripts + r.installs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Referrals({ onRoute }: { onRoute: (h: string) => void }) {
  const w = useWallet();
  const [stats, setStats] = useState<ReferralStats | null>(null);
  const [mineRef, setMineRef] = useState<string | null | undefined>(undefined);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = pendingReferrer();
  const link = w.address ? `${location.origin}${location.pathname}?ref=${w.address.toLowerCase()}` : '';

  useEffect(() => {
    if (!socialEnabled || !w.address) return;
    referralStats(w.address).then(setStats).catch(() => {});
    myReferrer(w.address).then(setMineRef).catch(() => setMineRef(null));
  }, [w.address]);

  const confirm = async () => {
    if (!w.address || !pending) return;
    setBusy(true);
    setMsg('');
    try {
      await setReferrer(w.address, pending, w.signMessage);
      setMineRef(pending);
      setMsg('Thanks, your referrer is recorded.');
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="explainer">
        <h2>Referrals</h2>
        <p>
          Share your link. When someone you bring trades from the HyperSpace chart, you earn {REFERRAL_SHARE_PCT}% of the builder fee they pay. Fees are read
          from Hyperliquid's on-chain fills. Earnings are paid out in USDC by HyperSpace; payouts are not automated yet, so the amount below is what is owed.
        </p>
        {!BUILDER_ADDRESS && <p className="warn-text small">This build has no builder fee set, so referrals earn nothing yet.</p>}
      </div>
      {!socialEnabled ? (
        <div className="panel-empty">Referrals need the HyperSpace backend (see README).</div>
      ) : !w.address ? (
        <div className="panel-empty">Connect a wallet to get your referral link.</div>
      ) : (
        <>
          <section className="card-block">
            <h3>Your link</h3>
            <div className="row">
              <input readOnly value={link} className="mono grow" onFocus={(e) => e.target.select()} />
              <button onClick={() => void navigator.clipboard.writeText(link).then(() => setMsg('Link copied.'))}>Copy</button>
            </div>
            {pending && mineRef === null && pending !== w.address.toLowerCase() && (
              <div className="row">
                <span>You arrived from {shortAddr(pending)}'s link.</span>
                <button className="primary" disabled={busy} onClick={() => void confirm()}>
                  {busy ? 'Check your wallet…' : 'Confirm referral (free signature)'}
                </button>
              </div>
            )}
            {mineRef && <div className="muted small">You were referred by {shortAddr(mineRef)}.</div>}
            {msg && <div className="small">{msg}</div>}
          </section>
          <section className="card-block">
            <h3>People you referred</h3>
            {!stats ? (
              <div className="muted small">Loading…</div>
            ) : stats.referees.length === 0 ? (
              <div className="muted small">Nobody yet.</div>
            ) : (
              <>
                <div className="cards">
                  <div className="card">
                    <small className="muted">Referred traders</small>
                    {stats.referees.length}
                  </div>
                  <div className="card">
                    <small className="muted">Builder fees they paid</small>
                    {fmtUsd(stats.totalFees, 2)}
                  </div>
                  <div className="card">
                    <small className="muted">You earned ({stats.sharePct}%)</small>
                    <span className="up">{fmtUsd(stats.earned, 2)}</span>
                  </div>
                </div>
                <table className="lb-table">
                  <thead>
                    <tr>
                      <th>Trader</th>
                      <th>Joined</th>
                      <th>Volume</th>
                      <th>Builder fees</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.referees.map((r) => (
                      <tr key={r.address}>
                        <td>
                          <button className="link" onClick={() => onRoute(`#/wallet/${r.address}`)}>
                            {shortAddr(r.address)}
                          </button>
                        </td>
                        <td className="small">{new Date(r.joined).toLocaleDateString()}</td>
                        <td>{fmtUsd(r.volume)}</td>
                        <td>{fmtUsd(r.builderFees, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="muted small">Updated {new Date(stats.updatedAt).toLocaleString()}.</div>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}

function Premium() {
  const rows: [string, keyof typeof FREE][] = [
    ['Alerts', 'alerts'],
    ['Watched wallets', 'walletWatch'],
    ['Saved chart layouts', 'savedLayouts'],
  ];
  return (
    <>
      <div className="explainer">
        <h2>HyperSpace Premium</h2>
        <p>{PREMIUM_PLAN.note} Everything else in HyperSpace stays free.</p>
      </div>
      <div className="oi-grid">
        <section className="card-block">
          <h3>Plans</h3>
          <table className="lb-table">
            <thead>
              <tr>
                <th />
                <th>Free</th>
                <th>Premium</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, k]) => (
                <tr key={k}>
                  <td>{label}</td>
                  <td>{FREE[k]}</td>
                  <td>{PREMIUM[k]}</td>
                </tr>
              ))}
              <tr>
                <td>Paid indicators</td>
                <td>–</td>
                <td>Bought per indicator, in {TOKEN_SYMBOL}</td>
              </tr>
            </tbody>
          </table>
        </section>
        <section className="card-block">
          <h3>Premium</h3>
          <div className="big-num">
            {PREMIUM_PLAN.pricePer30Days.toLocaleString()} {TOKEN_SYMBOL}
          </div>
          <div className="muted small">per 30 days</div>
          <ul className="small">
            {PREMIUM_PLAN.perks.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <button className="primary" disabled={!TOKEN_LIVE} title="Opens when the token launches">
            {TOKEN_LIVE ? 'Upgrade' : `Opens at the ${TOKEN_SYMBOL} launch`}
          </button>
        </section>
      </div>
    </>
  );
}
