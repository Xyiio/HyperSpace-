// An extra chart in a multi-chart layout: its own market and timeframe, with the shared
// indicators and chart style. Click its title to make it the main (tradeable) chart.
import { useMemo } from 'react';
import { INTERVALS, type Interval, type Market } from '../hl/api';
import type { IndicatorConfig } from '../hl/indicators';
import type { ChartStyle } from '../hl/chartStyle';
import { ChartPanel } from './ChartPanel';

interface Props {
  markets: Market[];
  coin: string;
  interval: Interval;
  onChange: (coin: string, interval: Interval) => void;
  onFocus: (coin: string) => void;
  indicators: IndicatorConfig[];
  chartStyle: ChartStyle;
  drawColor: string;
}

const noop = () => {};

export function MiniChart({ markets, coin, interval, onChange, onFocus, indicators, chartStyle, drawColor }: Props) {
  const market = useMemo(() => markets.find((m) => m.name === coin) ?? markets[0], [markets, coin]);
  const chg = ((Number(market.ctx.markPx) - Number(market.ctx.prevDayPx)) / Number(market.ctx.prevDayPx)) * 100;
  return (
    <div className="mini-chart">
      <div className="mini-head">
        <select value={market.name} onChange={(e) => onChange(e.target.value, interval)} aria-label="Market">
          {markets.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
        <span className={chg >= 0 ? 'up small' : 'down small'}>
          {chg >= 0 ? '+' : ''}
          {chg.toFixed(2)}%
        </span>
        <span className="intervals">
          {INTERVALS.map((i) => (
            <button key={i} className={i === interval ? 'on' : ''} onClick={() => onChange(market.name, i)}>
              {i}
            </button>
          ))}
        </span>
        <button className="link small" onClick={() => onFocus(market.name)} title="Trade this market on the main chart">
          Trade ↗
        </button>
      </div>
      <ChartPanel
        market={market}
        interval={interval}
        nSigFigs={4}
        heatmap={false}
        bigTradeUsd={Infinity}
        walletFills={null}
        indicators={indicators}
        tool={null}
        onToolDone={noop}
        clearDrawings={0}
        liqMap={false}
        onLiqStats={noop}
        onPricePick={noop}
        drawColor={drawColor}
        chartStyle={chartStyle}
        volProfile={false}
        prediction={false}
        onPrediction={noop}
      />
    </div>
  );
}
