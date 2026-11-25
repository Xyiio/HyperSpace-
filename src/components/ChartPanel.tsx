import { useEffect, useRef, useState } from 'react';
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { fetchCandles, INTERVAL_MS, type Fill, type OpenOrder, type Interval, type L2Book, type Market, type RawCandle, type Trade } from '../hl/api';
import { hlSocket } from '../hl/ws';
import { HeatmapPrimitive, TimeMapper, TradeBubblesPrimitive } from '../hl/primitives';
import { bookToSnapshot, priceDecimals } from '../hl/stats';
import { bollinger, ema, macd, rsi, sma, vwap, type Candle, type IndicatorConfig } from '../hl/indicators';
import { LiquidationPrimitive, LiquidationScanner, bucketLiquidations, niceStep, type LiqStats } from '../hl/liqmap';
import { DRAWING_INFO, DRAW_COLORS, DrawingsPrimitive, loadDrawings, saveDrawings, type Drawing, type DrawingKind } from '../hl/drawings';
import { isLight, withAlpha, type ChartStyle } from '../hl/chartStyle';
import { GhostCandlePrimitive, bookImbalance, predictNext, type Prediction } from '../hl/predict';
import { VolumeProfilePrimitive, loadBookHistory, saveBookHistory, thinSnapshots, volumeProfile } from '../hl/profile';

const SNAPSHOT_EVERY_MS = 1000;
const MAX_BUBBLES = 600;

interface Props {
  market: Market;
  interval: Interval;
  nSigFigs: number | null;
  heatmap: boolean;
  bigTradeUsd: number;
  walletFills: Fill[] | null;
  openOrders?: OpenOrder[];
  indicators: IndicatorConfig[];
  tool: DrawingKind | null;
  onToolDone: () => void;
  clearDrawings: number;
  liqMap: boolean;
  onLiqStats: (s: LiqStats | null) => void;
  onPricePick: (px: number) => void;
  drawColor: string;
  chartStyle: ChartStyle;
  volProfile: boolean;
  prediction: boolean;
  onPrediction: (p: Prediction | null) => void;
}

const toBar = (c: RawCandle) => ({
  time: Math.floor(c.t / 1000) as UTCTimestamp,
  open: Number(c.o),
  high: Number(c.h),
  low: Number(c.l),
  close: Number(c.c),
});

const toCandle = (c: RawCandle): Candle => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v });

const toVol = (c: RawCandle, st: ChartStyle) => ({
  time: Math.floor(c.t / 1000) as UTCTimestamp,
  value: Number(c.v),
  color: withAlpha(Number(c.c) >= Number(c.o) ? st.up : st.down, 0.35),
});

const CLEAR = 'rgba(0,0,0,0)';
type AltSeries = ISeriesApi<'Bar'> | ISeriesApi<'Line'> | ISeriesApi<'Area'>;

