// Market intelligence: screener, funding scanner, open interest, whale and liquidation feed,
// and the ticker auctions. Everything comes from Hyperliquid's public API.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  HLP_LIQUIDATOR,
  fetchCandles,
  fetchOiCapped,
  fetchPerpAuction,
  fetchPredictedFundings,
  fetchSpot,
  fetchSpotAuction,
  info,
  type GasAuction,
  type Market,
  type PredictedFundings,
  type Trade,
} from '../hl/api';
import { hlSocket } from '../hl/ws';
import { fmtCompact, fmtUsd, shortAddr } from '../hl/stats';
import { loadSamples, oiChange, onSamples, recentListings, type MarketSample } from '../hl/recorder';
import { premium, spotByBase, spotFor, type SpotQuote } from '../hl/spot';

export type MarketsTab = 'screener' | 'funding' | 'oi' | 'whales' | 'auctions';
const TABS: { id: MarketsTab; label: string }[] = [
  { id: 'screener', label: 'Screener' },
  { id: 'funding', label: 'Funding scanner' },
  { id: 'oi', label: 'Open interest' },
  { id: 'whales', label: 'Whales & liquidations' },
  { id: 'auctions', label: 'Ticker auctions' },
];

export function Markets({ markets, tab, onRoute }: { markets: Market[]; tab: MarketsTab; onRoute: (h: string) => void }) {
  return (
    <div className="wallet markets-page">
      <div className="community-tabs">
        {TABS.map((t) => (
          <a key={t.id} className={tab === t.id ? 'on' : ''} href={`#/markets/${t.id}`}>
            {t.label}
          </a>
        ))}
      </div>
      {tab === 'screener' && <Screener markets={markets} onRoute={onRoute} />}
      {tab === 'funding' && <Funding markets={markets} onRoute={onRoute} />}
      {tab === 'oi' && <OpenInterest markets={markets} onRoute={onRoute} />}
      {tab === 'whales' && <Whales markets={markets} onRoute={onRoute} />}
      {tab === 'auctions' && <Auctions markets={markets} />}
    </div>
  );
}

function useSamples() {
  const [s, setS] = useState<MarketSample[]>([]);
  useEffect(() => {
    const load = () => void loadSamples().then((x) => setS([...x]));
    load();
    return onSamples(load);
  }, []);
  return s;
}

function useCapped(markets: Market[]) {
  const [capped, setCapped] = useState<Set<string>>(new Set());
  const dexes = useMemo(() => [...new Set(markets.map((m) => m.dex))].join(','), [markets]);
  useEffect(() => {
    Promise.all(dexes.split(',').map((d) => fetchOiCapped(d).catch(() => [] as string[]))).then((lists) => setCapped(new Set(lists.flat())));
  }, [dexes]);
  return capped;
}

const pct = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);

function Th<K extends string>({ k, sort, setSort, children, title }: { k: K; sort: { k: K; dir: 1 | -1 }; setSort: (s: { k: K; dir: 1 | -1 }) => void; children: React.ReactNode; title?: string }) {
  return (
    <th className="sortable" title={title} onClick={() => setSort({ k, dir: sort.k === k ? (-sort.dir as 1 | -1) : -1 })}>
      {children}
      {sort.k === k ? (sort.dir < 0 ? ' ▾' : ' ▴') : ''}
    </th>
  );
}

// ---------- Screener ----------

type SKey = 'name' | 'chg' | 'vol' | 'oi' | 'oiChg' | 'funding' | 'prem' | 'spike';

