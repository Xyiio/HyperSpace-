// Indicator marketplace: HyperScript indicators published by HyperSpace users.
import { useEffect, useMemo, useState } from 'react';
import { EXAMPLES } from '../script/hyperscript';
import { useScriptLibrary, type SavedScript } from '../script/library';
import { ScriptPreview } from '../components/ScriptPreview';
import {
  getProfiles,
  getScriptCode,
  listCreators,
  listScripts,
  rateScript,
  scriptRatings,
  socialEnabled,
  type CreatorStats,
  type MarketScript,
  type Profile,
} from '../social/client';
import { shortAddr } from '../hl/stats';
import { errorText, useWallet } from '../wallet/WalletContext';
import { addScriptToChart } from './Studio';

type Filter = 'all' | 'free' | 'paid';
type Sort = 'installs' | 'rating' | 'new';

export function Market({ onRoute }: { onRoute: (h: string) => void }) {
  const [library, setLibrary] = useScriptLibrary();
  const [scripts, setScripts] = useState<MarketScript[] | null>(null);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState<{ id: string; code: string } | null>(null);
  const [msg, setMsg] = useState<Record<string, string>>({});
  const [ratings, setRatings] = useState<Map<string, { avg: number; count: number }>>(new Map());
  const [creators, setCreators] = useState<CreatorStats[]>([]);
  const [sort, setSort] = useState<Sort>('installs');
  const [rating, setRating] = useState<string | null>(null);
  const w = useWallet();

  const loadRatings = () => scriptRatings().then(setRatings).catch(() => {});
  useEffect(() => {
    if (!socialEnabled) return;
    void loadRatings();
    listCreators()
      .then(async (c) => {
        setCreators(c);
        const extra = await getProfiles(c.map((x) => x.author));
        setProfiles((p) => new Map([...extra, ...p]));
      })
      .catch(() => {});
  }, []);

  const rate = async (s: MarketScript, stars: number) => {
    if (!w.address) return setMsg((m) => ({ ...m, [s.id]: 'Connect a wallet to rate.' }));
    setMsg((m) => ({ ...m, [s.id]: 'Check your wallet to sign (free)…' }));
    try {
      await rateScript(w.address, s.id, stars, w.signMessage);
      setRating(null);
      setMsg((m) => ({ ...m, [s.id]: `Rated ${stars}★. Thanks.` }));
      void loadRatings();
    } catch (e) {
      setMsg((m) => ({ ...m, [s.id]: errorText(e) }));
    }
  };

  useEffect(() => {
    if (!socialEnabled) {
      setScripts([]);
      return;
    }
    listScripts()
      .then(async (l) => {
        setScripts(l);
        setProfiles(await getProfiles(l.map((s) => s.author)));
      })
      .catch((e) => setError(errorText(e)));
  }, []);

  const shown = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = (scripts ?? []).filter(
      (s) =>
        (filter === 'all' || (filter === 'free' ? s.price_hs === 0 : s.price_hs > 0)) &&
        (!term || s.name.toLowerCase().includes(term) || s.description.toLowerCase().includes(term)),
    );
    if (sort === 'rating') return [...list].sort((a, b) => (ratings.get(b.id)?.avg ?? 0) - (ratings.get(a.id)?.avg ?? 0));
    if (sort === 'installs') return [...list].sort((a, b) => b.installs - a.installs);
    return list;
  }, [scripts, filter, q, sort, ratings]);

  const installed = (marketId: string) => library.find((s) => s.origin === 'market' && s.marketId === marketId);

  const install = async (s: MarketScript, toChart: boolean) => {
    setMsg((m) => ({ ...m, [s.id]: 'Installing…' }));
    try {
      const code = await getScriptCode(s.id);
      const existing = installed(s.id);
      const sc: SavedScript = existing
        ? { ...existing, code, name: s.name, updatedAt: Date.now() }
        : { id: crypto.randomUUID(), name: s.name, code, origin: 'market', marketId: s.id, author: s.author, updatedAt: Date.now() };
      setLibrary((l) => (existing ? l.map((x) => (x.id === sc.id ? sc : x)) : [sc, ...l]));
      if (toChart) {
        addScriptToChart(sc);
        onRoute('#/trade/BTC');
      } else setMsg((m) => ({ ...m, [s.id]: 'Installed. Find it under Indicators on the chart.' }));
    } catch (e) {
      setMsg((m) => ({ ...m, [s.id]: errorText(e) }));
    }
  };

  const showPreview = async (s: MarketScript) => {
    if (preview?.id === s.id) return setPreview(null);
    try {
      setPreview({ id: s.id, code: await getScriptCode(s.id) });
    } catch (e) {
      setMsg((m) => ({ ...m, [s.id]: errorText(e) }));
    }
  };

  const useExample = (i: number, toChart: boolean) => {
    const ex = EXAMPLES[i];
    const existing = library.find((s) => s.origin === 'example' && s.name === ex.name);
    const sc: SavedScript = existing ?? { id: crypto.randomUUID(), name: ex.name, code: ex.code, origin: 'example', updatedAt: Date.now() };
    if (!existing) setLibrary((l) => [sc, ...l]);
    if (toChart) {
      addScriptToChart(sc);
      onRoute('#/trade/BTC');
    } else onRoute(`#/studio/${sc.id}`);
  };

  return (
    <div className="wallet market">
      <div className="explainer">
        <h2>Indicator Market</h2>
        <p>
          Indicators written in HyperScript by HyperSpace traders. Free ones install in one click. Creators can also price an indicator in
          HYPERSPACE tokens; buying opens when the token launches (the plan is for payment to go straight to the creator's wallet). Every script runs in a
          sandbox that only sees price data. <a href="#/studio">Write your own →</a>
        </p>
      </div>

      <h3>HyperSpace originals</h3>
      <div className="market-grid">
        {EXAMPLES.map((ex, i) => (
          <div key={ex.name} className="market-card">
            <div className="mc-head">
              <strong>{ex.name}</strong>
              <span className="badge free">Free</span>
            </div>
            <p>{ex.description}</p>
            <div className="mc-foot">
              <span className="muted small">by HyperSpace</span>
              <span className="mc-actions">
                <button className="link small" onClick={() => useExample(i, false)}>
                  Open in Studio
                </button>
                <button onClick={() => useExample(i, true)}>Add to chart</button>
              </span>
            </div>
          </div>
        ))}
      </div>

      {creators.length > 0 && (
        <section className="card-block">
          <h3>Top creators</h3>
          <table className="lb-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Creator</th>
                <th>Indicators</th>
                <th>Installs</th>
                <th>Rating</th>
              </tr>
            </thead>
            <tbody>
              {creators.slice(0, 10).map((c, i) => (
                <tr key={c.author}>
                  <td className="muted">{i + 1}</td>
                  <td>
                    <button className="link" onClick={() => onRoute(`#/wallet/${c.author}`)}>
                      {profiles.get(c.author)?.display_name ?? shortAddr(c.author)}
                    </button>
                  </td>
                  <td>{c.scripts}</td>
                  <td>{c.installs.toLocaleString()}</td>
                  <td>{c.avg_rating ? <Stars r={{ avg: c.avg_rating, count: c.ratings }} /> : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <div className="market-tools">
        <h3>From the community</h3>
        <input placeholder="Search indicators" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} title="Sort">
          <option value="installs">Most installed</option>
          <option value="rating">Top rated</option>
          <option value="new">Newest</option>
        </select>
        <div className="seg">
          {(['all', 'free', 'paid'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'free' ? 'Free' : 'Paid'}
            </button>
          ))}
        </div>
      </div>
      {!socialEnabled ? (
        <div className="panel-empty">
          Community indicators need the Supabase backend (see README). Until it is connected you can use the originals above and your own scripts.
        </div>
      ) : error ? (
        <div className="error">{error}</div>
      ) : scripts === null ? (
        <div className="panel-empty">Loading…</div>
      ) : shown.length === 0 ? (
        <div className="panel-empty">No indicators yet. Publish the first from the Studio.</div>
      ) : (
        <div className="market-grid">
          {shown.map((s) => {
            const mine = installed(s.id);
            const author = profiles.get(s.author)?.display_name ?? shortAddr(s.author);
            return (
              <div key={s.id} className="market-card">
                <div className="mc-head">
                  <strong>{s.name}</strong>
                  <span className={`badge ${s.price_hs ? 'paid' : 'free'}`}>{s.price_hs ? `${s.price_hs.toLocaleString()} HYPERSPACE` : 'Free'}</span>
                </div>
                <p>{s.description}</p>
                {preview?.id === s.id && <ScriptPreview code={preview.code} coin="BTC" interval="1h" height={260} />}
                <div className="mc-foot">
                  <span className="muted small">
                    by{' '}
                    <button className="link" onClick={() => onRoute(`#/wallet/${s.author}`)}>
                      {author}
                    </button>{' '}
                    · v{s.version} · {s.installs.toLocaleString()} installs ·{' '}
                    <Stars r={ratings.get(s.id)} />{' '}
                    <button className="link small" onClick={() => setRating(rating === s.id ? null : s.id)}>
                      Rate
                    </button>
                  </span>
                  <span className="mc-actions">
                    {s.price_hs > 0 ? (
                      <button disabled title="Buying opens when the HYPERSPACE token launches">
                        Buy at token launch
                      </button>
                    ) : (
                      <>
                        <button className="link small" onClick={() => showPreview(s)}>
                          {preview?.id === s.id ? 'Hide preview' : 'Preview'}
                        </button>
                        <button className="link small" onClick={() => install(s, false)}>
                          {mine ? 'Update' : 'Install'}
                        </button>
                        <button onClick={() => install(s, true)}>Add to chart</button>
                      </>
                    )}
                  </span>
                </div>
                {rating === s.id && (
                  <div className="row small">
                    Your rating:
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} className="link" onClick={() => void rate(s, n)}>
                        {'★'.repeat(n)}
                      </button>
                    ))}
                  </div>
                )}
                {msg[s.id] && <div className="small muted">{msg[s.id]}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Stars({ r }: { r?: { avg: number; count: number } }) {
  if (!r || !r.count) return <span className="muted">no ratings</span>;
  const full = Math.round(r.avg);
  return (
    <span className="stars" title={`${r.avg.toFixed(2)} from ${r.count} rating${r.count === 1 ? '' : 's'}`}>
      {'★'.repeat(full)}
      {'☆'.repeat(5 - full)} <span className="muted">({r.count})</span>
    </span>
  );
}