export function ChartPanel({
  market,
  interval,
  nSigFigs,
  heatmap,
  bigTradeUsd,
  walletFills,
  openOrders,
  indicators,
  tool,
  onToolDone,
  clearDrawings,
  liqMap,
  onLiqStats,
  onPricePick,
  drawColor,
  chartStyle,
  volProfile,
  prediction,
  onPrediction,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // Set when the chart is torn down, so late timers and other effects' cleanups leave it alone.
  const disposedRef = useRef(false);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const mapperRef = useRef(new TimeMapper());
  const heatRef = useRef<HeatmapPrimitive | null>(null);
  const bubblesRef = useRef<TradeBubblesPrimitive | null>(null);
  const pickRef = useRef(onPricePick);
  pickRef.current = onPricePick;
  const candlesRef = useRef<Candle[]>([]);
  const indicatorsRef = useRef(indicators);
  indicatorsRef.current = indicators;
  const indSeriesRef = useRef(new Map<string, ISeriesApi<'Line' | 'Histogram'>[]>());
  const drawRef = useRef<DrawingsPrimitive | null>(null);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const toolDoneRef = useRef(onToolDone);
  toolDoneRef.current = onToolDone;
  const coinRef = useRef(market.name);
  coinRef.current = market.name;
  const recalcRef = useRef<() => void>(() => {});
  const liqRef = useRef<LiquidationPrimitive | null>(null);
  const liqStatsRef = useRef(onLiqStats);
  liqStatsRef.current = onLiqStats;
  const [status, setStatus] = useState<string>('Loading candles…');
  const styleRef = useRef(chartStyle);
  styleRef.current = chartStyle;
  const drawColorRef = useRef(drawColor);
  drawColorRef.current = drawColor;
  // Bars, line and area styles draw on this extra series; the candle series stays (transparent)
  // because the overlays and drawings are attached to it.
  const altRef = useRef<AltSeries | null>(null);
  const ghostRef = useRef<GhostCandlePrimitive | null>(null);
  const profileRef = useRef<VolumeProfilePrimitive | null>(null);
  const lastBookRef = useRef<L2Book | null>(null);
  const predCbRef = useRef(onPrediction);
  predCbRef.current = onPrediction;
  // The selected drawing (for the colour / delete bar) and the open text editor.
  const [sel, setSel] = useState<Drawing | null>(null);
  const [textEdit, setTextEdit] = useState<{ id: string; x: number; y: number; value: string; isNew: boolean } | null>(null);
  const uiRef = useRef({ setSel, setTextEdit });
  uiRef.current = { setSel, setTextEdit };

  // Create the chart once.
  useEffect(() => {
    const host = hostRef.current!;
    const chart = createChart(host, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0b0f14' },
        textColor: '#8b98a9',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        attributionLogo: true,
      },
      grid: { vertLines: { color: '#141b24' }, horzLines: { color: '#141b24' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1c2530' },
      timeScale: { borderColor: '#1c2530', timeVisible: true, secondsVisible: false, rightOffset: 8 },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#34d399',
      downColor: '#f87171',
      borderVisible: false,
      wickUpColor: '#34d399',
      wickDownColor: '#f87171',
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    const heat = new HeatmapPrimitive(mapperRef.current);
    const bubbles = new TradeBubblesPrimitive(mapperRef.current);
    series.attachPrimitive(heat);
    series.attachPrimitive(bubbles);
    markersRef.current = createSeriesMarkers(series, []);
    const draw = new DrawingsPrimitive(mapperRef.current);
    series.attachPrimitive(draw);
    const liq = new LiquidationPrimitive(mapperRef.current);
    series.attachPrimitive(liq);
    liqRef.current = liq;
    const ghost = new GhostCandlePrimitive(mapperRef.current);
    series.attachPrimitive(ghost);
    ghostRef.current = ghost;
    const profile = new VolumeProfilePrimitive(mapperRef.current);
    series.attachPrimitive(profile);
    profileRef.current = profile;

    const toPoint = (x: number, y: number) => {
      const l = chart.timeScale().coordinateToLogical(x);
      const p = series.coordinateToPrice(y);
      const t = l === null ? null : mapperRef.current.timeAt(l);
      return t === null || p === null ? null : { t, p };
    };
    const persist = () => saveDrawings(coinRef.current, draw.drawings);

    const select = (id: string | null) => {
      draw.selected = id;
      draw.update();
      uiRef.current.setSel(id ? { ...draw.drawings.find((d) => d.id === id)! } : null);
    };
    const openText = (d: Drawing, isNew: boolean) => {
      const x = draw.x(d.a.t);
      const y = draw.y(d.a.p);
      if (x === null || y === null) return;
      uiRef.current.setTextEdit({ id: d.id, x, y, value: d.text ?? '', isNew });
    };
    const colorFor = (kind: DrawingKind) =>
      kind === 'arrowUp' ? styleRef.current.up : kind === 'arrowDown' ? styleRef.current.down : drawColorRef.current;

    // Placing drawing points uses native pointer events: lightweight-charts drops the second of two
    // quick clicks (it treats them as a double-click), which lost the end point of trend lines and fibs.
    let placedAt = 0;
    let down: { x: number; y: number } | null = null;
    const local = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inPricePane = (x: number, y: number) => x >= 0 && x <= chart.timeScale().width() && y >= 0 && y <= chart.panes()[0].getHeight();
    const onDown = (e: PointerEvent) => {
      const kind = toolRef.current;
      down = kind && e.button === 0 ? local(e) : null;
      if (kind !== 'pen' || !down || !inPricePane(down.x, down.y)) return;
      // Freehand: start a path and follow the pointer until release.
      const pt = toPoint(down.x, down.y);
      if (!pt) return;
      host.setPointerCapture(e.pointerId);
      draw.draft = { id: crypto.randomUUID(), kind: 'pen', a: pt, b: pt, color: colorFor('pen'), pts: [pt] };
      draw.update();
    };
    let lastPen = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      if (draw.draft?.kind !== 'pen' || !down) return;
      const { x, y } = local(e);
      if (Math.hypot(x - lastPen.x, y - lastPen.y) < 3) return;
      lastPen = { x, y };
      const pt = toPoint(x, y);
      if (!pt) return;
      draw.draft.pts!.push(pt);
      draw.draft.b = pt;
      draw.update();
    };
    const onUp = (e: PointerEvent) => {
      const kind = toolRef.current;
      const start = down;
      down = null;
      if (!kind || !start) return;
      if (kind === 'pen') {
        const d = draw.draft;
        draw.draft = null;
        if (d?.kind === 'pen' && (d.pts?.length ?? 0) > 1) {
          draw.drawings.push(d);
          persist();
          placedAt = performance.now();
          toolDoneRef.current();
        }
        draw.update();
        return;
      }
      const { x, y } = local(e);
      // Ignore drags (panning) and clicks outside the main price pane.
      if (Math.hypot(x - start.x, y - start.y) > 5) return;
      if (!inPricePane(x, y)) return;
      const pt = toPoint(x, y);
      if (!pt) return;
      if (draw.draft && draw.draft.kind !== kind) draw.draft = null;
      placedAt = performance.now();
      if (!draw.draft) {
        const d: Drawing = { id: crypto.randomUUID(), kind, a: pt, b: pt, color: colorFor(kind) };
        if (DRAWING_INFO[kind].place === 'one') {
          if (kind === 'text') d.text = '';
          draw.drawings.push(d);
          if (kind === 'text') openText(d, true);
          else persist();
          toolDoneRef.current();
        } else draw.draft = d;
      } else {
        draw.draft.b = pt;
        draw.drawings.push(draw.draft);
        draw.draft = null;
        persist();
        toolDoneRef.current();
      }
      draw.update();
    };
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('pointermove', onMove);
    host.addEventListener('pointerup', onUp);

    // With no tool: select a drawing under the cursor, otherwise stage an order at that price.
    chart.subscribeClick((p) => {
      // The click that finished a drawing must not also select something or stage an order.
      if (!p.point || toolRef.current || performance.now() - placedAt < 400) return;
      const hit = draw.hit(p.point.x, p.point.y);
      select(hit);
      if (hit) return;
      const px = series.coordinateToPrice(p.point.y);
      if (px !== null) pickRef.current(px);
    });
    // Double-click a text box to edit it.
    chart.subscribeDblClick((p) => {
      if (!p.point || toolRef.current) return;
      const hit = draw.hit(p.point.x, p.point.y);
      const d = draw.drawings.find((x) => x.id === hit);
      if (d?.kind === 'text') openText(d, false);
    });
    chart.subscribeCrosshairMove((p) => {
      if (!draw.draft || draw.draft.kind === 'pen' || !p.point) return;
      const pt = toPoint(p.point.x, p.point.y);
      if (pt) {
        draw.draft.b = pt;
        draw.update();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && draw.selected) {
        draw.drawings = draw.drawings.filter((d) => d.id !== draw.selected);
        persist();
        select(null);
      } else if (e.key === 'Escape') {
        draw.draft = null;
        select(null);
        toolDoneRef.current();
      }
    };
    window.addEventListener('keydown', onKey);

    // ?debug exposes internals for the e2e script.
    if (location.search.includes("debug")) (window as any).__hl = { chart, series, mapper: mapperRef.current, heat, bubbles };
    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;
    heatRef.current = heat;
    bubblesRef.current = bubbles;
    drawRef.current = draw;
    disposedRef.current = false;
    return () => {
      window.removeEventListener('keydown', onKey);
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerup', onUp);
      indSeriesRef.current.clear();
      disposedRef.current = true;
      // React runs the other effects' cleanups after this one, and some of them touch series
      // (price lines, markers). Remove the chart once they have finished.
      queueMicrotask(() => chart.remove());
      chartRef.current = seriesRef.current = volRef.current = heatRef.current = bubblesRef.current = null;
      altRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Candles: snapshot then live stream.
  useEffect(() => {
    const series = seriesRef.current!;
    const vol = volRef.current!;
    const mapper = mapperRef.current;
    const ac = new AbortController();
    let unsub: (() => void) | null = null;
    const dec = priceDecimals(Number(market.ctx.markPx), market.szDecimals);
    series.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove: 10 ** -dec } });
    mapper.intervalMs = INTERVAL_MS[interval];
    mapper.barTimesMs = [];
    candlesRef.current = [];
    let pending = false;
    let recalcTimer: number | undefined;
    const scheduleRecalc = () => {
      if (pending) return;
      pending = true;
      recalcTimer = window.setTimeout(() => {
        pending = false;
        if (!disposedRef.current) recalcRef.current();
      }, 1000);
    };
    series.setData([]);
    vol.setData([]);
    setAltData(altRef.current, []);
    setStatus('Loading candles…');

    // 1m needs ~1,500 bars so the daily VWAP covers the whole UTC day.
    fetchCandles(market.name, interval, interval === '1m' ? 1500 : 500, ac.signal)
      .then((candles) => {
        if (ac.signal.aborted) return;
        series.setData(candles.map(toBar));
        vol.setData(candles.map((c) => toVol(c, styleRef.current)));
        setAltData(altRef.current, candles.map(toBar));
        mapper.barTimesMs = candles.map((c) => c.t);
        candlesRef.current = candles.map(toCandle);
        recalcRef.current();
        chartRef.current?.timeScale().scrollToRealTime();
        setStatus('');
        unsub = hlSocket.subscribe({ type: 'candle', coin: market.name, interval }, (c: RawCandle) => {
          series.update(toBar(c));
          vol.update(toVol(c, styleRef.current));
          updateAlt(altRef.current, toBar(c));
          const bars = mapper.barTimesMs;
          if (bars.length === 0 || c.t > bars[bars.length - 1]) bars.push(c.t);
          const ks = candlesRef.current;
          if (ks.length && ks[ks.length - 1].t === c.t) ks[ks.length - 1] = toCandle(c);
          else if (!ks.length || c.t > ks[ks.length - 1].t) ks.push(toCandle(c));
          scheduleRecalc();
        });
      })
      .catch((e) => {
        if (!ac.signal.aborted) setStatus(`Could not load candles: ${e.message}`);
      });
    return () => {
      ac.abort();
      unsub?.();
      window.clearTimeout(recalcTimer);
    };
  }, [market.name, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  // Order-book heatmap: one column per second. History is saved in this browser per market and
  // grouping, so it keeps building across visits (up to 24 hours).
  useEffect(() => {
    const heat = heatRef.current!;
    heat.snapshots = [];
    heat.update();
    const coin = market.name;
    let alive = true;
    let loaded = false;
    loadBookHistory(coin, nSigFigs).then((hist) => {
      if (!alive) return;
      const first = heat.snapshots[0]?.t ?? Infinity;
      heat.snapshots = [...hist.filter((s) => s.t < first), ...heat.snapshots];
      loaded = true;
      heat.update();
    });
    const save = () => {
      if (loaded && heat.snapshots.length) void saveBookHistory(coin, nSigFigs, heat.snapshots);
    };
    // Thin old columns and save every 30 seconds.
    const timer = window.setInterval(() => {
      heat.snapshots = thinSnapshots(heat.snapshots);
      save();
    }, 30_000);
    let lastT = 0;
    const unsub = hlSocket.subscribe({ type: 'l2Book', coin, nSigFigs }, (book: L2Book) => {
      lastBookRef.current = book;
      const now = Date.now();
      if (now - lastT < SNAPSHOT_EVERY_MS) return;
      lastT = now;
      heat.snapshots.push(bookToSnapshot(book, now));
      heat.update();
    });
    const onHide = () => save();
    window.addEventListener('pagehide', onHide);
    return () => {
      alive = false;
      save();
      unsub();
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      lastBookRef.current = null;
    };
  }, [market.name, nSigFigs]);

  useEffect(() => {
    const heat = heatRef.current!;
    heat.enabled = heatmap;
    heat.update();
  }, [heatmap]);

  // Large-trade bubbles.
  useEffect(() => {
    const bubbles = bubblesRef.current!;
    bubbles.trades = [];
    bubbles.threshold = bigTradeUsd;
    bubbles.update();
    return hlSocket.subscribe({ type: 'trades', coin: market.name }, (trades: Trade[]) => {
      let added = false;
      for (const t of trades) {
        const notional = Number(t.px) * Number(t.sz);
        if (notional < bigTradeUsd) continue;
        bubbles.trades.push({ t: t.time, px: Number(t.px), notional, buy: t.side === 'B' });
        added = true;
      }
      if (!added) return;
      if (bubbles.trades.length > MAX_BUBBLES) bubbles.trades.splice(0, bubbles.trades.length - MAX_BUBBLES);
      bubbles.update();
    });
  }, [market.name, bigTradeUsd]);

  // Indicators: rebuild series when the list changes; recompute values on new candles.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = indSeriesRef.current;
    map.forEach((list) => list.forEach((s) => chart.removeSeries(s)));
    map.clear();
    // Drop panes left empty by removed oscillators (pane 0 holds the candles).
    for (const pane of [...chart.panes()].reverse()) {
      if (pane.paneIndex() > 0 && pane.getSeries().length === 0) chart.removePane(pane.paneIndex());
    }
    let nextPane = 1;
    const line = (pane: number, color: string, width: 1 | 2 = 1, title = '') =>
      chart.addSeries(LineSeries, { color, lineWidth: width, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false, title }, pane);
    for (const cfg of indicators) {
      const list: ISeriesApi<'Line' | 'Histogram'>[] = [];
      if (cfg.kind === 'sma' || cfg.kind === 'ema' || cfg.kind === 'vwap') list.push(line(0, cfg.color, 2));
      else if (cfg.kind === 'bb') list.push(line(0, cfg.color), line(0, cfg.color, 1), line(0, cfg.color));
      else if (cfg.kind === 'rsi') {
        const pane = nextPane++;
        const s = line(pane, cfg.color, 2, `RSI ${cfg.params[0]}`);
        s.createPriceLine({ price: 70, color: '#3a4655', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
        s.createPriceLine({ price: 30, color: '#3a4655', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
        list.push(s);
      } else if (cfg.kind === 'macd') {
        const pane = nextPane++;
        list.push(
          chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane),
          line(pane, cfg.color, 2, 'MACD'),
          line(pane, '#94a3b8', 1, 'Signal'),
        );
      }
      map.set(cfg.id, list);
    }
    for (const pane of chart.panes()) if (pane.paneIndex() > 0) pane.setHeight(110);
    recalcRef.current();
  }, [indicators]);

  recalcRef.current = () => {
    if (disposedRef.current) return;
    const ks = candlesRef.current;
    if (!ks.length) return;
    const ghost = ghostRef.current;
    if (ghost?.enabled) {
      const book = lastBookRef.current;
      const mid = ks[ks.length - 1].c;
      const imb = book ? bookImbalance(book.levels[0].map((l) => [+l.px, +l.sz]), book.levels[1].map((l) => [+l.px, +l.sz]), mid) : 0;
      ghost.prediction = predictNext(ks, INTERVAL_MS[interval], imb);
      ghost.update();
      predCbRef.current(ghost.prediction);
    }
    const prof = profileRef.current;
    if (prof?.enabled) {
      prof.profile = volumeProfile(ks);
      prof.update();
    }
    const closes = ks.map((k) => k.c);
    const time = (i: number) => (ks[i].t / 1000) as UTCTimestamp;
    const toLine = (vals: number[]) => vals.map((v, i) => (Number.isFinite(v) ? { time: time(i), value: v } : { time: time(i) }));
    for (const cfg of indicatorsRef.current) {
      const list = indSeriesRef.current.get(cfg.id);
      if (!list) continue;
      const [a, b, c] = cfg.params;
      if (cfg.kind === 'sma') list[0].setData(toLine(sma(closes, a)));
      else if (cfg.kind === 'ema') list[0].setData(toLine(ema(closes, a)));
      else if (cfg.kind === 'vwap') list[0].setData(toLine(vwap(ks)));
      else if (cfg.kind === 'bb') {
        const r = bollinger(closes, a, b);
        list[0].setData(toLine(r.upper));
        list[1].setData(toLine(r.mid));
        list[2].setData(toLine(r.lower));
      } else if (cfg.kind === 'rsi') list[0].setData(toLine(rsi(closes, a)));
      else if (cfg.kind === 'macd') {
        const r = macd(closes, a, b, c);
        list[0].setData(
          r.hist.map((v, i) =>
            Number.isFinite(v) ? { time: time(i), value: v, color: v >= 0 ? 'rgba(52,211,153,0.6)' : 'rgba(248,113,113,0.6)' } : { time: time(i) },
          ),
        );
        list[1].setData(toLine(r.line));
        list[2].setData(toLine(r.signal));
      }
    }
  };

  // Liquidation map: scan wallets seen trading this market while the toggle is on.
  useEffect(() => {
    const prim = liqRef.current;
    if (!prim) return;
    prim.enabled = liqMap;
    prim.buckets = [];
    prim.update();
    if (!liqMap) {
      liqStatsRef.current(null);
      return;
    }
    prim.step = niceStep(Number(market.ctx.markPx));
    let pending = false;
    let liqTimer: number | undefined;
    let stopped = false;
    const scanner = new LiquidationScanner(market.name, market.dex, () => {
      if (pending || stopped) return;
      pending = true;
      liqTimer = window.setTimeout(() => {
        pending = false;
        if (disposedRef.current || stopped) return;
        prim.buckets = bucketLiquidations(scanner.positions.values(), prim.step);
        prim.update();
        let longs = 0;
        let shorts = 0;
        scanner.positions.forEach((p) => (p.szi > 0 ? (longs += p.notional) : (shorts += p.notional)));
        // Largest cluster within 10% on each side of the last close.
        const last = candlesRef.current.at(-1)?.c ?? Number(market.ctx.markPx);
        const near = prim.buckets.filter((b) => Math.abs(b.px - last) / last <= 0.1);
        const below = near.filter((b) => b.px < last).sort((a, b) => b.longs - a.longs)[0];
        const above = near.filter((b) => b.px > last).sort((a, b) => b.shorts - a.shorts)[0];
        liqStatsRef.current({
          wallets: scanner.walletsSeen,
          scanned: scanner.scanned,
          positions: scanner.positions.size,
          longs,
          shorts,
          below: below?.longs ? { px: below.px, usd: below.longs, pct: ((below.px - last) / last) * 100 } : null,
          above: above?.shorts ? { px: above.px, usd: above.shorts, pct: ((above.px - last) / last) * 100 } : null,
        });
      }, 500);
    });
    scanner.start();
    liqStatsRef.current({ wallets: 0, scanned: 0, positions: 0, longs: 0, shorts: 0, below: null, above: null });
    return () => {
      stopped = true;
      scanner.stop();
      window.clearTimeout(liqTimer);
    };
  }, [market.name, liqMap]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drawings: load per market, keep price labels at the market's precision.
  useEffect(() => {
    const draw = drawRef.current;
    if (!draw) return;
    draw.drawings = loadDrawings(market.name);
    draw.draft = null;
    draw.selected = null;
    draw.decimals = priceDecimals(Number(market.ctx.markPx), market.szDecimals);
    draw.update();
  }, [market.name]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const draw = drawRef.current;
    if (!draw || clearDrawings === 0) return;
    draw.drawings = [];
    draw.draft = null;
    draw.selected = null;
    saveDrawings(market.name, []);
    draw.update();
  }, [clearDrawings]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching or leaving a tool cancels a half-placed drawing.
  useEffect(() => {
    const draw = drawRef.current;
    if (draw?.draft && draw.draft.kind !== tool) {
      draw.draft = null;
      draw.update();
    }
    if (hostRef.current) hostRef.current.style.cursor = tool ? 'crosshair' : '';
  }, [tool]);

  // Overlay a wallet's real fills on the chart as markers.
  useEffect(() => {
    const markers = markersRef.current;
    if (!markers) return;
    const ms = INTERVAL_MS[interval];
    const list: SeriesMarker<Time>[] = (walletFills ?? [])
      .filter((f) => f.coin === market.name)
      .sort((a, b) => a.time - b.time)
      .map((f) => {
        const buy = f.side === 'B';
        const pnl = Number(f.closedPnl);
        return {
          time: (Math.floor(f.time / ms) * ms) / 1000 as UTCTimestamp,
          position: buy ? 'belowBar' : 'aboveBar',
          shape: buy ? 'arrowUp' : 'arrowDown',
          color: f.liquidation ? '#facc15' : buy ? '#34d399' : '#f87171',
          text: f.liquidation ? 'LIQ' : pnl ? `${pnl > 0 ? '+' : ''}${pnl.toFixed(0)}` : f.dir.replace('Open ', '').replace('Close ', 'x'),
        };
      });
    markers.setMarkers(list);
  }, [walletFills, market.name, interval]);

  // The connected wallet's resting orders as price lines.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const lines = (openOrders ?? [])
      .filter((o) => o.coin === market.name)
      .map((o) =>
        series.createPriceLine({
          price: Number(o.limitPx),
          color: o.side === 'B' ? '#34d399' : '#f87171',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `${o.side === 'B' ? 'Buy' : 'Sell'} ${o.sz}`,
        }),
      );
    return () => lines.forEach((l) => series.removePriceLine(l));
  }, [openOrders, market.name]);

  // Chart style: colours, background, grid, and the candle type.
  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    const st = chartStyle;
    const light = isLight(st.bg);
    const border = light ? '#d7dce3' : '#1c2530';
    chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: st.bg }, textColor: light ? '#4b5563' : '#8b98a9' },
      grid: { vertLines: { color: st.gridColor, visible: st.grid }, horzLines: { color: st.gridColor, visible: st.grid } },
      rightPriceScale: { borderColor: border },
      timeScale: { borderColor: border },
    });
    if (st.type === 'candles' || st.type === 'hollow') {
      const hollow = st.type === 'hollow';
      series.applyOptions({
        upColor: hollow ? CLEAR : st.up,
        downColor: st.down,
        borderVisible: hollow,
        borderUpColor: st.up,
        borderDownColor: st.down,
        wickUpColor: st.wickUp,
        wickDownColor: st.wickDown,
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineColor: '',
      });
    } else {
      series.applyOptions({
        upColor: CLEAR,
        downColor: CLEAR,
        borderVisible: false,
        wickUpColor: CLEAR,
        wickDownColor: CLEAR,
        lastValueVisible: false,
        priceLineVisible: false,
      });
    }
    // Rebuild the alternative series for bars, line and area.
    if (altRef.current) {
      chart.removeSeries(altRef.current);
      altRef.current = null;
    }
    const common = { priceLineVisible: true, lastValueVisible: true };
    if (st.type === 'bars') altRef.current = chart.addSeries(BarSeries, { ...common, upColor: st.up, downColor: st.down, thinBars: false });
    else if (st.type === 'line') altRef.current = chart.addSeries(LineSeries, { ...common, color: st.up, lineWidth: 2 });
    else if (st.type === 'area')
      altRef.current = chart.addSeries(AreaSeries, { ...common, lineColor: st.up, topColor: withAlpha(st.up, 0.35), bottomColor: withAlpha(st.up, 0.02), lineWidth: 2 });
    if (altRef.current) {
      const dec = priceDecimals(Number(market.ctx.markPx), market.szDecimals);
      altRef.current.applyOptions({ priceFormat: { type: 'price', precision: dec, minMove: 10 ** -dec } });
      setAltData(altRef.current, candlesRef.current.map((k) => ({ time: (k.t / 1000) as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
    }
    // Volume and overlay colours follow the candle colours.
    volRef.current?.setData(
      candlesRef.current.map((k) => ({ time: (k.t / 1000) as UTCTimestamp, value: k.v, color: withAlpha(k.c >= k.o ? st.up : st.down, 0.35) })),
    );
    for (const p of [ghostRef.current, profileRef.current]) {
      if (!p) continue;
      p.up = st.up;
      p.down = st.down;
      p.update();
    }
  }, [chartStyle]); // eslint-disable-line react-hooks/exhaustive-deps

  // Next-candle prediction and volume profile toggles.
  useEffect(() => {
    const g = ghostRef.current;
    if (!g) return;
    g.enabled = prediction;
    if (!prediction) {
      g.prediction = null;
      predCbRef.current(null);
    }
    g.update();
    recalcRef.current();
  }, [prediction, market.name, interval]);

  useEffect(() => {
    const p = profileRef.current;
    if (!p) return;
    p.enabled = volProfile;
    if (!volProfile) p.profile = null;
    p.update();
    recalcRef.current();
  }, [volProfile]);

  // Freehand needs the pointer: stop the chart panning while the pen is active.
  useEffect(() => {
    chartRef.current?.applyOptions({ handleScroll: tool !== 'pen', handleScale: tool !== 'pen' });
  }, [tool]);

  // Edit the selected drawing.
  const mutateSelected = (fn: (d: Drawing) => void) => {
    const draw = drawRef.current;
    if (!draw || !sel) return;
    const d = draw.drawings.find((x) => x.id === sel.id);
    if (!d) return;
    fn(d);
    saveDrawings(market.name, draw.drawings);
    draw.update();
    setSel({ ...d });
  };
  const deleteSelected = () => {
    const draw = drawRef.current;
    if (!draw || !sel) return;
    draw.drawings = draw.drawings.filter((x) => x.id !== sel.id);
    draw.selected = null;
    saveDrawings(market.name, draw.drawings);
    draw.update();
    setSel(null);
  };
  const commitText = (cancel = false) => {
    const draw = drawRef.current;
    const te = textEdit;
    setTextEdit(null);
    if (!draw || !te) return;
    const d = draw.drawings.find((x) => x.id === te.id);
    if (!d) return;
    const text = te.value.trim();
    if ((cancel && te.isNew) || !text) {
      if (cancel && !te.isNew) return;
      draw.drawings = draw.drawings.filter((x) => x.id !== te.id);
    } else if (!cancel) d.text = text;
    saveDrawings(market.name, draw.drawings);
    draw.update();
  };

  // Clear selection state when the market changes.
  useEffect(() => {
    setSel(null);
    setTextEdit(null);
  }, [market.name]);

  const hint = tool
    ? DRAWING_INFO[tool].place === 'two'
      ? 'click two points'
      : DRAWING_INFO[tool].place === 'drag'
        ? 'press and drag to draw'
        : tool === 'text'
          ? 'click where the text goes'
          : 'click a price'
    : '';

  return (
    <div className="chart-wrap">
      <div ref={hostRef} className="chart-host" />
      {status && <div className="chart-status">{status}</div>}
      {tool && (
        <div className="chart-tool-hint">
          {DRAWING_INFO[tool].label}: {hint} · Esc to cancel
        </div>
      )}
      {sel && !tool && (
        <div className="draw-edit" onPointerDown={(e) => e.stopPropagation()}>
          <span className="muted small">{DRAWING_INFO[sel.kind].label}</span>
          {DRAW_COLORS.map((c) => (
            <button key={c} className={`swatch${sel.color === c ? ' on' : ''}`} style={{ background: c }} title={c} onClick={() => mutateSelected((d) => (d.color = c))} />
          ))}
          <input type="color" title="Custom colour" value={sel.color} onChange={(e) => mutateSelected((d) => (d.color = e.target.value))} />
          {sel.kind === 'text' && (
            <button
              onClick={() => {
                const draw = drawRef.current!;
                const d = draw.drawings.find((x) => x.id === sel.id);
                const x = d && draw.x(d.a.t);
                const y = d && draw.y(d.a.p);
                if (d && x != null && y != null) setTextEdit({ id: d.id, x, y, value: d.text ?? '', isNew: false });
              }}
            >
              Edit text
            </button>
          )}
          <button className="danger" onClick={deleteSelected} title="Delete this drawing (Delete key)">
            Delete
          </button>
        </div>
      )}
      {textEdit && (
        <textarea
          className="text-edit"
          autoFocus
          style={{ left: textEdit.x, top: textEdit.y }}
          value={textEdit.value}
          placeholder="Type, Enter to place"
          rows={Math.max(1, textEdit.value.split('\n').length)}
          onChange={(e) => setTextEdit({ ...textEdit, value: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              commitText();
            } else if (e.key === 'Escape') commitText(true);
          }}
          onBlur={() => commitText()}
        />
      )}
    </div>
  );
}

function setAltData(alt: AltSeries | null, bars: ReturnType<typeof toBar>[]) {
  if (!alt) return;
  const type = alt.seriesType();
  if (type === 'Bar') (alt as ISeriesApi<'Bar'>).setData(bars);
  else (alt as ISeriesApi<'Line'>).setData(bars.map((b) => ({ time: b.time, value: b.close })));
}

function updateAlt(alt: AltSeries | null, bar: ReturnType<typeof toBar>) {
  if (!alt) return;
  if (alt.seriesType() === 'Bar') (alt as ISeriesApi<'Bar'>).update(bar);
  else (alt as ISeriesApi<'Line'>).update({ time: bar.time, value: bar.close });
}
