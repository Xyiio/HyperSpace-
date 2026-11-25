import { useEffect, useState } from 'react';
import { fetchMarkets, isAddress, type Market } from './hl/api';
import { Terminal } from './pages/Terminal';
import { Wallet } from './pages/Wallet';

type Route = { page: 'trade'; coin: string; wallet: string | null } | { page: 'wallet'; address: string | null };

function parse(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'wallet') {
    const a = parts[1]?.toLowerCase() ?? null;
    return { page: 'wallet', address: a && isAddress(a) ? a : null };
  }
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
    <div className="app">
      <header className="top">
        <a className="brand" href="#/trade/BTC">
          <span className="mark">◆</span> HyperSpace
        </a>
        <nav>
          <a className={route.page === 'trade' ? 'on' : ''} href={`#/trade/${route.page === 'trade' ? route.coin : 'BTC'}`}>
            Chart
          </a>
          <a className={route.page === 'wallet' ? 'on' : ''} href="#/wallet">
            Verified PnL
          </a>
        </nav>
        <span className="muted small">Live data from Hyperliquid mainnet · no keys, no backend</span>
      </header>
      {error && <div className="error">{error}</div>}
      {route.page === 'wallet' ? (
        <Wallet address={route.address} onRoute={go} />
      ) : markets ? (
        <Terminal markets={markets} coin={route.coin} overlay={route.wallet} onRoute={go} />
      ) : (
        !error && <div className="panel-empty">Loading markets…</div>
      )}
    </div>
  );
}
