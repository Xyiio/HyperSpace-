// Community: live chat channels and the trade-ideas feed.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Market } from '../hl/api';
import { CHAT_CHANNELS, MAX_CHAT_CHARS } from '../../supabase/functions/_shared/proof';
import { chatLogin, chatLogout, chatPost, chatSession, getProfiles, listChat, socialEnabled, subscribeChat, type ChatMessage, type Profile } from '../social/client';
import { shortAddr } from '../hl/stats';
import { errorText, useWallet } from '../wallet/WalletContext';
import { Ideas } from './Ideas';

export function Community({ markets, tab, channel, onRoute }: { markets: Market[]; tab: 'chat' | 'ideas'; channel: string; onRoute: (h: string) => void }) {
  return (
    <div className="community">
      <div className="community-tabs">
        <a className={tab === 'chat' ? 'on' : ''} href="#/community/chat/general">
          Chat
        </a>
        <a className={tab === 'ideas' ? 'on' : ''} href="#/community/ideas">
          Trade ideas
        </a>
      </div>
      {tab === 'ideas' ? <Ideas markets={markets} coin={null} onRoute={onRoute} /> : <Chat markets={markets} channel={channel} onRoute={onRoute} />}
    </div>
  );
}

function Chat({ markets, channel, onRoute }: { markets: Market[]; channel: string; onRoute: (h: string) => void }) {
  const w = useWallet();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState(() => (w.address ? chatSession(w.address) : null));
  const bottom = useRef<HTMLDivElement>(null);
  const chan = CHAT_CHANNELS.find((c) => c.id === channel) ?? CHAT_CHANNELS[0];

  useEffect(() => setSession(w.address ? chatSession(w.address) : null), [w.address]);

  useEffect(() => {
    setMessages([]);
    setError('');
    if (!socialEnabled) return;
    let alive = true;
    listChat(chan.id)
      .then((m) => alive && setMessages(m))
      .catch((e) => setError(errorText(e)));
    const unsub = subscribeChat(chan.id, (m) => setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m].slice(-300))));
    return () => {
      alive = false;
      unsub();
    };
  }, [chan.id]);

  // Names for authors we have not seen yet.
  useEffect(() => {
    const missing = [...new Set(messages.map((m) => m.author))].filter((a) => !profiles.has(a));
    if (missing.length) getProfiles(missing).then((p) => setProfiles((old) => new Map([...old, ...p])));
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => bottom.current?.scrollIntoView({ block: 'end' }), [messages.length]);

  const signIn = async () => {
    if (!w.address) return;
    setBusy(true);
    setError('');
    try {
      setSession(await chatLogin(w.address, w.signMessage));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!w.address || !text.trim()) return;
    setBusy(true);
    setError('');
    try {
      const { message } = await chatPost(w.address, chan.id, text);
      setMessages((list) => (list.some((x) => x.id === message.id) ? list : [...list, message]));
      setText('');
    } catch (err) {
      setError(errorText(err));
      setSession(chatSession(w.address));
    } finally {
      setBusy(false);
    }
  };

  // $BTC or $xyz:TSLA become links to the chart.
  const coins = new Set(markets.map((m) => m.name.toLowerCase()));
  const render = (body: string): ReactNode[] =>
    body.split(/(\$[A-Za-z0-9:]+)/g).map((part, i) => {
      const c = part.startsWith('$') ? markets.find((m) => m.name.toLowerCase() === part.slice(1).toLowerCase()) : null;
      return c && coins.has(c.name.toLowerCase()) ? (
        <button key={i} className="link" onClick={() => onRoute(`#/trade/${c.name}`)}>
          {part}
        </button>
      ) : (
        part
      );
    });

  return (
    <div className="chat">
      <nav className="chat-channels">
        {CHAT_CHANNELS.map((c) => (
          <a key={c.id} href={`#/community/chat/${c.id}`} className={c.id === chan.id ? 'on' : ''} title={c.about}>
            # {c.name}
          </a>
        ))}
      </nav>
      <section className="chat-main">
        <header className="chat-head">
          <strong># {chan.name}</strong> <span className="muted small">{chan.about}</span>
        </header>
        {!socialEnabled ? (
          <div className="panel-empty">Chat needs the Supabase backend (see README). Once it is connected, messages appear here live.</div>
        ) : (
          <div className="chat-log">
            {messages.length === 0 && <div className="panel-empty">No messages yet. Say hello.</div>}
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const grouped = prev && prev.author === m.author && Date.parse(m.created_at) - Date.parse(prev.created_at) < 5 * 60_000;
              const name = profiles.get(m.author)?.display_name ?? shortAddr(m.author);
              return (
                <div key={m.id} className={`chat-msg${grouped ? ' grouped' : ''}`}>
                  {!grouped && (
                    <div className="chat-meta">
                      <button className="link" onClick={() => onRoute(`#/wallet/${m.author}`)} title={`${m.author} · see verified PnL`}>
                        {name}
                      </button>
                      <span className="muted small">{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                  )}
                  <div className="chat-body">{render(m.body)}</div>
                </div>
              );
            })}
            <div ref={bottom} />
          </div>
        )}
        {error && <div className="warn-text small chat-err">{error}</div>}
        {socialEnabled &&
          (!w.address ? (
            <div className="chat-compose muted">Connect a wallet to chat. Every name links to that wallet's verified PnL.</div>
          ) : !session ? (
            <div className="chat-compose">
              <button className="primary" onClick={signIn} disabled={busy}>
                {busy ? 'Check your wallet…' : 'Sign in to chat'}
              </button>
              <span className="muted small">One free signature, valid for 7 days. No transaction.</span>
            </div>
          ) : (
            <form className="chat-compose" onSubmit={send}>
              <input
                value={text}
                maxLength={MAX_CHAT_CHARS}
                placeholder={`Message #${chan.name} · type $BTC to link a chart`}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
              />
              <button type="submit" disabled={busy || !text.trim()}>
                Send
              </button>
              <button
                type="button"
                className="link small"
                onClick={() => {
                  chatLogout(w.address!);
                  setSession(null);
                }}
              >
                Sign out
              </button>
            </form>
          ))}
      </section>
    </div>
  );
}
