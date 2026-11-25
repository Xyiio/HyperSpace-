import { useEffect, useRef } from 'react';
import { AreaSeries, ColorType, LineSeries, createChart, type UTCTimestamp } from 'lightweight-charts';

export function PnlChart({ series }: { series: { t: number; pnl: number; value: number }[] }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const chart = createChart(ref.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0b0f14' }, textColor: '#8b98a9', attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: '#141b24' } },
      rightPriceScale: { borderColor: '#1c2530' },
      leftPriceScale: { visible: true, borderColor: '#1c2530' },
      timeScale: { borderColor: '#1c2530', timeVisible: true },
    });
    // Points can share a second; keep the last one per timestamp.
    const dedupe = <T extends { time: UTCTimestamp }>(pts: T[]) => {
      const m = new Map<number, T>();
      pts.forEach((p) => m.set(p.time, p));
      return [...m.values()].sort((a, b) => a.time - b.time);
    };
    const last = series[series.length - 1]?.pnl ?? 0;
    const pnl = chart.addSeries(AreaSeries, {
      lineColor: last >= 0 ? '#34d399' : '#f87171',
      topColor: last >= 0 ? 'rgba(52,211,153,0.25)' : 'rgba(248,113,113,0.25)',
      bottomColor: 'rgba(0,0,0,0)',
      lineWidth: 2,
      title: 'PnL',
    });
    pnl.setData(dedupe(series.map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.pnl }))));
    const val = chart.addSeries(LineSeries, { priceScaleId: 'left', color: '#7c8ea5', lineWidth: 1, title: 'Account value' });
    val.setData(dedupe(series.filter((p) => Number.isFinite(p.value)).map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.value }))));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series]);

  return <div ref={ref} className="pnl-chart" />;
}
