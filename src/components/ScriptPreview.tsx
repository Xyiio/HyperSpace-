import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { fetchCandles, type Interval } from '../hl/api';
import { run, ScriptError, type ScriptCandle, type ScriptOutput } from '../script/hyperscript';
import { withAlpha } from '../hl/chartStyle';

/** A small chart that runs a HyperScript on real candles, for the Studio and the Market. */
export function ScriptPreview({
  code,
  coin,
  interval,
  inputs,
  onResult,
  height = 420,
}: {
  code: string;
  coin: string;
  interval: Interval;
  inputs?: Record<string, number>;
  onResult?: (r: { out: ScriptOutput | null; error: ScriptError | null; ms: number }) => void;
  height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const extra = useRef<ISeriesApi<'Line' | 'Histogram'>[]>([]);
  const markersRef = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(null);
  const [candles, setCandles] = useState<ScriptCandle[]>([]);
  const resultRef = useRef(onResult);
  resultRef.current = onResult;

  useEffect(() => {
    const c = createChart(host.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b0f14' }, textColor: '#8b98a9', attributionLogo: true },
      grid: { vertLines: { color: '#141b24' }, horzLines: { color: '#141b24' } },
      rightPriceScale: { borderColor: '#1c2530' },
      timeScale: { borderColor: '#1c2530', timeVisible: true },
    });
    main.current = c.addSeries(CandlestickSeries, { upColor: '#34d399', downColor: '#f87171', wickUpColor: '#34d399', wickDownColor: '#f87171', borderVisible: false });
    chart.current = c;
    markersRef.current = createSeriesMarkers(main.current, []);
    return () => {
      chart.current = null;
      c.remove();
    };
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchCandles(coin, interval, 500, ac.signal)
      .then((ks) => {
        const list = ks.map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
        main.current?.setData(list.map((k) => ({ time: (k.t / 1000) as UTCTimestamp, open: k.o, high: k.h, low: k.l, close: k.c })));
        setCandles(list);
      })
      .catch(() => {});
    return () => ac.abort();
  }, [coin, interval]);

  useEffect(() => {
    const c = chart.current;
    const m = main.current;
    if (!c || !m) return;
    const t = window.setTimeout(() => {
      for (const s of extra.current) c.removeSeries(s);
      extra.current = [];
      for (const pane of [...c.panes()].reverse()) if (pane.paneIndex() > 0 && pane.getSeries().length === 0) c.removePane(pane.paneIndex());
      const markers = markersRef.current!;
      markers.setMarkers([]);
      const t0 = performance.now();
      let out: ScriptOutput | null = null;
      let error: ScriptError | null = null;
      try {
        out = run(code, candles, inputs);
      } catch (e) {
        error = e instanceof ScriptError ? e : new ScriptError(String(e), 0);
      }
      const ms = performance.now() - t0;
      if (out) {
        const pane = out.overlay ? 0 : 1;
        const time = (i: number) => (candles[i].t / 1000) as UTCTimestamp;
        out.plots.forEach((pl, idx) => {
          if (pl.style === 'histogram') {
            const s = c.addSeries(HistogramSeries, { color: pl.color, priceLineVisible: false, lastValueVisible: false }, pane);
            s.setData(Array.from(pl.values, (v, i) => (Number.isFinite(v) ? { time: time(i), value: v, color: withAlpha(pl.color, v >= 0 ? 0.7 : 0.4) } : { time: time(i) })));
            extra.current.push(s);
          } else {
            const s = c.addSeries(LineSeries, { color: pl.color, lineWidth: pl.width as 1 | 2 | 3 | 4, priceLineVisible: false, crosshairMarkerVisible: false }, pane);
            s.setData(Array.from(pl.values, (v, i) => (Number.isFinite(v) ? { time: time(i), value: v } : { time: time(i) })));
            if (idx === 0) for (const h of out!.hlines) s.createPriceLine({ price: h.value, color: h.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: h.title });
            extra.current.push(s);
          }
        });
        const ms2: SeriesMarker<Time>[] = [];
        for (const sh of out.shapes)
          for (const b of sh.bars)
            ms2.push({ time: time(b), position: sh.dir === 'up' ? 'belowBar' : 'aboveBar', shape: sh.dir === 'up' ? 'arrowUp' : 'arrowDown', color: sh.color, text: sh.title });
        ms2.sort((a, b) => (a.time as number) - (b.time as number));
        markers.setMarkers(ms2);
        if (!out.overlay) for (const p of c.panes()) if (p.paneIndex() > 0) p.setHeight(Math.round(height * 0.32));
      }
      resultRef.current?.({ out, error, ms });
    }, 350);
    return () => window.clearTimeout(t);
  }, [code, candles, inputs, height]);

  return <div ref={host} className="script-preview" style={{ height }} />;
}
