# HyperSpace

A Hyperliquid-native charting and trading terminal. It reads order flow straight from HyperCore's public API, lets traders act from the chart with builder-code fees, and backs every chartist's record with on-chain PnL.

## What works today (phase 0)

- **Live candles** for every Hyperliquid perp, 1m to 1d (`candleSnapshot` + `candle` stream).
- **Order-book heatmap** drawn behind the candles from `l2Book` snapshots, one column per second. Hyperliquid only serves the current book, so the heatmap builds while the tab is open. Grouping (tick, 5/4/3 significant figures) is adjustable.
- **Large-trade bubbles** on the chart and a trade tape that shows the taker's wallet. Click any wallet to open its verified PnL.
- **Book ladder.** Click a level, or anywhere on the chart, to stage an order at that price.
- **Order ticket** that builds the exact Hyperliquid order action, including the builder code (`builder: {b, f}`). Wallet signing ships in phase 1, so the submit button is disabled for now.
- **Verified PnL** for any address: period PnL, account value, max drawdown and volume from `portfolio`; open positions with liquidation prices from `clearinghouseState`; win rate, fees and per-coin realized PnL from the most recent 2,000 `userFills`.
- **Wallet overlay**: plot any wallet's real fills on the chart (`#/trade/BTC?wallet=0x…`).

No backend and no API keys: the browser talks to `https://api.hyperliquid.xyz` and `wss://api.hyperliquid.xyz/ws` directly.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests for the PnL, price and order-wire helpers
npm run build      # static site in dist/, deployable to any static host
```

Builder fee settings (optional, at build time):

| Variable | Meaning |
| --- | --- |
| `VITE_BUILDER_ADDRESS` | Address that earns builder fees. It must hold at least 100 USDC in its perp account. |
| `VITE_BUILDER_FEE` | Fee in tenths of a basis point (10 = 0.01%). Hyperliquid caps perps at 100 (0.1%). |

## Layout

```
src/hl/api.ts         Info API client and response types
src/hl/ws.ts          Shared WebSocket with routing, ping and resubscribe
src/hl/primitives.ts  Chart plugins: order-book heatmap and trade bubbles
src/hl/stats.ts       Book snapshots, price ticks, PnL statistics
src/hl/order.ts       Order action + builder code construction
src/pages/            Terminal (chart) and Wallet (verified PnL)
src/components/       Chart, book ladder, trade tape, order ticket, market bar
scripts/e2e-mock.cjs  Playwright run against a simulated Hyperliquid feed
```

## Roadmap

0. Order-flow MVP (this code)
1. Trade from the chart: wallet connect, in-browser agent key, signed orders with our builder code, testnet then mainnet
2. Proof layer: wallet indexer, liquidation map, chartist profiles, trade ideas stamped with on-chain positions
3. Script marketplace: sandboxed indicator language, paid scripts, USDC author payouts
4. HYPERSPACE token: HIP-1 spot token on Hyperliquid tied to fees and marketplace payouts (design only; nothing is deployed without the owner's sign-off)

Charts use the open-source [lightweight-charts](https://github.com/tradingview/lightweight-charts) library (Apache 2.0), which requires its attribution logo to stay visible.
