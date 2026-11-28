// Alerts and wallet watch: create and manage alerts, choose how they reach you.
import { useEffect, useState } from 'react';
import { isAddress, type Market } from '../hl/api';
import { shortAddr } from '../hl/stats';
import { addAlert, describeAlert, removeAlert, updateAlert, useAlerts, type Alert } from '../alerts/store';
import { askBrowserPermission, getNotifySettings, notify, setNotifySettings, type NotifySettings } from '../alerts/notify';
import { pushAlerts, useSyncStatus } from '../alerts/sync';
import { socialEnabled, telegramLink, telegramUnlink, walletLogin, walletSession } from '../social/client';
import { errorText, useWallet } from '../wallet/WalletContext';
import { currentLimits } from '../token/premium';

type NewKind = 'price' | 'funding' | 'bigTrade' | 'listing';

export function Alerts({ markets, onRoute }: { markets: Market[]; onRoute: (h: string) => void }) {
  const alerts = useAlerts();
  const w = useWallet();
  const [kind, setKind] = useState<NewKind>('price');
  const [coin, setCoin] = useState('BTC');
  const [op, setOp] = useState<'above' | 'below'>('above');
  const [value, setValue] = useState('');
  const [repeat, setRepeat] = useState(false);
  const [msg, setMsg] = useState('');
  const [watchAddr, setWatchAddr] = useState('');
  const [watchLabel, setWatchLabel] = useState('');
  const [settings, setSettings] = useState<NotifySettings>(getNotifySettings);
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'unsupported'));

  const m = markets.find((x) => x.name.toLowerCase() === coin.trim().toLowerCase());
  const watches = alerts.filter((a) => a.kind === 'wallet');
  const others = alerts.filter((a) => a.kind !== 'wallet');
  const lim = currentLimits();

  // Sensible default values when the market or kind changes.
  useEffect(() => {
    if (!m) return;
    if (kind === 'price') setValue(String(Number((Number(m.ctx.markPx) * (op === 'above' ? 1.02 : 0.98)).toPrecision(5))));
    if (kind === 'funding') setValue(op === 'above' ? '0.01' : '-0.005');
    if (kind === 'bigTrade') setValue('500000');
  }, [kind, m?.name, op]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setMsg('');
    if (kind === 'listing') {
      if (alerts.some((a) => a.kind === 'listing')) return setMsg('You already have a new-listing alert.');
      return setMsg(addAlert({ kind: 'listing', repeat: true }) ?? 'Alert added.');
    }
    if (!m) return setMsg('Pick a market from the list.');
    const v = Number(value);
    if (!Number.isFinite(v) || (kind !== 'funding' && v <= 0)) return setMsg('Enter a number.');
    const err = addAlert({ kind, coin: m.name, op: kind === 'bigTrade' ? undefined : op, value: v, refPx: Number(m.ctx.markPx), repeat: kind === 'bigTrade' ? true : repeat });
    setMsg(err ?? `Alert added: ${m.name}.`);
  };

  const watch = (e: React.FormEvent) => {
    e.preventDefault();
    const a = watchAddr.trim().toLowerCase();
    if (!isAddress(a)) return setMsg('Enter a wallet address (0x…).');
    const err = addAlert({ kind: 'wallet', address: a, label: watchLabel.trim() || undefined, repeat: true });
    setMsg(err ?? `Watching ${watchLabel.trim() || shortAddr(a)}.`);
    if (!err) {
      setWatchAddr('');
      setWatchLabel('');
    }
  };

  const saveSettings = (s: NotifySettings) => {
    setSettings(s);
    setNotifySettings(s);
  };

  return (
    <div className="wallet alerts-page">
      <div className="explainer">
        <h2>Alerts and wallet watch</h2>
        <p>
          Get pinged on price levels, your chart lines, funding, big trades, new listings, and when a trader you follow opens or closes a position. Alerts
          run in this browser while HyperSpace is open in any tab{socialEnabled ? ', and with Telegram linked they keep running on the server when it is closed' : ''}. Wallet watch only
          notifies you: HyperSpace never copies trades for you.
        </p>
      </div>

      <section className="card-block">
        <h3>How alerts reach you</h3>
        <div className="row wrap">
          <label className="check">
            <input type="checkbox" checked={settings.browser} onChange={(e) => saveSettings({ ...settings, browser: e.target.checked })} /> Browser notifications
          </label>
          {perm !== 'granted' && perm !== 'unsupported' && settings.browser && (
            <button onClick={() => void askBrowserPermission().then((p) => setPerm(p))}>{perm === 'denied' ? 'Blocked: allow in browser settings' : 'Allow notifications'}</button>
          )}
          <label className="check">
            <input type="checkbox" checked={settings.sound} onChange={(e) => saveSettings({ ...settings, sound: e.target.checked })} /> Sound
          </label>
          <button className="link" onClick={() => notify('Test alert', 'This is how HyperSpace alerts look.', '#/alerts')}>
            Send a test
          </button>
        </div>
        <TelegramBox settings={settings} onSettings={saveSettings} address={w.address} sign={w.signMessage} />
      </section>

      <section className="card-block">
        <h3>New alert</h3>
        <form className="alert-form" onSubmit={create}>
          <select value={kind} onChange={(e) => setKind(e.target.value as NewKind)}>
            <option value="price">Price</option>
            <option value="funding">Funding rate</option>
            <option value="bigTrade">Big trade</option>
            <option value="listing">New listings</option>
          </select>
          {kind !== 'listing' && (
            <>
              <input list="alert-markets" value={coin} onChange={(e) => setCoin(e.target.value)} placeholder="Market" className="coin-in" />
              <datalist id="alert-markets">
                {markets.map((x) => (
                  <option key={x.name} value={x.name} />
                ))}
              </datalist>
            </>
          )}
          {(kind === 'price' || kind === 'funding') && (
            <select value={op} onChange={(e) => setOp(e.target.value as 'above' | 'below')}>
              <option value="above">{kind === 'price' ? 'rises to' : 'above'}</option>
              <option value="below">{kind === 'price' ? 'falls to' : 'below'}</option>
            </select>
          )}
          {kind !== 'listing' && (
            <label>
              {kind === 'funding' ? '% per hour' : kind === 'bigTrade' ? 'at least $' : ''}
              <input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} className="num" />
            </label>
          )}
          {(kind === 'price' || kind === 'funding') && (
            <label className="check" title="Keep the alert on after it fires (at most once a minute)">
              <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} /> Repeat
            </label>
          )}
          <button className="primary" type="submit">
            Add alert
          </button>
          {m && kind === 'price' && <span className="muted small">now {m.ctx.markPx}</span>}
          {m && kind === 'funding' && <span className="muted small">now {(Number(m.ctx.funding) * 100).toFixed(4)}%/h</span>}
        </form>
        <p className="muted small">
          For alerts on your own lines, select a horizontal or trend line on the chart and press 🔔 Alert. Free plan: {others.length}/{lim.alerts} alerts.
        </p>
        {msg && <div className="small">{msg}</div>}
        <AlertList list={others} onRoute={onRoute} />
      </section>

      <section className="card-block">
        <h3>Wallet watch</h3>
        <p className="muted small">
          Follow any trader and get a ping when they open or close a position. Find traders on the <a href="#/leaderboard">Leaderboard</a>. Free plan: {watches.length}/{lim.walletWatch} wallets.
        </p>
        <form className="alert-form" onSubmit={watch}>
          <input placeholder="Wallet 0x…" value={watchAddr} onChange={(e) => setWatchAddr(e.target.value)} className="mono addr-in" />
          <input placeholder="Name (optional)" value={watchLabel} onChange={(e) => setWatchLabel(e.target.value)} />
          <button type="submit">Watch</button>
        </form>
        <AlertList list={watches} onRoute={onRoute} />
      </section>
    </div>
  );
}

