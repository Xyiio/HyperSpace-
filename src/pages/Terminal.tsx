import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchFills, isAddress, type Fill, type Interval, type Market } from '../hl/api';
import { ChartPanel, type ChartApi, type ChartLine } from '../components/ChartPanel';
import { BookLadder } from '../components/BookLadder';
import { TradeTape } from '../components/TradeTape';
import { OrderTicket, type HotkeySettings, type StagedLevels } from '../components/OrderTicket';
import { AccountPanel } from '../components/AccountPanel';
import { ChartTools, useIndicators, usePersistent } from '../components/ChartTools';
import { Watchlist } from '../components/Watchlist';
import { MiniChart } from '../components/MiniChart';
import { DEFAULT_STYLE, type ChartStyle } from '../hl/chartStyle';
import type { Prediction } from '../hl/predict';
import type { Drawing, DrawingKind } from '../hl/drawings';
import { loadDrawings, saveDrawings } from '../hl/drawings';
import type { LiqStats } from '../hl/liqmap';
import { MarketBar } from '../components/MarketBar';
import { fmtCompact, fmtUsd, shortAddr } from '../hl/stats';
import { IS_TESTNET } from '../hl/network';
import { useWallet } from '../wallet/WalletContext';
import { useAccount } from '../wallet/useAccount';
import { cancelAll, closePosition, isTpsl, linePrice, marketOrder, moveOrder, reversePosition, tpslKind } from '../wallet/actions';
import { floorSize } from '../hl/orders';
import { addAlert } from '../alerts/store';
import { notify } from '../alerts/notify';
import { decodeSnapshot, encodeSnapshot, snapshotUrl, type Snapshot } from '../hl/snapshot';
import { currentLimits, limitMessage } from '../token/premium';

const GROUPINGS: { label: string; value: number | null }[] = [
  { label: 'Tick', value: null },
  { label: '5 sig figs', value: 5 },
  { label: '4 sig figs', value: 4 },
  { label: '3 sig figs', value: 3 },
];

// Size a "large trade" relative to the market's daily volume.
const defaultBigTrade = (m: Market) => {
  const v = Number(m.ctx.dayNtlVlm) / 20_000;
  const steps = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000];
  return steps.find((s) => s >= v) ?? 500_000;
};

type Layout = 1 | 2 | 4;
interface MiniCfg {
  coin: string;
  interval: Interval;
}
interface SavedLayout {
  name: string;
  layout: Layout;
  minis: MiniCfg[];
}

interface Props {
  markets: Market[];
  coin: string;
  overlay: string | null;
  vs: string | null;
  snap: string | null;
  onRoute: (hash: string) => void;
}

