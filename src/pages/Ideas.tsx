import { useEffect, useMemo, useState } from 'react';
import type { Market } from '../hl/api';
import { getProfiles, getScorecards, listIdeas, postIdea, socialEnabled, type Idea, type Profile, type Scorecard } from '../social/client';
import { validateIdea } from '../../supabase/functions/_shared/proof';
import { errorText, useWallet } from '../wallet/WalletContext';
import { IdeaCard } from '../components/IdeaCard';

export function Ideas({ markets, coin, onRoute }: { markets: Market[]; coin: string | null; onRoute: (h: string) => void }) {
  const w = useWallet();
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [cards, setCards] = useState<Map<string, Scorecard>>(new Map());
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    setIdeas(null);
    listIdeas({ coin: coin ?? undefined })
      .then(async (list) => {
        setIdeas(list);
        const authors = list.map((i) => i.author);
        getScorecards(authors).then(setCards).catch(() => {});
        setProfiles(await getProfiles(authors));
      })
      .catch((e) => setError(errorText(e)));
  }, [coin, reload]);

  const byName = useMemo(() => new Map(markets.map((m) => [m.name, m])), [markets]);

  return (
    <div className="wallet ideas">
      <div className="explainer">
        <h2>Trade ideas with proof</h2>
        <p>
          Every idea is signed by the author's wallet. When it is posted, HyperSpace records the market price and the author's live Hyperliquid
          position, so you can see whether they were actually in the trade. Each card then checks the price path against the target and stop,
          and whether the author traded it afterwards.
        </p>
      </div>
      {!socialEnabled ? (
        <div className="panel-empty">
          The ideas feed needs its Supabase backend. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY and deploy the functions in /supabase (see README).
        </div>
      ) : (
        <>
          {w.address ? (
            <PostForm markets={markets} defaultCoin={coin ?? 'BTC'} onPosted={() => setReload((n) => n + 1)} />
          ) : (
            <div className="muted">Connect a wallet to post an idea.</div>
          )}
          <div className="ideas-filter">
            Showing {coin ? coin : 'all markets'}
            {coin && (
              <button className="link" onClick={() => onRoute('#/ideas')}>
                {' '}
                · show all
              </button>
            )}
          </div>
          {error && <div className="error">{error}</div>}
          {ideas === null ? (
            <div className="panel-empty">Loading ideas…</div>
          ) : ideas.length === 0 ? (
            <div className="panel-empty">No ideas yet. Be the first.</div>
          ) : (
            ideas.map((i) => <IdeaCard key={i.id} idea={i} profile={profiles.get(i.author)} market={byName.get(i.coin)} scorecard={cards.get(i.author.toLowerCase())} onRoute={onRoute} />)
          )}
        </>
      )}
    </div>
  );
}

function PostForm({ markets, defaultCoin, onPosted }: { markets: Market[]; defaultCoin: string; onPosted: () => void }) {
  const w = useWallet();
  const [coin, setCoin] = useState(defaultCoin);
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [entry, setEntry] = useState('');
  const [target, setTarget] = useState('');
  const [stop, setStop] = useState('');
  const [timeframe, setTimeframe] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    const idea = validateIdea({ coin, direction, entry, target, stop, timeframe, body });
    if (typeof idea === 'string') return setMsg({ ok: false, text: idea });
    if (!markets.some((m) => m.name === idea.coin)) return setMsg({ ok: false, text: `Unknown market ${idea.coin}.` });
    setBusy(true);
    try {
      await postIdea(w.address!, idea, w.signMessage);
      setBody('');
      setMsg({ ok: true, text: 'Posted.' });
      onPosted();
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="idea-form" onSubmit={submit}>
      <div className="row">
        <input list="hs-markets" value={coin} onChange={(e) => setCoin(e.target.value)} placeholder="Market" />
        <datalist id="hs-markets">
          {markets.map((m) => (
            <option key={m.name} value={m.name} />
          ))}
        </datalist>
        <div className="seg">
          <button type="button" className={direction === 'long' ? 'on buy' : ''} onClick={() => setDirection('long')}>
            Long
          </button>
          <button type="button" className={direction === 'short' ? 'on sell' : ''} onClick={() => setDirection('short')}>
            Short
          </button>
        </div>
        <input inputMode="decimal" placeholder="Entry (optional)" value={entry} onChange={(e) => setEntry(e.target.value)} />
        <input inputMode="decimal" placeholder="Target (optional)" value={target} onChange={(e) => setTarget(e.target.value)} />
        <input inputMode="decimal" placeholder="Stop (optional)" value={stop} onChange={(e) => setStop(e.target.value)} />
        <input placeholder="Timeframe, e.g. 1-3 days" value={timeframe} onChange={(e) => setTimeframe(e.target.value)} />
      </div>
      <textarea placeholder="Your thesis (10 to 2,000 characters)" value={body} onChange={(e) => setBody(e.target.value)} rows={3} />
      <div className="row">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Check your wallet…' : 'Sign and post'}
        </button>
        <span className="muted small">Signing is free and sends no transaction.</span>
        {msg && <span className={msg.ok ? 'up' : 'warn-text'}>{msg.text}</span>}
      </div>
    </form>
  );
}
