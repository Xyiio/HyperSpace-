import { useEffect, useRef, useState } from 'react';
import {
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
import { DRAWING_INFO, DrawingsPrimitive, loadDrawings, saveDrawings, type Drawing, type DrawingKind } from '../hl/drawings';

const MAX_SNAPSHOTS = 7200; // ~2h at one column per second
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
}

const toBar = (c: RawCandle) => ({
  time: Math.floor(c.t / 1000) as UTCTimestamp,
  open: Number(c.o),
  high: Number(c.h),
  low: Number(c.l),
  close: Number(c.c),
});

const toCandle = (c: RawCandle): Candle => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c, v: +c.v });

const toVol = (c: RawCandle) => ({
  time: Math.floor(c.t / 1000) as UTCTimestamp,
  value: Number(c.v),
  color: Number(c.c) >= Number(c.o) ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)',
});

export function ChartPanel({ market, interval, nSigFigs, heatmap, bigTradeUsd, walletFills, openOrders, indicators, tool, onToolDone, clearDrawings, liqMap, onLiqStats, onPricePick }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
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

    const toPoint = (x: number, y: number) => {
      const l = chart.timeScale().coordinateToLogical(x);
      const p = series.coordinateToPrice(y);
      const t = l === null ? null : mapperRef.current.timeAt(l);
      return t === null || p === null ? null : { t, p };
    };
    const persist = () => saveDrawings(coinRef.current, draw.drawings);

    // Clicks: place drawings when a tool is active, select a drawing under the cursor,
    // otherwise stage an order at that price.
    chart.subscribeClick((p) => {
      if (!p.point) return;
      const kind = toolRef.current;
      if (kind) {
        const pt = toPoint(p.point.x, p.point.y);
        if (!pt) return;
        if (!draw.draft) {
          const d: Drawing = { id: crypto.randomUUID(), kind, a: pt, b: pt, color: '#f5c542' };
          if (DRAWING_INFO[kind].points === 1) {
            draw.drawings.push(d);
            persist();
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
        return;
      }
      const hit = draw.hit(p.point.x, p.point.y);
      draw.selected = hit;
      draw.update();
      if (hit) return;
      const px = series.coordinateToPrice(p.point.y);
      if (px !== null) pickRef.current(px);
    });
    chart.subscribeCrosshairMove((p) => {
      if (!draw.draft || !p.point) return;
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
        draw.selected = null;
        persist();
        draw.update();
      } else if (e.key === 'Escape') {
        draw.draft = null;
        draw.selected = null;
        draw.update();
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
    return () => {
      window.removeEventListener('keydown', onKey);
      indSeriesRef.current.clear();
      chart.remove();
      chartRef.current = seriesRef.current = volRef.current = heatRef.current = bubblesRef.current = null;
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
    const scheduleRecalc = () => {
      if (pending) return;
      pending = true;
      window.setTimeout(() => {
        pending = false;
        recalcRef.current();
      }, 1000);
    };
    series.setData([]);
    vol.setData([]);
    setStatus('Loading candles…');

    // 1m needs ~1,500 bars so the daily VWAP covers the whole UTC day.
    fetchCandles(market.name, interval, interval === '1m' ? 1500 : 500, ac.signal)
      .then((candles) => {
        if (ac.signal.aborted) return;
        series.setData(candles.map(toBar));
        vol.setData(candles.map(toVol));
        mapper.barTimesMs = candles.map((c) => c.t);
        candlesRef.current = candles.map(toCandle);
        recalcRef.current();
        chartRef.current?.timeScale().scrollToRealTime();
        setStatus('');
        unsub = hlSocket.subscribe({ type: 'candle', coin: market.name, interval }, (c: RawCandle) => {
          series.update(toBar(c));
          vol.update(toVol(c));
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
    };
  }, [market.name, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  // Order-book heatmap: one column per second, kept while this coin is open.
  useEffect(() => {
    const heat = heatRef.current!;
    heat.snapshots = [];
    heat.update();
    let lastT = 0;
    return hlSocket.subscribe({ type: 'l2Book', coin: market.name, nSigFigs }, (book: L2Book) => {
      const now = Date.now();
      if (now - lastT < SNAPSHOT_EVERY_MS) return;
      lastT = now;
      heat.snapshots.push(bookToSnapshot(book, now));
      if (heat.snapshots.length > MAX_SNAPSHOTS) heat.snapshots.splice(0, heat.snapshots.length - MAX_SNAPSHOTS);
      heat.update();
    });
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
    const ks = candlesRef.current;
    if (!ks.length) return;
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
    const scanner = new LiquidationScanner(market.name, market.dex, () => {
      if (pending) return;
      pending = true;
      window.setTimeout(() => {
        pending = false;
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
    return () => scanner.stop();
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

  // Leaving a tool half-placed cancels the draft.
  useEffect(() => {
    const draw = drawRef.current;
    if (draw && !tool && draw.draft) {
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

  return (
    <div className="chart-wrap">
      <div ref={hostRef} className="chart-host" />
      {status && <div className="chart-status">{status}</div>}
      {tool && <div className="chart-tool-hint">{DRAWING_INFO[tool].label}: click {DRAWING_INFO[tool].points === 2 ? 'two points' : 'a price'} · Esc to cancel</div>}
    </div>
  );
}