export function Terminal({ markets, coin, overlay, vs, snap, onRoute }: Props) {
  const market = useMemo(() => markets.find((m) => m.name === coin) ?? markets.find((m) => m.name.toLowerCase() === coin.toLowerCase()) ?? markets[0], [markets, coin]);
  const vsMarket = useMemo(() => (vs ? (markets.find((m) => m.name === vs) ?? null) : null), [markets, vs]);
  const ratio = vsMarket && vsMarket.name !== market.name ? vsMarket.name : null;
  const w = useWallet();
  const account = useAccount(market.dex);
  const [interval, setTf] = useState<Interval>('1m');
  const [nSigFigs, setNSigFigs] = useState<number | null>(4);
  const [heatmap, setHeatmap] = useState(true);
  const [bigTrade, setBigTrade] = useState(() => defaultBigTrade(market));
  const [price, setPrice] = useState<number | null>(null);
  const [wallet, setWallet] = useState(overlay ?? '');
  const [fills, setFills] = useState<Fill[] | null>(null);
  const [fillsMsg, setFillsMsg] = useState('');
  const [indicators, setIndicators] = useIndicators();
  const [tool, setTool] = useState<DrawingKind | null>(null);
  const [clearDrawings, setClearDrawings] = useState(0);
  const [liqMap, setLiqMap] = useState(false);
  const [liqStats, setLiqStats] = useState<LiqStats | null>(null);
  const [drawColor, setDrawColor] = usePersistent('hs.drawColor', '#f5c542');
  const [chartStyle, setChartStyle] = usePersistent<ChartStyle>('hs.chartStyle', DEFAULT_STYLE);
  const [volProfile, setVolProfile] = usePersistent('hs.volProfile', false);
  const [predict, setPredict] = usePersistent('hs.prediction', false);
  const [pred, setPred] = useState<Prediction | null>(null);
  const [wlSide, setWlSide] = usePersistent<'left' | 'right'>('hs.watchlistSide', 'left');
  const [wlOpen, setWlOpen] = usePersistent('hs.watchlistOpen', true);
  const [hotkeys, setHotkeys] = usePersistent<HotkeySettings>('hs.hotkeys', { enabled: false, usd: 100 });
  const [layout, setLayout] = usePersistent<Layout>('hs.layout', 1);
  const [minis, setMinis] = usePersistent<MiniCfg[]>('hs.miniCharts', [
    { coin: 'ETH', interval: '15m' },
    { coin: 'HYPE', interval: '15m' },
    { coin: 'SOL', interval: '15m' },
  ]);
  const [saved, setSaved] = usePersistent<SavedLayout[]>('hs.savedLayouts', []);
  const [staged, setStaged] = useState<StagedLevels | null>(null);
  const [flash, setFlash] = useState('');
  const [pendingMove, setPendingMove] = useState<{ oid: number; price: number; label: string } | null>(null);
  const [shared, setShared] = useState<Snapshot | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const chartApi = useRef<ChartApi | null>(null);

  useEffect(() => {
    setBigTrade(defaultBigTrade(market));
    setPrice(null);
    setPendingMove(null);
  }, [market.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = (t: string) => {
    setFlash(t);
    window.setTimeout(() => setFlash((f) => (f === t ? '' : f)), 6000);
  };

  // A shared snapshot link: open its timeframe and show its drawings read-only.
  useEffect(() => {
    if (!snap) return setShared(null);
    decodeSnapshot(snap).then((s) => {
      setShared(s);
      if (s) setTf(s.interval);
    });
  }, [snap]);

  // Load a wallet's fills to overlay on the chart.
  useEffect(() => {
    if (!overlay || !isAddress(overlay)) {
      setFills(null);
      setFillsMsg('');
      return;
    }
    const ac = new AbortController();
    setFillsMsg('Loading fills…');
    fetchFills(overlay, ac.signal)
      .then((f) => {
        setFills(f);
        const here = f.filter((x) => x.coin === market.name).length;
        setFillsMsg(`${here} fills on ${market.name} from ${shortAddr(overlay)}`);
      })
      .catch((e) => !ac.signal.aborted && setFillsMsg(`Could not load fills: ${e.message}`));
    return () => ac.abort();
  }, [overlay, market.name]);

  const go = (c: string, o: string | null = overlay, v: string | null = ratio) => onRoute(`#/trade/${c}${o || v ? '?' : ''}${[o && `wallet=${o}`, v && `vs=${v}`].filter(Boolean).join('&')}`);

  // ---------- Lines on the chart ----------
  const position = account?.positions.find((p) => p.coin === market.name) ?? null;
  const lines = useMemo((): ChartLine[] => {
    if (ratio) return [];
    const out: ChartLine[] = [];
    if (position) {
      const long = position.szi > 0;
      out.push({ id: 'entry', price: position.entryPx, color: long ? chartStyle.up : chartStyle.down, title: `${long ? 'Long' : 'Short'} ${Math.abs(position.szi)} · ${fmtUsd(position.unrealizedPnl, 0)}`, width: 2 });
      if (position.liquidationPx) out.push({ id: 'liq', price: position.liquidationPx, color: '#facc15', title: 'Liquidation', style: 'dotted', width: 2 });
    }
    for (const o of account?.orders ?? []) {
      if (o.coin !== market.name) continue;
      const tpsl = isTpsl(o);
      const kind = tpsl ? tpslKind(o) : null;
      out.push({
        id: `o:${o.oid}`,
        price: linePrice(o),
        color: kind === 'tp' ? '#22d3ee' : kind === 'sl' ? '#fb923c' : o.side === 'B' ? chartStyle.up : chartStyle.down,
        title: kind === 'tp' ? `TP ${o.sz}` : kind === 'sl' ? `SL ${o.sz}` : `${o.side === 'B' ? 'Buy' : 'Sell'} ${o.sz}`,
        style: 'dashed',
        draggable: w.tradingReady && o.triggerCondition !== 'Waits for entry to fill',
      });
    }
    if (staged) {
      const c = staged.isBuy ? chartStyle.up : chartStyle.down;
      if (staged.entry && !staged.ladder.length) out.push({ id: 's:entry', price: staged.entry, color: c, title: 'New order', style: 'dotted' });
      staged.ladder.forEach((p, i) => out.push({ id: `s:l${i}`, price: p, color: c, title: i === 0 ? 'Ladder' : '', style: 'dotted' }));
      if (staged.tp) out.push({ id: 's:tp', price: staged.tp, color: '#22d3ee', title: 'New TP', style: 'dotted' });
      if (staged.sl) out.push({ id: 's:sl', price: staged.sl, color: '#fb923c', title: 'New SL', style: 'dotted' });
    }
    return out;
  }, [account, position, market.name, staged, chartStyle.up, chartStyle.down, w.tradingReady, ratio]);

  const doMove = async (oid: number, px: number) => {
    const o = account?.orders.find((x) => x.oid === oid);
    if (!o) return;
    say(await moveOrder(w, market, o, px));
  };
  const onDragLine = (id: string, px: number) => {
    if (!id.startsWith('o:')) return;
    const oid = Number(id.slice(2));
    const o = account?.orders.find((x) => x.oid === oid);
    if (!o) return;
    const label = isTpsl(o) ? (tpslKind(o) === 'tp' ? 'take-profit' : 'stop') : 'order';
    // Real-money moves get a confirm, like orders from the ticket.
    if (!IS_TESTNET && !w.paper) setPendingMove({ oid, price: px, label });
    else void doMove(oid, px);
  };

  // ---------- Hotkeys ----------
  const hk = useRef({ hotkeys, account, market, markets, w });
  hk.current = { hotkeys, account, market, markets, w };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { hotkeys: h, account: acc, market: m, markets: ms, w: wl } = hk.current;
      if (!h.enabled || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      const typing = el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable || (el?.tagName === 'INPUT' && !['checkbox', 'radio', 'button'].includes((el as HTMLInputElement).type));
      if (typing) return;
      if (!wl.tradingReady) return say('Hotkeys: enable trading or turn on paper trading first.');
      const k = e.key.toUpperCase();
      const pos = acc?.positions.find((p) => p.coin === m.name);
      const sz = floorSize(h.usd / Number(m.ctx.markPx), m.szDecimals);
      const act: Record<string, (() => Promise<string>) | undefined> = {
        B: () => marketOrder(wl, m, true, sz),
        S: () => marketOrder(wl, m, false, sz),
        C: pos ? () => closePosition(wl, ms, pos) : async () => `No ${m.name} position to close.`,
        R: pos ? () => reversePosition(wl, ms, pos) : async () => `No ${m.name} position to reverse.`,
        X: () => cancelAll(wl, ms, (acc?.orders ?? []).filter((o) => o.coin === m.name)),
      };
      const f = act[k];
      if (!f) return;
      e.preventDefault();
      if ((k === 'B' || k === 'S') && sz * Number(m.ctx.markPx) < 10) return say('Hotkey size is below the $10 minimum.');
      void f().then((t) => say(`⌨ ${t}`));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---------- Alerts from the chart ----------
  const alertAt = (px: number) => {
    const mark = Number(market.ctx.markPx);
    const err = addAlert({ kind: 'price', coin: market.name, op: px >= mark ? 'above' : 'below', value: Number(px.toPrecision(6)), refPx: mark, repeat: false });
    say(err ?? `Alert set: ${market.name} ${px >= mark ? 'rises to' : 'falls to'} ${Number(px.toPrecision(6))}. Manage alerts on the Alerts page.`);
  };
  const drawingAlert = (d: Drawing) => {
    if (d.kind !== 'hline' && d.kind !== 'trend') return;
    const err = addAlert({ kind: 'drawing', coin: ratio ? undefined : market.name, drawingId: d.id, line: { kind: d.kind, a: d.a, b: d.b }, refPx: Number(market.ctx.markPx), repeat: false });
    say(err ?? `Alert set: ${market.name} crossing this ${d.kind === 'trend' ? 'trend line' : 'line'}.`);
  };

  // ---------- Layouts ----------
  const setMini = (i: number, cfg: MiniCfg) => setMinis((l) => l.map((x, j) => (j === i ? cfg : x)));
  const saveLayout = () => {
    if (saved.length >= currentLimits().savedLayouts) return say(limitMessage('savedLayouts'));
    const name = `Layout ${saved.length + 1}: ${[market.name, ...minis.slice(0, layout - 1).map((m) => m.coin)].join(', ')}`;
    setSaved([...saved, { name, layout, minis: minis.slice() }]);
    say(`Saved "${name}".`);
  };

  // ---------- Snapshot sharing ----------
  const keepShared = () => {
    if (!shared) return;
    const key = shared.vs ? `${shared.coin}/${shared.vs}` : shared.coin;
    saveDrawings(key, [...loadDrawings(key), ...shared.drawings.map((d) => ({ ...d, id: crypto.randomUUID() }))]);
    setShared(null);
    go(market.name);
    notify('Drawings added', `${shared.drawings.length} drawings from the shared chart are now on your ${key} chart.`);
  };

  const watchlist = (
    <Watchlist markets={markets} current={market.name} onMarket={(c) => go(c)} side={wlSide} onSide={setWlSide} onClose={() => setWlOpen(false)} />
  );

  const twapsHere = (account?.twaps ?? []).filter((t) => t.coin === market.name);
  const chartOverlay =
    twapsHere.length || shared ? (
      <>
        {shared && (
          <div className="overlay-card">
            Shared chart from {new Date(shared.at).toLocaleString()} · {shared.drawings.length} drawings{' '}
            <button className="link" onClick={keepShared}>
              Keep the drawings
            </button>{' '}
            ·{' '}
            <button className="link" onClick={() => go(market.name)}>
              Close
            </button>
          </div>
        )}
        {twapsHere.map((t) => (
          <div key={t.id} className="overlay-card">
            TWAP {t.isBuy ? 'buy' : 'sell'} {Number(t.executedSz.toPrecision(5))}/{t.sz} {market.symbol}
            <div className="progress">
              <div style={{ width: `${Math.min(100, (t.executedSz / t.sz) * 100)}%` }} />
            </div>
          </div>
        ))}
      </>
    ) : null;

  return (
    <div className="terminal">
      <MarketBar markets={markets} market={market} onMarket={(c) => go(c)} interval={interval} onInterval={setTf} ratio={ratio} onRatio={(v) => go(market.name, overlay, v)} />
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} disabled={!!ratio} /> Book heatmap
        </label>
        <label className="check" title="Traded volume at each price over the loaded candles, split into buying and selling">
          <input type="checkbox" checked={volProfile} onChange={(e) => setVolProfile(e.target.checked)} /> Volume profile
        </label>
        <label className="check" title="Experimental: a ghost candle from trend, RSI and live order-book imbalance. Not advice.">
          <input type="checkbox" checked={predict} onChange={(e) => setPredict(e.target.checked)} disabled={!!ratio} /> Next-candle prediction (experiment)
        </label>
        <label className="check" title="Estimated from wallets seen trading this market since you opened it">
          <input type="checkbox" checked={liqMap} onChange={(e) => setLiqMap(e.target.checked)} disabled={!!ratio} /> Liquidation map
        </label>
        <label>
          Book grouping
          <select value={String(nSigFigs)} onChange={(e) => setNSigFigs(e.target.value === 'null' ? null : Number(e.target.value))}>
            {GROUPINGS.map((g) => (
              <option key={g.label} value={String(g.value)}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Large trade ≥ $
          <input className="num" inputMode="numeric" value={bigTrade} onChange={(e) => setBigTrade(Number(e.target.value) || 0)} />
        </label>
        <form
          className="overlay-form"
          onSubmit={(e) => {
            e.preventDefault();
            const x = wallet.trim();
            go(market.name, isAddress(x) ? x.toLowerCase() : null);
          }}
        >
          <input placeholder="Overlay a wallet's fills: 0x…" value={wallet} onChange={(e) => setWallet(e.target.value)} />
          <button type="submit">Overlay</button>
          {overlay && (
            <button type="button" className="link" onClick={() => onRoute(`#/wallet/${overlay}`)}>
              View PnL
            </button>
          )}
        </form>
        <span className="layout-pick" title="Charts in view">
          {([1, 2, 4] as Layout[]).map((n) => (
            <button key={n} className={layout === n ? 'on' : ''} onClick={() => setLayout(n)}>
              {n === 1 ? '▢' : n === 2 ? '▢▢' : '▦'}
            </button>
          ))}
          {layout > 1 && (
            <>
              <button className="link small" onClick={saveLayout}>
                Save layout
              </button>
              {saved.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    const l = saved[Number(e.target.value)];
                    if (l) {
                      setLayout(l.layout);
                      setMinis(l.minis);
                    }
                  }}
                >
                  <option value="">Saved layouts…</option>
                  {saved.map((l, i) => (
                    <option key={l.name} value={i}>
                      {l.name}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </span>
        <button onClick={() => setShareOpen(true)} title="Share this chart as an image and a link">
          Share chart
        </button>
        {price !== null && !ratio && (
          <button onClick={() => alertAt(price)} title="Alert when price reaches the staged price">
            🔔 Alert at {Number(price.toPrecision(6))}
          </button>
        )}
        {!wlOpen && (
          <button className="link" onClick={() => setWlOpen(true)}>
            Show watchlist
          </button>
        )}
        {fillsMsg && <span className="muted">{fillsMsg}</span>}
        {predict && pred && !ratio && (
          <span className="small pred-read" title="Score blends trend (EMA 9 vs 21), RSI stretch and resting bid vs ask size near the price. An experiment, not financial advice.">
            Next candle: <span className={pred.c >= pred.o ? 'up' : 'down'}>{pred.c >= pred.o ? 'up' : 'down'}</span>, est. close {pred.c.toPrecision(6)} · confidence{' '}
            {Math.round(Math.min(1, Math.abs(pred.score)) * 100)}%
            {pred.hitRate !== null && (
              <span className="muted">
                {' '}
                · direction right {Math.round(pred.hitRate * 100)}% of the last {pred.tested} bars
              </span>
            )}
          </span>
        )}
        {liqStats && (
          <span className="muted small">
            Liq map: {liqStats.positions} positions from {liqStats.scanned} of {liqStats.wallets} wallets ·{' '}
            <span className="down">longs {fmtCompact(liqStats.longs)}</span> · <span className="up">shorts {fmtCompact(liqStats.shorts)}</span>
            {liqStats.below && (
              <>
                {' '}· biggest long cluster{' '}
                <button className="link" onClick={() => setPrice(liqStats.below!.px)}>
                  {liqStats.below.px} ({liqStats.below.pct.toFixed(1)}%, {fmtCompact(liqStats.below.usd)})
                </button>
              </>
            )}
            {liqStats.above && (
              <>
                {' '}· biggest short cluster{' '}
                <button className="link" onClick={() => setPrice(liqStats.above!.px)}>
                  {liqStats.above.px} (+{liqStats.above.pct.toFixed(1)}%, {fmtCompact(liqStats.above.usd)})
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {(flash || pendingMove) && (
        <div className="flash">
          {pendingMove ? (
            <>
              Move the {pendingMove.label} to {Number(pendingMove.price.toPrecision(6))}?{' '}
              <button
                className="primary small"
                onClick={() => {
                  const p = pendingMove;
                  setPendingMove(null);
                  void doMove(p.oid, p.price);
                }}
              >
                Confirm on mainnet
              </button>{' '}
              <button className="link" onClick={() => setPendingMove(null)}>
                Cancel
              </button>
            </>
          ) : (
            flash
          )}
        </div>
      )}
      <div className={`workspace${wlOpen ? ` wl-${wlSide}` : ''}`}>
        {wlOpen && wlSide === 'left' && watchlist}
        <div className="main-col">
          <ChartTools
            indicators={indicators}
            onIndicators={setIndicators}
            tool={tool}
            onTool={setTool}
            onClearDrawings={() => setClearDrawings((n) => n + 1)}
            drawColor={drawColor}
            onDrawColor={setDrawColor}
            chartStyle={chartStyle}
            onChartStyle={setChartStyle}
          />
          <div className={`chart-grid n${layout}`}>
            <ChartPanel
              market={market}
              interval={interval}
              nSigFigs={nSigFigs}
              heatmap={heatmap && !ratio}
              bigTradeUsd={ratio ? Infinity : bigTrade}
              walletFills={ratio ? null : fills}
              lines={lines}
              onDragLine={onDragLine}
              ratioWith={ratio}
              sharedDrawings={shared && shared.coin === market.name && (shared.vs ?? null) === ratio ? shared.drawings : null}
              onApi={(a) => (chartApi.current = a)}
              onDrawingAlert={ratio ? undefined : drawingAlert}
              overlay={chartOverlay}
              indicators={indicators}
              tool={tool}
              onToolDone={() => setTool(null)}
              clearDrawings={clearDrawings}
              liqMap={liqMap && !ratio}
              onLiqStats={setLiqStats}
              onPricePick={(p) => !ratio && setPrice(p)}
              drawColor={drawColor}
              chartStyle={chartStyle}
              volProfile={volProfile}
              prediction={predict && !ratio}
              onPrediction={setPred}
            />
            {layout > 1 &&
              minis.slice(0, layout - 1).map((cfg, i) => (
                <MiniChart
                  key={i}
                  markets={markets}
                  coin={cfg.coin}
                  interval={cfg.interval}
                  onChange={(c, iv) => setMini(i, { coin: c, interval: iv })}
                  onFocus={(c) => go(c, null, null)}
                  indicators={indicators.filter((x) => x.kind !== 'funding' && x.kind !== 'oi')}
                  chartStyle={chartStyle}
                  drawColor={drawColor}
                />
              ))}
          </div>
          <p className="legend">
            {ratio ? (
              <>
                {market.name} ÷ {ratio}: each bar's open and close are exact, highs and lows are estimated · trading uses the {market.name} chart
              </>
            ) : (
              <>
                <span className="sw bid" /> resting bids <span className="sw ask" /> resting asks, brighter = more size · bubbles = trades ≥ ${bigTrade.toLocaleString()}
                {' '}(yellow ring = liquidation) · click the chart to stage an order · drag order, TP and SL lines to move them
              </>
            )}
          </p>
          <AccountPanel market={market} markets={markets} account={account} onMarket={(c) => go(c, null, null)} />
        </div>
        <div className="side-col">
          <BookLadder market={market} nSigFigs={nSigFigs} onPricePick={setPrice} />
        </div>
        <div className="side-col ticket-col">
          <OrderTicket market={market} price={price} onPrice={setPrice} account={account} onStaged={setStaged} hotkeys={hotkeys} onHotkeys={setHotkeys} />
          <TradeTape market={market} bigTradeUsd={bigTrade} onWallet={(a) => onRoute(`#/wallet/${a}`)} />
        </div>
        {wlOpen && wlSide === 'right' && watchlist}
      </div>
      {shareOpen && (
        <ShareChart
          onClose={() => setShareOpen(false)}
          make={async () => {
            const api = chartApi.current;
            const canvas = api?.screenshot() ?? null;
            const code = await encodeSnapshot({ coin: market.name, vs: ratio, interval, drawings: api?.drawings() ?? [], indicators });
            return { canvas, url: snapshotUrl(code, market.name) + (ratio ? '' : ''), title: `${ratio ? `${market.name}/${ratio}` : market.name} ${interval}` };
          }}
        />
      )}
    </div>
  );
}

function ShareChart({ make, onClose }: { make: () => Promise<{ canvas: HTMLCanvasElement | null; url: string; title: string }>; onClose: () => void }) {
  const [data, setData] = useState<{ img: string | null; url: string; title: string } | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    make().then(({ canvas, url, title }) => setData({ img: canvas ? withBrand(canvas, title) : null, url, title }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const copy = async (what: 'link' | 'image') => {
    if (!data) return;
    try {
      if (what === 'link') await navigator.clipboard.writeText(data.url);
      else {
        const blob = await (await fetch(data.img!)).blob();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      }
      setMsg(what === 'link' ? 'Link copied.' : 'Image copied.');
    } catch {
      setMsg('Copy is blocked in this browser; select the link or download the image.');
    }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal" role="dialog" aria-label="Share chart">
        <h3>Share this chart</h3>
        {!data ? (
          <div className="muted">Preparing…</div>
        ) : (
          <>
            {data.img && <img className="share-canvas" src={data.img} alt={`Chart of ${data.title}`} />}
            <label className="share-link">
              Link that opens this chart and its drawings in HyperSpace
              <input readOnly value={data.url} onFocus={(e) => e.target.select()} />
            </label>
            <div className="modal-actions">
              <button className="primary" onClick={() => void copy('link')}>
                Copy link
              </button>
              {data.img && (
                <>
                  <button onClick={() => void copy('image')}>Copy image</button>
                  <a className="btn" href={data.img} download={`hyperspace-${data.title.replace(/[^A-Za-z0-9]+/g, '-')}.png`}>
                    Download image
                  </a>
                </>
              )}
              <a className="btn" href={`https://x.com/intent/post?text=${encodeURIComponent(`${data.title} on HyperSpace`)}&url=${encodeURIComponent(data.url)}`} target="_blank" rel="noreferrer">
                Post on X
              </a>
              <button className="link" onClick={onClose}>
                Close
              </button>
              {msg && <span className="small muted">{msg}</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Adds a small HyperSpace caption under the chart screenshot. */
function withBrand(chart: HTMLCanvasElement, title: string): string {
  const pad = 36;
  const c = document.createElement('canvas');
  c.width = chart.width;
  c.height = chart.height + pad;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#070a0e';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(chart, 0, 0);
  ctx.fillStyle = '#c4b5fd';
  ctx.font = '600 15px system-ui, sans-serif';
  ctx.fillText('HYPERSPACE', 12, chart.height + 24);
  ctx.fillStyle = '#7c8a9c';
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText(`${title} · ${new Date().toLocaleString()}`, 130, chart.height + 24);
  return c.toDataURL('image/png');
}
