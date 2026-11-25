import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
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
import { fetchCandles, INTERVAL_MS, type Fill, type Interval, type L2Book, type Market, type RawCandle, type Trade } from '../hl/api';
import { hlSocket } from '../hl/ws';
import { HeatmapPrimitive, TimeMapper, TradeBubblesPrimitive } from '../hl/primitives';
import { bookToSnapshot, priceDecimals } from '../hl/stats';

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
  onPricePick: (px: number) => void;
}

const toBar = (c: RawCandle) => ({
  time: Math.floor(c.t / 1000) as UTCTimestamp,
  open: Number(c.o),
  high: Number(c.h),
  low: Number(c.l),
  close: Number(c.c),
});

const toVol = (c: RawCandle) => ({
  time: Math.floor(c.t / 1000) as UTCTimestamp,
  value: Number(c.v),
  color: Number(c.c) >= Number(c.o) ? 'rgba(52,211,153,0.35)' : 'rgba(248,113,113,0.35)',
});

export function ChartPanel({ market, interval, nSigFigs, heatmap, bigTradeUsd, walletFills, onPricePick }: Props) {
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

    // Click anywhere on the chart to stage an order at that price.
    chart.subscribeClick((p) => {
      if (!p.point) return;
      const px = series.coordinateToPrice(p.point.y);
      if (px !== null) pickRef.current(px);
    });

    // ?debug exposes internals for the e2e script.
    if (location.search.includes("debug")) (window as any).__hl = { chart, series, mapper: mapperRef.current, heat, bubbles };
    chartRef.current = chart;
    seriesRef.current = series;
    volRef.current = vol;
    heatRef.current = heat;
    bubblesRef.current = bubbles;
    return () => {
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
    series.setData([]);
    vol.setData([]);
    setStatus('Loading candles…');

    fetchCandles(market.name, interval, 500, ac.signal)
      .then((candles) => {
        if (ac.signal.aborted) return;
        series.setData(candles.map(toBar));
        vol.setData(candles.map(toVol));
        mapper.barTimesMs = candles.map((c) => c.t);
        chartRef.current?.timeScale().scrollToRealTime();
        setStatus('');
        unsub = hlSocket.subscribe({ type: 'candle', coin: market.name, interval }, (c: RawCandle) => {
          series.update(toBar(c));
          vol.update(toVol(c));
          const bars = mapper.barTimesMs;
          if (bars.length === 0 || c.t > bars[bars.length - 1]) bars.push(c.t);
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

  return (
    <div className="chart-wrap">
      <div ref={hostRef} className="chart-host" />
      {status && <div className="chart-status">{status}</div>}
    </div>
  );
}
