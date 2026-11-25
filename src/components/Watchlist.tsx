// Watchlist: named sections of markets, drag to reorder, live last price and 24h change.
import { useEffect, useMemo, useRef, useState } from 'react';
import { info, type Market, type PerpAsset, type PerpAssetCtx } from '../hl/api';
import { usePersistent } from './ChartTools';

interface Section {
  id: string;
  name: string;
  coins: string[];
  collapsed?: boolean;
}

const DEFAULT_SECTIONS: Section[] = [
  { id: 'crypto', name: 'Crypto', coins: ['BTC', 'ETH', 'SOL', 'HYPE'] },
  { id: 'stocks', name: 'Stocks', coins: ['xyz:TSLA', 'xyz:NVDA', 'xyz:AAPL'] },
];

type Px = { px: number; prev: number };

/** Mark price and previous-day price for every market on the dexes in use, refreshed every 5 seconds. */
function useLivePrices(markets: Market[], coins: string[]) {
  const [prices, setPrices] = useState<Map<string, Px>>(new Map());
  const dexes = useMemo(() => {
    const byName = new Map(markets.map((m) => [m.name, m.dex]));
    return [...new Set(coins.map((c) => byName.get(c)).filter((d): d is string => d !== undefined))].sort();
  }, [markets, coins]);
  const key = dexes.join(',');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const results = await Promise.all(
        dexes.map((dex) => info<[{ universe: PerpAsset[] }, PerpAssetCtx[]]>({ type: 'metaAndAssetCtxs', dex }).catch(() => null)),
      );
      if (!alive) return;
      const next = new Map<string, Px>();
      for (const r of results) {
        if (!r) continue;
        r[0].universe.forEach((a, i) => next.set(a.name, { px: Number(r[1][i].markPx), prev: Number(r[1][i].prevDayPx) }));
      }
      setPrices(next);
    };
    void load();
    const t = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return prices;
}

const fmtPx = (v: number) => (v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 1 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 3) : v.toPrecision(4));

