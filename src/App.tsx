import { useEffect, useState } from 'react';
import { fetchMarkets, isAddress, type Market } from './hl/api';
import { Terminal } from './pages/Terminal';
import { Wallet } from './pages/Wallet';
import { Ideas } from './pages/Ideas';
import { Studio } from './pages/Studio';
import { Market as MarketPage } from './pages/Market';
import { Leaderboard } from './pages/Leaderboard';
import { Community } from './pages/Community';
import { WalletProvider } from './wallet/WalletContext';
import { NetworkSwitch, WalletButton } from './components/WalletButton';
import { NETWORK } from './hl/network';
import { Logo } from './components/Logo';
import { Markets, type MarketsTab } from './pages/Markets';
import { Alerts } from './pages/Alerts';
import { Rewards, captureReferral, type RewardsTab } from './pages/Rewards';
import { AlertEngine } from './alerts/AlertEngine';
import { AlertSync } from './alerts/sync';
import { dismissToast, useToasts } from './alerts/notify';
import { markFirstSeen, newListings, recordMarkets } from './hl/recorder';
import { useWallet } from './wallet/WalletContext';

type Route = { page: 'trade'; coin: string; wallet: string | null; vs: string | null; snap: string | null } | { page: 'wallet'; address: string | null }
  | { page: 'markets'; tab: MarketsTab }
  | { page: 'alerts' }
  | { page: 'rewards'; tab: RewardsTab }
  | { page: 'ideas'; coin: string | null }
  | { page: 'studio'; scriptId: string | null }
  | { page: 'market' }
  | { page: 'leaderboard' }
  | { page: 'community'; tab: 'chat' | 'ideas'; channel: string };

function parse(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'wallet') {
    const a = parts[1]?.toLowerCase() ?? null;
    return { page: 'wallet', address: a && isAddress(a) ? a : null };
  }
  if (parts[0] === 'markets') {
    const t = parts[1] as MarketsTab;
    return { page: 'markets', tab: ['screener', 'funding', 'oi', 'whales', 'auctions'].includes(t) ? t : 'screener' };
  }
  if (parts[0] === 'alerts') return { page: 'alerts' };
  if (parts[0] === 'rewards') {
    const t = parts[1] as RewardsTab;
    return { page: 'rewards', tab: ['points', 'referrals', 'premium'].includes(t) ? t : 'points' };
  }
  if (parts[0] === 'studio') return { page: 'studio', scriptId: parts[1] ?? null };
  if (parts[0] === 'market') return { page: 'market' };
  if (parts[0] === 'leaderboard') return { page: 'leaderboard' };
  if (parts[0] === 'community') return { page: 'community', tab: parts[1] === 'ideas' ? 'ideas' : 'chat', channel: parts[2] ?? 'general' };
  if (parts[0] === 'ideas') return { page: 'ideas', coin: parts[1] ? decodeURIComponent(parts[1]) : null };
  const qs = new URLSearchParams(query ?? '');
  const w = qs.get('wallet');
  return {
    page: 'trade',
    coin: parts[1] ? decodeURIComponent(parts[1]) : 'BTC',
    wallet: w && isAddress(w) ? w.toLowerCase() : null,
    vs: qs.get('vs'),
    snap: qs.get('snap'),
  };
}

export default function App() {
  const [route, setRoute] = useState(() => parse(location.hash));
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [error, setError] = useState('');
  const [fresh, setFresh] = useState<string[]>([]);

  useEffect(() => captureReferral(), []);

  useEffect(() => {
    const on = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    const load = () =>
      fetchMarkets()
        .then((m) => {
          setMarkets(m);
          setError('');
          // Record OI and friends for history, and spot new listings.
          void recordMarkets(m);
          const added = newListings(m);
          if (added.length) {
            markFirstSeen(added);
            setFresh(added);
          }
        })
        .catch((e) => setError(`Could not reach Hyperliquid: ${e.message}`));
    load();
    // Refresh funding, OI and volume once a minute.
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, []);

  const go = (hash: string) => {
    location.hash = hash;
  };

  return (
    <WalletProvider markets={markets ?? []}>
    <div className="app">
      <header className="top">
        <a className="brand" href="#/trade/BTC" aria-label="HyperSpace home">
          <Logo />
        </a>
        <nav>
          <a className={route.page === 'trade' ? 'on' : ''} href={`#/trade/${route.page === 'trade' ? route.coin : 'BTC'}`}>
            Chart
          </a>
          <a className={route.page === 'markets' ? 'on' : ''} href="#/markets/screener">
            Markets
          </a>
          <a className={route.page === 'alerts' ? 'on' : ''} href="#/alerts">
            Alerts
          </a>
          <a className={route.page === 'leaderboard' ? 'on' : ''} href="#/leaderboard">
            Leaderboard
          </a>
          <a className={route.page === 'community' || route.page === 'ideas' ? 'on' : ''} href="#/community/chat/general">
            Community
          </a>
          <a className={route.page === 'studio' ? 'on' : ''} href="#/studio">
            Studio
          </a>
          <a className={route.page === 'market' ? 'on' : ''} href="#/market">
            Indicators
          </a>
          <a className={route.page === 'rewards' ? 'on' : ''} href="#/rewards/points">
            Rewards
          </a>
          <a className={route.page === 'wallet' ? 'on' : ''} href="#/wallet">
            Verified PnL
          </a>
        </nav>
        <span className="muted small top-note">Live data from Hyperliquid {NETWORK}</span>
        <NetworkSwitch />
        <WalletButton />
      </header>
      {error && <div className="error">{error}</div>}
      {markets && <AlertEngine markets={markets} newMarkets={fresh} />}
      <SessionBits />
      <Toasts onRoute={go} />
      {route.page === 'markets' ? (
        markets ? <Markets markets={markets} tab={route.tab} onRoute={go} /> : <div className="panel-empty">Loading markets…</div>
      ) : route.page === 'alerts' ? (
        <Alerts markets={markets ?? []} onRoute={go} />
      ) : route.page === 'rewards' ? (
        <Rewards tab={route.tab} onRoute={go} />
      ) : route.page === 'wallet' ? (
        <Wallet address={route.address} onRoute={go} />
      ) : route.page === 'studio' ? (
        <Studio markets={markets ?? []} scriptId={route.scriptId} onRoute={go} />
      ) : route.page === 'market' ? (
        <MarketPage onRoute={go} />
      ) : route.page === 'leaderboard' ? (
        <Leaderboard onRoute={go} />
      ) : route.page === 'community' ? (
        <Community markets={markets ?? []} tab={route.tab} channel={route.channel} onRoute={go} />
      ) : route.page === 'ideas' ? (
        <Ideas markets={markets ?? []} coin={route.coin} onRoute={go} />
      ) : markets ? (
        <Terminal markets={markets} coin={route.coin} overlay={route.wallet} vs={route.vs} snap={route.snap} onRoute={go} />
      ) : (
        !error && <div className="panel-empty">Loading markets…</div>
      )}
    </div>
    </WalletProvider>
  );
}

/** Pieces that need the wallet: alert sync to the backend. */
function SessionBits() {
  const w = useWallet();
  return <AlertSync address={w.address?.toLowerCase() ?? null} />;
}

function Toasts({ onRoute }: { onRoute: (h: string) => void }) {
  const list = useToasts();
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast">
          <div className="toast-head">
            <strong>🔔 {t.title}</strong>
            <button className="link" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
          <div className="small">{t.body}</div>
          {t.link && (
            <button
              className="link small"
              onClick={() => {
                onRoute(t.link!);
                dismissToast(t.id);
              }}
            >
              Open chart
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