function AlertList({ list, onRoute }: { list: Alert[]; onRoute: (h: string) => void }) {
  if (!list.length) return <div className="muted small pad">None yet.</div>;
  return (
    <table className="alert-table">
      <tbody>
        {list.map((a) => (
          <tr key={a.id} className={a.active ? '' : 'muted'}>
            <td>
              {a.kind === 'wallet' ? (
                <button className="link" onClick={() => onRoute(`#/wallet/${a.address}`)}>
                  {describeAlert(a)}
                </button>
              ) : a.coin ? (
                <button className="link" onClick={() => onRoute(`#/trade/${a.coin}`)}>
                  {describeAlert(a)}
                </button>
              ) : (
                describeAlert(a)
              )}
            </td>
            <td className="small">{a.lastFired ? `last fired ${new Date(a.lastFired).toLocaleString()}` : a.active ? 'waiting' : ''}</td>
            <td>
              <label className="check small">
                <input type="checkbox" checked={a.active} onChange={(e) => updateAlert(a.id, { active: e.target.checked, lastFired: e.target.checked ? undefined : a.lastFired })} /> On
              </label>
            </td>
            <td>
              <button className="link" onClick={() => removeAlert(a.id)} aria-label="Delete alert">
                ✕
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TelegramBox({ settings, onSettings, address, sign }: { settings: NotifySettings; onSettings: (s: NotifySettings) => void; address: string | null; sign: (m: string) => Promise<string> }) {
  const status = useSyncStatus();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [, force] = useState(0);

  if (!socialEnabled) return <div className="muted small">Telegram alerts need the HyperSpace backend (see README). Browser alerts work now.</div>;
  if (!address) return <div className="muted small">Connect a wallet to send alerts to Telegram.</div>;
  const session = walletSession(address);

  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setErr('');
    try {
      await f();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
      force((n) => n + 1);
    }
  };
  const serverOn = !!status?.lastRun && Date.now() - Date.parse(status.lastRun) < 5 * 60_000;

  return (
    <div className="telegram">
      <strong>Telegram</strong>{' '}
      {!session ? (
        <>
          <button disabled={busy} onClick={() => void act(async () => void (await walletLogin(address, sign), await pushAlerts(address)))}>
            {busy ? 'Check your wallet…' : 'Sign in to link Telegram'}
          </button>
          <span className="muted small"> One free signature, valid 7 days.</span>
        </>
      ) : status?.telegramLinked ? (
        <>
          <span className="up">Linked</span>{' '}
          <label className="check small">
            <input type="checkbox" checked={settings.telegram} onChange={(e) => onSettings({ ...settings, telegram: e.target.checked })} /> Send alerts there
          </label>{' '}
          <button className="link small" disabled={busy} onClick={() => void act(async () => void (await telegramUnlink(address), await pushAlerts(address)))}>
            Unlink
          </button>
          <div className="muted small">
            {serverOn
              ? 'The server checks price, line, funding, wallet and listing alerts every minute, so they arrive even with HyperSpace closed.'
              : "The server's alert job is not running yet, so Telegram alerts only arrive while HyperSpace is open."}
          </div>
        </>
      ) : (
        <>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const r = await telegramLink(address);
                const url = r.bot ? `https://t.me/${r.bot}?start=${r.code}` : null;
                setLink(url ?? r.code);
                if (url) window.open(url, '_blank', 'noopener');
              })
            }
          >
            Link Telegram
          </button>
          {link && (
            <span className="small">
              {' '}
              {link.startsWith('https') ? (
                <>
                  Press Start in the bot chat that opened (<a href={link} target="_blank" rel="noreferrer">open it again</a>), then{' '}
                </>
              ) : (
                <>Send <code>/start {link}</code> to the HyperSpace bot, then </>
              )}
              <button className="link small" onClick={() => void act(async () => void (await pushAlerts(address)))}>
                check
              </button>
              .
            </span>
          )}
        </>
      )}
      {err && <div className="warn-text small">{err}</div>}
    </div>
  );
}