export function Watchlist({
  markets,
  current,
  onMarket,
  side,
  onSide,
  onClose,
}: {
  markets: Market[];
  current: string;
  onMarket: (coin: string) => void;
  side: 'left' | 'right';
  onSide: (s: 'left' | 'right') => void;
  onClose: () => void;
}) {
  const [sections, setSections] = usePersistent<Section[]>('hs.watchlist', DEFAULT_SECTIONS);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState(sections[0]?.id ?? '');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const drag = useRef<{ coin: string; from: string } | null>(null);
  const [dropAt, setDropAt] = useState<string | null>(null);

  const byName = useMemo(() => new Map(markets.map((m) => [m.name, m])), [markets]);
  const allCoins = useMemo(() => sections.flatMap((s) => s.coins), [sections]);
  const prices = useLivePrices(markets, allCoins);
  const targetId = sections.some((s) => s.id === target) ? target : sections[0]?.id;

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return markets
      .filter((m) => m.name.toLowerCase().includes(q) || m.dexLabel.toLowerCase().includes(q))
      .sort((a, b) => Number(a.symbol.toLowerCase() !== q) - Number(b.symbol.toLowerCase() !== q) || Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm))
      .slice(0, 12);
  }, [query, markets]);

  const update = (id: string, fn: (s: Section) => Section) => setSections((list) => list.map((s) => (s.id === id ? fn(s) : s)));

  const add = (coin: string, sectionId = targetId) => {
    if (!sectionId) return;
    update(sectionId, (s) => (s.coins.includes(coin) ? s : { ...s, coins: [...s.coins, coin], collapsed: false }));
    setQuery('');
  };
  const remove = (sectionId: string, coin: string) => update(sectionId, (s) => ({ ...s, coins: s.coins.filter((c) => c !== coin) }));

  const addSection = () => {
    const id = crypto.randomUUID();
    setSections((l) => [...l, { id, name: 'New list', coins: [] }]);
    setRenaming(id);
    setTarget(id);
  };
  const moveSection = (id: string, dir: -1 | 1) =>
    setSections((l) => {
      const i = l.findIndex((s) => s.id === id);
      const j = i + dir;
      if (j < 0 || j >= l.length) return l;
      const copy = [...l];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  const deleteSection = (id: string) => {
    setSections((l) => l.filter((s) => s.id !== id));
    setConfirmDelete(null);
  };

  /** Move the dragged coin before `beforeCoin` in `toSection` (or to its end). */
  const drop = (toSection: string, beforeCoin: string | null) => {
    const d = drag.current;
    drag.current = null;
    setDropAt(null);
    if (!d || d.coin === beforeCoin) return;
    setSections((list) =>
      list.map((s) => {
        let coins = s.id === d.from ? s.coins.filter((c) => c !== d.coin) : s.coins;
        if (s.id === toSection) {
          coins = coins.filter((c) => c !== d.coin);
          const i = beforeCoin ? coins.indexOf(beforeCoin) : -1;
          coins = i < 0 ? [...coins, d.coin] : [...coins.slice(0, i), d.coin, ...coins.slice(i)];
        }
        return coins === s.coins ? s : { ...s, coins };
      }),
    );
  };

  const sortSection = (id: string, by: 'name' | 'price' | 'change') =>
    update(id, (s) => {
      const val = (c: string) => {
        const p = prices.get(c);
        if (by === 'name') return byName.get(c)?.symbol ?? c;
        if (!p) return -Infinity;
        return by === 'price' ? p.px : (p.px - p.prev) / p.prev;
      };
      const coins = [...s.coins].sort((a, b) => {
        const va = val(a);
        const vb = val(b);
        return typeof va === 'string' ? va.localeCompare(vb as string) : (vb as number) - (va as number);
      });
      return { ...s, coins };
    });

  return (
    <aside className="watchlist">
      <div className="wl-head">
        <strong>Watchlist</strong>
        <span className="wl-actions">
          <button className="link small" onClick={() => onSide(side === 'left' ? 'right' : 'left')} title="Move the watchlist to the other side">
            {side === 'left' ? 'Move right ⇥' : '⇤ Move left'}
          </button>
          <button className="link small" onClick={onClose} title="Hide the watchlist">
            ✕
          </button>
        </span>
      </div>
      <div className="wl-search">
        <input placeholder="Search to add: BTC, TSLA, gold…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {sections.length > 1 && (
          <select value={targetId} onChange={(e) => setTarget(e.target.value)} title="Add to list">
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                → {s.name}
              </option>
            ))}
          </select>
        )}
        {results.length > 0 && (
          <div className="wl-results">
            {results.map((m) => (
              <button key={m.name} onClick={() => add(m.name)}>
                <span>
                  {m.symbol} <span className="muted small">{m.dex ? m.dexLabel : 'perp'}</span>
                </span>
                <span className="muted small">{allCoins.includes(m.name) ? 'added' : '+ add'}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="wl-cols">
        <span>Ticker</span>
        <span>Last</span>
        <span>24h</span>
      </div>
      <div className="wl-body">
        {sections.map((s, si) => (
          <div
            key={s.id}
            className={`wl-section${dropAt === `${s.id}:end` ? ' drop-end' : ''}`}
            onDragOver={(e) => {
              if (!drag.current) return;
              e.preventDefault();
              if (e.target === e.currentTarget) setDropAt(`${s.id}:end`);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(s.id, null);
            }}
          >
            <div className="wl-sec-head" onClick={() => setTarget(s.id)}>
              <button className="link caret" onClick={() => update(s.id, (x) => ({ ...x, collapsed: !x.collapsed }))} aria-label={s.collapsed ? 'Expand' : 'Collapse'}>
                {s.collapsed ? '▸' : '▾'}
              </button>
              {renaming === s.id ? (
                <input
                  className="wl-rename"
                  autoFocus
                  defaultValue={s.name}
                  onFocus={(e) => e.target.select()}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (name) update(s.id, (x) => ({ ...x, name: name.slice(0, 40) }));
                    setRenaming(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className={`wl-name${targetId === s.id ? ' target' : ''}`} onDoubleClick={() => setRenaming(s.id)} title="Double-click to rename">
                  {s.name} <span className="muted small">{s.coins.length}</span>
                </span>
              )}
              <span className="wl-sec-tools">
                <select
                  className="tiny"
                  value=""
                  title="Sort this list"
                  onChange={(e) => {
                    if (e.target.value) sortSection(s.id, e.target.value as 'name' | 'price' | 'change');
                  }}
                >
                  <option value="">Sort</option>
                  <option value="name">A to Z</option>
                  <option value="change">24h change</option>
                  <option value="price">Price</option>
                </select>
                <button className="link small" title="Rename" onClick={() => setRenaming(s.id)}>
                  ✎
                </button>
                <button className="link small" title="Move list up" disabled={si === 0} onClick={() => moveSection(s.id, -1)}>
                  ↑
                </button>
                <button className="link small" title="Move list down" disabled={si === sections.length - 1} onClick={() => moveSection(s.id, 1)}>
                  ↓
                </button>
                {confirmDelete === s.id ? (
                  <button className="link small warn-text" onClick={() => deleteSection(s.id)}>
                    Delete list?
                  </button>
                ) : (
                  <button className="link small" title="Delete list" onClick={() => (s.coins.length ? setConfirmDelete(s.id) : deleteSection(s.id))}>
                    🗑
                  </button>
                )}
              </span>
            </div>
            {!s.collapsed &&
              s.coins.map((c) => {
                const m = byName.get(c);
                const p = prices.get(c) ?? (m ? { px: Number(m.ctx.markPx), prev: Number(m.ctx.prevDayPx) } : null);
                const chg = p && p.prev ? ((p.px - p.prev) / p.prev) * 100 : null;
                return (
                  <div
                    key={c}
                    className={`wl-row${c === current ? ' on' : ''}${dropAt === `${s.id}:${c}` ? ' drop-before' : ''}${m ? '' : ' gone'}`}
                    draggable
                    onDragStart={(e) => {
                      drag.current = { coin: c, from: s.id };
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', c);
                    }}
                    onDragEnd={() => {
                      drag.current = null;
                      setDropAt(null);
                    }}
                    onDragOver={(e) => {
                      if (!drag.current) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDropAt(`${s.id}:${c}`);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      drop(s.id, c);
                    }}
                    onClick={() => m && onMarket(c)}
                    title={m ? `${m.dexLabel} · drag to reorder` : 'No longer listed'}
                  >
                    <span className="wl-ticker">
                      {m?.symbol ?? c}
                      {m?.dex && <span className="wl-dex">{m.dex}</span>}
                    </span>
                    <span className="wl-px">{p ? fmtPx(p.px) : '–'}</span>
                    <span className={`wl-chg ${chg === null ? 'muted' : chg >= 0 ? 'up' : 'down'}`}>
                      {chg === null ? '–' : `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`}
                    </span>
                    <button
                      className="link wl-x"
                      title="Remove from list"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(s.id, c);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            {!s.collapsed && s.coins.length === 0 && <div className="muted small wl-empty">Empty. Search above to add, or drag a ticker here.</div>}
          </div>
        ))}
        <button className="link small wl-add-sec" onClick={addSection}>
          + New list
        </button>
      </div>
    </aside>
  );
}