/** Today's volume vs the average of the previous 7 days, for the most traded markets. */
function useVolumeSpikes(markets: Market[], n = 60) {
  const [spikes, setSpikes] = useState<Record<string, number>>(() => {
    try {
      const c = JSON.parse(sessionStorage.getItem('hs.spikes') ?? 'null');
      return c && Date.now() - c.at < 15 * 60_000 ? c.v : {};
    } catch {
      return {};
    }
  });
  const names = useMemo(() => [...markets].sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm)).slice(0, n).map((m) => m.name), [markets, n]);
  useEffect(() => {
    const todo = names.filter((c) => spikes[c] === undefined);
    if (!todo.length) return;
    let alive = true;
    const out: Record<string, number> = { ...spikes };
    (async () => {
      for (let i = 0; i < todo.length && alive; i += 3) {
        await Promise.all(
          todo.slice(i, i + 3).map(async (c) => {
            try {
              const k = await fetchCandles(c, '1d', 9);
              const vols = k.map((x) => Number(x.v) * Number(x.c));
              const today = vols.pop() ?? 0;
              const prev = vols.slice(-7);
              const avg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;
              // Today is a partial day: scale it to a full day before comparing.
              const frac = Math.max(0.05, (Date.now() % 86_400_000) / 86_400_000);
              out[c] = avg > 0 ? today / frac / avg : NaN;
            } catch {
              out[c] = NaN;
            }
          }),
        );
        if (alive) setSpikes({ ...out });
      }
      try {
        sessionStorage.setItem('hs.spikes', JSON.stringify({ at: Date.now(), v: out }));
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [names.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return spikes;
}

function Screener({ markets, onRoute }: { markets: Market[]; onRoute: (h: string) => void }) {
  const samples = useSamples();
  const capped = useCapped(markets);
  const spikes = useVolumeSpikes(markets);
  const [spot, setSpot] = useState<Map<string, SpotQuote>>(new Map());
  const [venue, setVenue] = useState<'all' | 'crypto' | 'hip3'>('all');
  const [q, setQ] = useState('');
  const [win, setWin] = useState<'1h' | '24h'>('24h');
  const [onlyCap, setOnlyCap] = useState(false);
  const [sort, setSort] = useState<{ k: SKey; dir: 1 | -1 }>({ k: 'vol', dir: -1 });
  const fresh = recentListings();

  useEffect(() => {
    spotByBase().then(setSpot).catch(() => {});
  }, []);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const ms = win === '1h' ? 3600_000 : 86_400_000;
    return markets
      .filter((m) => (venue === 'all' || (venue === 'crypto' ? !m.dex : !!m.dex)) && (!term || m.name.toLowerCase().includes(term)) && (!onlyCap || capped.has(m.name)))
      .map((m) => {
        const px = Number(m.ctx.markPx);
        const sq = spotFor(m, spot);
        return {
          m,
          px,
          chg: px / Number(m.ctx.prevDayPx) - 1,
          vol: Number(m.ctx.dayNtlVlm),
          oi: Number(m.ctx.openInterest) * px,
          oiChg: oiChange(samples, m, ms),
          funding: Number(m.ctx.funding),
          prem: sq ? premium(px, sq.px) : null,
          spike: spikes[m.name] ?? null,
        };
      })
      .sort((a, b) => {
        const v = (r: typeof a) => (sort.k === 'name' ? r.m.name : sort.k === 'oiChg' ? (r.oiChg?.pct ?? -Infinity) : ((r[sort.k] as number | null) ?? -Infinity));
        const x = v(a);
        const y = v(b);
        return (typeof x === 'string' ? x.localeCompare(y as string) : (x as number) - (y as number)) * sort.dir;
      });
  }, [markets, venue, q, onlyCap, capped, samples, spot, spikes, sort, win]);

  const oldest = samples[0]?.t;
  return (
    <>
      <div className="lb-tools">
        <input placeholder="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          {(['all', 'crypto', 'hip3'] as const).map((v) => (
            <button key={v} className={venue === v ? 'on' : ''} onClick={() => setVenue(v)}>
              {v === 'all' ? 'All' : v === 'crypto' ? 'Crypto' : 'Stocks & more (HIP-3)'}
            </button>
          ))}
        </div>
        <label>
          OI change over{' '}
          <select value={win} onChange={(e) => setWin(e.target.value as '1h' | '24h')}>
            <option value="1h">1 hour</option>
            <option value="24h">24 hours</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={onlyCap} onChange={(e) => setOnlyCap(e.target.checked)} /> At OI cap only
        </label>
        <span className="muted small">{rows.length} markets</span>
      </div>
      <p className="muted small">
        Hyperliquid only serves current open interest, so HyperSpace records it while open.{' '}
        {oldest ? `Recorded since ${new Date(oldest).toLocaleString()}; shorter windows show the change since then.` : 'OI change appears after the first 5 minutes.'} Volume spike compares today's pace with the
        7-day average for the 60 most traded markets.
      </p>
      <div className="table-scroll">
        <table className="lb-table screener">
          <thead>
            <tr>
              <Th k="name" sort={sort} setSort={setSort}>
                Market
              </Th>
              <th>Price</th>
              <Th k="chg" sort={sort} setSort={setSort}>
                24h
              </Th>
              <Th k="vol" sort={sort} setSort={setSort}>
                Volume
              </Th>
              <Th k="spike" sort={sort} setSort={setSort} title="Today's volume pace vs the 7-day daily average">
                Vol spike
              </Th>
              <Th k="oi" sort={sort} setSort={setSort}>
                Open interest
              </Th>
              <Th k="oiChg" sort={sort} setSort={setSort}>
                OI {win}
              </Th>
              <Th k="funding" sort={sort} setSort={setSort} title="Hourly funding; positive means longs pay shorts">
                Funding/h (APR)
              </Th>
              <Th k="prem" sort={sort} setSort={setSort} title="Perp price over the spot pair">
                Perp vs spot
              </Th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.m.name}>
                <td>
                  <button className="link" onClick={() => onRoute(`#/trade/${r.m.name}`)}>
                    {r.m.name}
                  </button>
                  {r.m.dex && <span className="muted small"> {r.m.dexLabel}</span>}
                </td>
                <td>{r.m.ctx.markPx}</td>
                <td className={r.chg >= 0 ? 'up' : 'down'}>{pct(r.chg)}</td>
                <td>{fmtCompact(r.vol)}</td>
                <td className={r.spike !== null && r.spike >= 2 ? 'warn-text' : 'muted'}>{r.spike !== null && Number.isFinite(r.spike) ? `${r.spike.toFixed(1)}x` : '–'}</td>
                <td>{fmtCompact(r.oi)}</td>
                <td className={r.oiChg ? (r.oiChg.pct >= 0 ? 'up' : 'down') : 'muted'} title={r.oiChg ? `since ${new Date(r.oiChg.since).toLocaleString()}` : undefined}>
                  {r.oiChg ? pct(r.oiChg.pct, 1) : '–'}
                </td>
                <td className={r.funding >= 0 ? 'up' : 'down'}>
                  {(r.funding * 100).toFixed(4)}% <span className="muted small">({(r.funding * 24 * 365 * 100).toFixed(0)}%)</span>
                </td>
                <td className={r.prem === null ? 'muted' : r.prem >= 0 ? 'up' : 'down'}>{r.prem === null ? '–' : pct(r.prem, 3)}</td>
                <td className="small">
                  {capped.has(r.m.name) && <span className="badge warn" title="Open interest is at Hyperliquid's cap: no new positions">OI cap</span>}{' '}
                  {fresh[r.m.name] && <span className="badge new">New</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------- Funding scanner ----------

type FKey = 'coin' | 'hl' | 'bin' | 'bybit' | 'gap';
const VENUES = { HlPerp: 'Hyperliquid', BinPerp: 'Binance', BybitPerp: 'Bybit' } as const;

function Funding({ markets, onRoute }: { markets: Market[]; onRoute: (h: string) => void }) {
  const [data, setData] = useState<PredictedFundings | null>(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [both, setBoth] = useState(true);
  const [sort, setSort] = useState<{ k: FKey; dir: 1 | -1 }>({ k: 'gap', dir: -1 });

  useEffect(() => {
    const load = () =>
      fetchPredictedFundings()
        .then(setData)
        .catch((e) => setErr(e.message));
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, []);

  const listed = useMemo(() => new Set(markets.map((m) => m.name)), [markets]);
  const rows = useMemo(() => {
    if (!data) return [];
    const term = q.trim().toLowerCase();
    return data
      .map(([coin, venues]) => {
        // Annualised rate per venue: each venue's rate is per its own funding interval.
        const apr: Partial<Record<keyof typeof VENUES, number>> = {};
        let next = Infinity;
        for (const [v, x] of venues) {
          if (!x) continue;
          const hours = x.fundingIntervalHours ?? (v === 'HlPerp' ? 1 : 8);
          apr[v] = (Number(x.fundingRate) / hours) * 24 * 365;
          if (v === 'HlPerp') next = x.nextFundingTime;
        }
        const cex = [apr.BinPerp, apr.BybitPerp].filter((x): x is number => x !== undefined);
        const gap = apr.HlPerp !== undefined && cex.length ? apr.HlPerp - cex.reduce((a, b) => a + b, 0) / cex.length : null;
        return { coin, hl: apr.HlPerp ?? null, bin: apr.BinPerp ?? null, bybit: apr.BybitPerp ?? null, gap, next };
      })
      .filter((r) => (!term || r.coin.toLowerCase().includes(term)) && (!both || (r.hl !== null && (r.bin !== null || r.bybit !== null))))
      .sort((a, b) => {
        if (sort.k === 'coin') return a.coin.localeCompare(b.coin) * sort.dir;
        const v = (r: typeof a): number => (sort.k === 'gap' ? Math.abs(r.gap ?? -Infinity) : ((r[sort.k as 'hl' | 'bin' | 'bybit'] as number | null) ?? -Infinity));
        return (v(a) - v(b)) * sort.dir;
      });
  }, [data, q, both, sort]);

  const cell = (v: number | null) => <td className={v === null ? 'muted' : v >= 0 ? 'up' : 'down'}>{v === null ? '–' : `${(v * 100).toFixed(1)}%`}</td>;
  return (
    <>
      <div className="explainer">
        <p>
          Predicted next funding on Hyperliquid, Binance and Bybit, as reported by Hyperliquid, annualised so venues with 1-, 4- and 8-hour funding compare fairly.
          Positive means longs pay shorts. A big gap between venues shows where a trade is crowded, and where a hedged (long one venue, short the other) carry may sit.
        </p>
      </div>
      <div className="lb-tools">
        <input placeholder="Search coins" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={both} onChange={(e) => setBoth(e.target.checked)} /> Only coins on Hyperliquid and a CEX
        </label>
        {data && <span className="muted small">{rows.length} coins · refreshes every minute</span>}
      </div>
      {err && <div className="error">{err}</div>}
      {!data && !err && <div className="panel-empty">Loading funding…</div>}
      {data && (
        <div className="table-scroll">
          <table className="lb-table">
            <thead>
              <tr>
                <Th k="coin" sort={sort} setSort={setSort}>
                  Coin
                </Th>
                <Th k="hl" sort={sort} setSort={setSort}>
                  Hyperliquid APR
                </Th>
                <Th k="bin" sort={sort} setSort={setSort}>
                  Binance APR
                </Th>
                <Th k="bybit" sort={sort} setSort={setSort}>
                  Bybit APR
                </Th>
                <Th k="gap" sort={sort} setSort={setSort} title="Hyperliquid minus the CEX average">
                  Gap vs CEX
                </Th>
                <th>Next HL funding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.coin}>
                  <td>
                    {listed.has(r.coin) ? (
                      <button className="link" onClick={() => onRoute(`#/trade/${r.coin}`)}>
                        {r.coin}
                      </button>
                    ) : (
                      r.coin
                    )}
                  </td>
                  {cell(r.hl)}
                  {cell(r.bin)}
                  {cell(r.bybit)}
                  <td className={r.gap === null ? 'muted' : Math.abs(r.gap) > 0.2 ? 'warn-text' : ''}>{r.gap === null ? '–' : `${r.gap >= 0 ? '+' : ''}${(r.gap * 100).toFixed(1)}%`}</td>
                  <td className="small muted">{Number.isFinite(r.next) ? new Date(r.next).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ---------- Open interest ----------

function OpenInterest({ markets, onRoute }: { markets: Market[]; onRoute: (h: string) => void }) {
  const samples = useSamples();
  const capped = useCapped(markets);
  const withOi = markets.map((m) => ({ m, oi: Number(m.ctx.openInterest) * Number(m.ctx.markPx), chg: oiChange(samples, m, 86_400_000) }));
  const biggest = [...withOi].sort((a, b) => b.oi - a.oi).slice(0, 15);
  const movers = withOi.filter((x) => x.chg && x.oi > 1_000_000).sort((a, b) => Math.abs(b.chg!.pct) - Math.abs(a.chg!.pct)).slice(0, 15);
  const link = (m: Market) => (
    <button className="link" onClick={() => onRoute(`#/trade/${m.name}`)}>
      {m.name}
    </button>
  );
  return (
    <>
      <div className="explainer">
        <p>
          Markets at their open-interest cap cannot take new positions until OI falls, which often pins price or squeezes it. Open interest history on
          the chart is under Indicators → Open interest; HyperSpace records it while open, because Hyperliquid only serves the current value.
        </p>
      </div>
      <div className="oi-grid">
        <section className="card-block">
          <h3>At the OI cap now ({capped.size})</h3>
          {capped.size === 0 ? (
            <div className="muted small">None right now.</div>
          ) : (
            <div className="chips">
              {[...capped].map((c) => {
                const m = markets.find((x) => x.name === c);
                return m ? <span key={c}>{link(m)}</span> : <span key={c} className="muted">{c} (delisted)</span>;
              })}
            </div>
          )}
        </section>
        <section className="card-block">
          <h3>Largest open interest</h3>
          <table className="lb-table">
            <tbody>
              {biggest.map((x) => (
                <tr key={x.m.name}>
                  <td>{link(x.m)}</td>
                  <td>{fmtCompact(x.oi)}</td>
                  <td className={x.chg ? (x.chg.pct >= 0 ? 'up' : 'down') : 'muted'}>{x.chg ? pct(x.chg.pct, 1) : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="card-block">
          <h3>Biggest OI moves {samples.length ? `(since ${new Date(Math.max(samples[0].t, Date.now() - 86_400_000)).toLocaleString()})` : ''}</h3>
          {movers.length === 0 ? (
            <div className="muted small">Needs a few minutes of recording. Keep HyperSpace open and this fills in.</div>
          ) : (
            <table className="lb-table">
              <tbody>
                {movers.map((x) => (
                  <tr key={x.m.name}>
                    <td>{link(x.m)}</td>
                    <td className={x.chg!.pct >= 0 ? 'up' : 'down'}>{pct(x.chg!.pct, 1)}</td>
                    <td className="muted">{fmtCompact(x.oi)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

// ---------- Whale and liquidation feed ----------

interface FeedRow {
  key: string;
  coin: string;
  t: Trade;
  ntl: number;
  liq: boolean;
}

function Whales({ markets, onRoute }: { markets: Market[]; onRoute: (h: string) => void }) {
  const [minUsd, setMinUsd] = useState(100_000);
  const [liqOnly, setLiqOnly] = useState(false);
  const [n, setN] = useState(15);
  const [rows, setRows] = useState<FeedRow[]>([]);
  const buf = useRef<FeedRow[]>([]);
  const minRef = useRef(minUsd);
  minRef.current = minUsd;
  const coins = useMemo(() => [...markets].sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm)).slice(0, n).map((m) => m.name), [markets, n]);

  useEffect(() => {
    const unsubs = coins.map((coin) =>
      hlSocket.subscribe({ type: 'trades', coin }, (ts: Trade[]) => {
        const add = ts
          .map((t) => ({ key: `${coin}-${t.tid}`, coin, t, ntl: Number(t.px) * Number(t.sz), liq: !!t.users?.includes(HLP_LIQUIDATOR) }))
          .filter((r) => r.ntl >= Math.min(minRef.current, 10_000) || r.liq);
        if (add.length) buf.current = [...add.reverse(), ...buf.current].slice(0, 600);
      }),
    );
    const t = window.setInterval(() => setRows(buf.current), 500);
    return () => {
      unsubs.forEach((u) => u());
      window.clearInterval(t);
    };
  }, [coins.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = rows.filter((r) => (liqOnly ? r.liq : r.ntl >= minUsd)).slice(0, 200);
  return (
    <>
      <div className="explainer">
        <p>
          Large trades across the {n} most traded markets, live. Rows marked LIQ traded against Hyperliquid's liquidator vault (backstop liquidations).
          Liquidations that fill on the open book look like ordinary trades in Hyperliquid's public data, so they are not marked. Click a wallet to see its
          verified PnL.
        </p>
      </div>
      <div className="lb-tools">
        <label>
          Minimum $
          <select value={minUsd} onChange={(e) => setMinUsd(Number(e.target.value))}>
            {[25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000].map((v) => (
              <option key={v} value={v}>
                {fmtCompact(v)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Markets{' '}
          <select value={n} onChange={(e) => setN(Number(e.target.value))}>
            {[5, 15, 30].map((v) => (
              <option key={v} value={v}>
                Top {v}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={liqOnly} onChange={(e) => setLiqOnly(e.target.checked)} /> Liquidations only
        </label>
        <span className="muted small">{shown.length} shown</span>
      </div>
      {shown.length === 0 ? (
        <div className="panel-empty">Waiting for {liqOnly ? 'liquidations' : `trades of ${fmtCompact(minUsd)} or more`}…</div>
      ) : (
        <table className="lb-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Market</th>
              <th>Side</th>
              <th>Size</th>
              <th>Price</th>
              <th>Taker</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const taker = r.t.users ? (r.t.side === 'B' ? r.t.users[0] : r.t.users[1]) : null;
              return (
                <tr key={r.key} className={r.ntl >= 1_000_000 ? 'whale' : ''}>
                  <td className="small">{new Date(r.t.time).toLocaleTimeString([], { hour12: false })}</td>
                  <td>
                    <button className="link" onClick={() => onRoute(`#/trade/${r.coin}`)}>
                      {r.coin}
                    </button>
                  </td>
                  <td className={r.t.side === 'B' ? 'up' : 'down'}>{r.t.side === 'B' ? 'Buy' : 'Sell'}</td>
                  <td>{fmtCompact(r.ntl)}</td>
                  <td>{r.t.px}</td>
                  <td>
                    {taker && (
                      <button className="link" onClick={() => onRoute(`#/wallet/${taker}`)}>
                        {shortAddr(taker)}
                      </button>
                    )}
                  </td>
                  <td>{r.liq && <span className="badge warn">LIQ</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

// ---------- Ticker auctions ----------

function Auctions({ markets }: { markets: Market[] }) {
  const [spotA, setSpotA] = useState<GasAuction | null>(null);
  const [perpA, setPerpA] = useState<GasAuction | null>(null);
  const [recentTokens, setRecentTokens] = useState<{ name: string; index: number; fullName?: string | null }[]>([]);
  const [dexes, setDexes] = useState<{ name: string; fullName: string }[]>([]);
  const [err, setErr] = useState('');
  const [, tick] = useState(0);

  useEffect(() => {
    const load = () => {
      Promise.all([fetchSpotAuction(), fetchPerpAuction(), fetchSpot(), info<({ name: string; fullName: string } | null)[]>({ type: 'perpDexs' })])
        .then(([s, p, [meta], dx]) => {
          setSpotA(s);
          setPerpA(p);
          setRecentTokens([...meta.tokens].sort((a, b) => b.index - a.index).slice(0, 12));
          setDexes(dx.filter((d): d is { name: string; fullName: string } => !!d).reverse().slice(0, 8));
        })
        .catch((e) => setErr(e.message));
    };
    load();
    const t = window.setInterval(load, 30_000);
    const c = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      window.clearInterval(t);
      window.clearInterval(c);
    };
  }, []);

  const hype = Number(markets.find((m) => m.name === 'HYPE')?.ctx.markPx ?? 0);
  return (
    <>
      <div className="explainer">
        <p>
          Hyperliquid sells new spot tickers (HIP-1) and new perp dexes (HIP-3) in Dutch auctions paid in HYPE: the price starts high and falls until someone
          buys. Once a round is won, the next one opens when the current round's time runs out.
        </p>
      </div>
      {err && <div className="error">{err}</div>}
      <div className="oi-grid">
        <AuctionCard title="Spot ticker auction (HIP-1)" a={spotA} hype={hype} />
        <AuctionCard title="Perp dex auction (HIP-3)" a={perpA} hype={hype} />
      </div>
      <div className="oi-grid">
        <section className="card-block">
          <h3>Newest spot tokens</h3>
          <div className="chips">
            {recentTokens.map((t) => (
              <span key={t.index} title={t.fullName ?? undefined}>
                {t.name} <span className="muted small">#{t.index}</span>
              </span>
            ))}
          </div>
        </section>
        <section className="card-block">
          <h3>Newest HIP-3 dexes</h3>
          <div className="chips">
            {dexes.map((d) => (
              <span key={d.name}>
                {d.fullName || d.name} <span className="muted small">{d.name}</span>
              </span>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function AuctionCard({ title, a, hype }: { title: string; a: GasAuction | null; hype: number }) {
  if (!a) return <section className="card-block muted">Loading {title}…</section>;
  const end = (a.startTimeSeconds + a.durationSeconds) * 1000;
  const left = end - Date.now();
  const live = a.currentGas !== null && left > 0;
  const fmtLeft = (ms: number) => {
    const h = Math.floor(ms / 3600_000);
    const m = Math.floor((ms % 3600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${h}h ${m}m ${s}s`;
  };
  const px = Number(a.currentGas ?? 0);
  return (
    <section className="card-block auction">
      <h3>{title}</h3>
      {live ? (
        <>
          <div className="big-num">{px.toLocaleString()} HYPE</div>
          {hype > 0 && <div className="muted">≈ {fmtUsd(px * hype)}</div>}
          <div className="small">
            Started at {Number(a.startGas).toLocaleString()} HYPE, floor {Number(a.endGas ?? 0).toLocaleString()} HYPE · round ends in {fmtLeft(left)}
          </div>
          <div className="progress">
            <div style={{ width: `${Math.min(100, ((Date.now() - a.startTimeSeconds * 1000) / (a.durationSeconds * 1000)) * 100)}%` }} />
          </div>
        </>
      ) : (
        <>
          <div className="big-num muted">{left > 0 ? 'Won this round' : 'Between rounds'}</div>
          <div className="small">
            {left > 0 ? `The next round opens in ${fmtLeft(left)} (${new Date(end).toLocaleString()}).` : 'A new round should open shortly.'} The last round started at{' '}
            {Number(a.startGas).toLocaleString()} HYPE.
          </div>
        </>
      )}
    </section>
  );
}
