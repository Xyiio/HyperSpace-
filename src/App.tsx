import { useEffect, useState } from 'react';
import { fetchMarkets, isAddress, type Market } from './hl/api';
import { Terminal } from './pages/Terminal';
import { Wallet } from './pages/Wallet';
import { Ideas } from './pages/Ideas';
import { WalletProvider } from './wallet/WalletContext';
import { NetworkSwitch, WalletButton } from './components/WalletButton';
import { NETWORK } from './hl/network';
import { Logo } from './components/Logo';

type Route = { page: 'trade'; coin: string; wallet: string | null } | { page: 'wallet'; address: string | null }
  | { page: 'ideas'; coin: string | null };

function parse(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'wallet') {
    const a = parts[1]?.toLowerCase() ?? null;
    return { page: 'wallet', address: a && isAddress(a) ? a : null };
  }
  if (parts[0] === 'ideas') return { page: 'ideas', coin: parts[1] ? decodeURIComponent(parts[1]) : null };
  const w = new URLSearchParams(query ?? '').get('wallet');
  return { page: 'trade', coin: parts[1] ? decodeURIComponent(parts[1]) : 'BTC', wallet: w && isAddress(w) ? w.toLowerCase() : null };
}

export default function App() {
  const [route, setRoute] = useState(() => parse(location.hash));
  const [markets, setMarkets] = useState<Market[] | null>(null);
  const [error, setError] = useState('');

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
    <WalletProvider>
    <div className="app">
      <header className="top">
        <a className="brand" href="#/trade/BTC" aria-label="HyperSpace home">
          <Logo />
        </a>
        <nav>
          <a className={route.page === 'trade' ? 'on' : ''} href={`#/trade/${route.page === 'trade' ? route.coin : 'BTC'}`}>
            Chart
          </a>
          <a className={route.page === 'wallet' ? 'on' : ''} href="#/wallet">
            Verified PnL
          </a>
          <a className={route.page === 'ideas' ? 'on' : ''} href="#/ideas">
            Ideas
          </a>
        </nav>
        <span className="muted small top-note">Live data from Hyperliquid {NETWORK}</span>
        <NetworkSwitch />
        <WalletButton />
      </header>
      {error && <div className="error">{error}</div>}
      {route.page === 'wallet' ? (
        <Wallet address={route.address} onRoute={go} />
      ) : route.page === 'ideas' ? (
        <Ideas markets={markets ?? []} coin={route.coin} onRoute={go} />
      ) : markets ? (
        <Terminal markets={markets} coin={route.coin} overlay={route.wallet} onRoute={go} />
      ) : (
        !error && <div className="panel-empty">Loading markets…</div>
      )}
    </div>
    </WalletProvider>
  );
}
