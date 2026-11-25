import { useEffect, useRef, useState } from 'react';
import { useWallet } from '../wallet/WalletContext';
import { NETWORK, setNetwork } from '../hl/network';
import { shortAddr } from '../hl/stats';

export function NetworkSwitch() {
  return (
    <select
      className={`network ${NETWORK}`}
      value={NETWORK}
      onChange={(e) => setNetwork(e.target.value as 'mainnet' | 'testnet')}
      title="Hyperliquid network for data and trading"
    >
      <option value="mainnet">Mainnet</option>
      <option value="testnet">Testnet</option>
    </select>
  );
}

export function WalletButton() {
  const w = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  if (w.address) {
    return (
      <div className="wallet-btn" ref={ref}>
        <button onClick={() => setOpen((o) => !o)}>
          <span className={`dot ${w.tradingReady ? 'open' : 'connecting'}`} /> {shortAddr(w.address)}
        </button>
        {open && (
          <div className="menu">
            <div className="muted small">{w.walletName}</div>
            <div className="mono small">{w.address}</div>
            <div className="small">{w.tradingReady ? 'Trading enabled in this browser' : 'Trading not enabled yet'}</div>
            <a href={`#/wallet/${w.address.toLowerCase()}`} onClick={() => setOpen(false)}>
              My verified PnL
            </a>
            <button onClick={() => (w.disconnect(), setOpen(false))}>Disconnect</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-btn" ref={ref}>
      <button className="primary" disabled={w.connecting} onClick={() => setOpen((o) => !o)}>
        {w.connecting ? 'Connecting…' : 'Connect wallet'}
      </button>
      {open && (
        <div className="menu">
          {w.wallets.length === 0 ? (
            <div className="small">
              No browser wallet found. Install one such as MetaMask or Rabby, then reload this page.
            </div>
          ) : (
            w.wallets.map((x) => (
              <button key={x.uuid} className="wallet-choice" onClick={() => (setOpen(false), void w.connect(x))}>
                {x.icon && <img src={x.icon} alt="" width={18} height={18} />} {x.name}
              </button>
            ))
          )}
        </div>
      )}
      {w.error && !open && <div className="menu error small">{w.error}</div>}
    </div>
  );
}
