import { useEffect, useMemo, useState } from 'react';
import { fetchFills, isAddress, type Fill, type Interval, type Market, type OpenOrder } from '../hl/api';
import { ChartPanel } from '../components/ChartPanel';
import { BookLadder } from '../components/BookLadder';
import { TradeTape } from '../components/TradeTape';
import { OrderTicket } from '../components/OrderTicket';
import { AccountPanel } from '../components/AccountPanel';
import { MarketBar } from '../components/MarketBar';
import { shortAddr } from '../hl/stats';

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

interface Props {
  markets: Market[];
  coin: string;
  overlay: string | null;
  onRoute: (hash: string) => void;
}

export function Terminal({ markets, coin, overlay, onRoute }: Props) {
  const market = useMemo(() => markets.find((m) => m.name === coin) ?? markets.find((m) => m.name.toLowerCase() === coin.toLowerCase()) ?? markets[0], [markets, coin]);
  const [interval, setTf] = useState<Interval>('1m');
  const [nSigFigs, setNSigFigs] = useState<number | null>(4);
  const [heatmap, setHeatmap] = useState(true);
  const [bigTrade, setBigTrade] = useState(() => defaultBigTrade(market));
  const [price, setPrice] = useState<number | null>(null);
  const [wallet, setWallet] = useState(overlay ?? '');
  const [fills, setFills] = useState<Fill[] | null>(null);
  const [fillsMsg, setFillsMsg] = useState('');
  const [openOrders, setOpenOrders] = useState<OpenOrder[]>([]);

  useEffect(() => {
    setBigTrade(defaultBigTrade(market));
    setPrice(null);
  }, [market.name]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const go = (c: string, o: string | null = overlay) => onRoute(`#/trade/${c}${o ? `?wallet=${o}` : ''}`);

  return (
    <div className="terminal">
      <MarketBar markets={markets} market={market} onMarket={(c) => go(c)} interval={interval} onInterval={setTf} />
      <div className="toolbar">
        <label className="check">
          <input type="checkbox" checked={heatmap} onChange={(e) => setHeatmap(e.target.checked)} /> Book heatmap
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
            const w = wallet.trim();
            go(market.name, isAddress(w) ? w.toLowerCase() : null);
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
        {fillsMsg && <span className="muted">{fillsMsg}</span>}
      </div>
      <div className="workspace">
        <div className="main-col">
          <ChartPanel
            market={market}
            interval={interval}
            nSigFigs={nSigFigs}
            heatmap={heatmap}
            bigTradeUsd={bigTrade}
            walletFills={fills}
            openOrders={openOrders}
            onPricePick={setPrice}
          />
          <p className="legend">
            <span className="sw bid" /> resting bids <span className="sw ask" /> resting asks, brighter = more size · bubbles = trades ≥ ${bigTrade.toLocaleString()} ·
            the heatmap builds while this tab is open · click the chart to stage an order
          </p>
          <AccountPanel market={market} markets={markets} onOpenOrders={setOpenOrders} onMarket={(c) => go(c)} />
        </div>
        <div className="side-col">
          <BookLadder market={market} nSigFigs={nSigFigs} onPricePick={setPrice} />
        </div>
        <div className="side-col">
          <OrderTicket market={market} price={price} onPrice={setPrice} />
          <TradeTape market={market} bigTradeUsd={bigTrade} onWallet={(a) => onRoute(`#/wallet/${a}`)} />
        </div>
      </div>
    </div>
  );
}
