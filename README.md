# HyperSpace

A Hyperliquid-native charting and trading terminal. It reads order flow straight from HyperCore's public API, lets traders act from the chart with builder-code fees, and backs every chartist's record with on-chain PnL.

## What works today (phase 0)

- **Every perp market on Hyperliquid**, including tokenized stocks, indices, commodities and FX on HIP-3 builder-deployed dexes (for example `xyz:TSLA`, `xyz:GOLD`, `xyz:EUR`). Markets are discovered at load time from `perpDexs`, so new HIP-3 dexes and listings appear automatically; delisted ones are hidden.
- **Live candles**, 1m to 1d (`candleSnapshot` + `candle` stream).
- **Order-book heatmap** drawn behind the candles from `l2Book` snapshots, one column per second. Hyperliquid only serves the current book, so the heatmap builds while the tab is open. Grouping (tick, 5/4/3 significant figures) is adjustable.
- **Large-trade bubbles** on the chart and a trade tape that shows the taker's wallet. Click any wallet to open its verified PnL.
- **Book ladder.** Click a level, or anywhere on the chart, to stage an order at that price.
- **Wallet connection and trading (phase 1).** Connect any browser wallet (MetaMask, Rabby, Coinbase Wallet and others via EIP-6963). "Enable trading" asks the wallet for two one-time signatures: `approveAgent` for a trading key generated and kept in this browser, and `approveBuilderFee` when a builder address is configured. After that, limit and market orders (IOC with 1% slippage cap), reduce-only, post-only, cancels and "close at market" are signed locally by the agent key, with no wallet pop-up per order. Mainnet orders need a second confirming click. The agent key can trade but cannot withdraw or transfer funds.
- **Indicators**: SMA, EMA, Bollinger Bands, daily VWAP on the price pane; RSI and MACD in their own panes. Lengths are editable and the set is remembered per browser.
- **Drawing tools**: trend line (T), horizontal line (H), rectangle (R), Fibonacci retracement (F). Drawings are saved per market; click one to select it and press Delete to remove it.
- **Liquidation map (estimate)**: wallets are discovered from the live trade stream and their `clearinghouseState` is read (about 2 per second, biggest traders first) to place long and short liquidation levels as bars on the right of the chart. The toolbar shows coverage and the biggest cluster within 10% on each side. It only covers wallets seen trading since the page opened.
- **Account panel**: balance, positions with liquidation price, open orders with cancel, for the current market's venue. Open orders show as price lines on the chart.
- **Mainnet / testnet switch** in the header.
- **Verified PnL** for any address: period PnL, account value, max drawdown and volume from `portfolio`; open positions with liquidation prices from `clearinghouseState`; win rate, fees and per-coin realized PnL from the most recent 2,000 `userFills`.
- **Wallet overlay**: plot any wallet's real fills on the chart (`#/trade/BTC?wallet=0x…`).

No backend and no API keys: the browser talks to `https://api.hyperliquid.xyz` and `wss://api.hyperliquid.xyz/ws` (or the testnet equivalents) directly.

**Security note:** the agent key is stored in the browser's localStorage for this site. Anyone who can run script on the page could trade with it (not withdraw). Keep the app free of third-party scripts, and revoke the agent on Hyperliquid (API page) if a browser is compromised.

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
scripts/e2e-tools.cjs  Playwright run of indicators and drawing tools against live data
scripts/e2e-liqmap.cjs Playwright run of the liquidation map against live data
scripts/e2e-wallet.mjs Playwright run of connect → enable trading → order → cancel with a simulated wallet
src/wallet/           Wallet discovery, connection, agent approval, order signing (@nktkas/hyperliquid + viem)
```

## Roadmap

0. Order-flow MVP (this code)
1. Trade from the chart: wallet connect, in-browser agent key, signed orders with our builder code (built; needs a funded real-wallet test)
2. Proof layer: wallet indexer, liquidation map, chartist profiles, trade ideas stamped with on-chain positions
3. Script marketplace: sandboxed indicator language, paid scripts, USDC author payouts
4. HYPERSPACE token: HIP-1 spot token on Hyperliquid tied to fees and marketplace payouts (design only; nothing is deployed without the owner's sign-off)

Charts use the open-source [lightweight-charts](https://github.com/tradingview/lightweight-charts) library (Apache 2.0), which requires its attribution logo to stay visible.

## Trade ideas and profiles (Supabase)

Phase 2 adds chartist profiles and trade ideas. Every post is signed by the author's wallet (EIP-191, no transaction), and the server stamps it with the market price and the author's live Hyperliquid position at posting time. Each idea card then checks the price path against the target and stop, and the author's own fills since posting.

Setup:

1. Create a Supabase project.
2. `supabase link --project-ref <ref>` then `supabase db push` (applies `supabase/migrations`).
3. `supabase functions deploy post-idea save-profile` (they use the built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` secrets).
4. In `.env.local` set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the public anon key only; the service_role key must never reach the browser).

Without those env vars the Ideas page shows a "not connected" note and the rest of the app works normally. Tables are read-only to the public through row-level security; all writes go through the edge functions after the signature is verified.

## Creator studio, marketplace, leaderboard and community

- **HyperScript** (`src/script/hyperscript.ts`): HyperSpace's indicator language. Scripts are parsed and evaluated over whole price series in a sandbox. They see only candles, have no loops and cannot reach the page, wallet or network, so marketplace scripts are safe to run. Open **Studio** (`#/studio`) to write one with a live preview and a function reference, then add it to the chart.
- **Market** (`#/market`): HyperSpace originals work offline. Community indicators are published from the Studio with a wallet signature, either free or priced in HYPERSPACE. Paid listings show now, and buying opens at the token launch.
- **Leaderboard** (`#/leaderboard`): top traders by PnL or ROI over 24h, 7d, 30d or all time, from Hyperliquid's leaderboard data. With Supabase connected, the `leaderboard` function caches a reduced copy for 10 minutes; without it, the browser downloads Hyperliquid's full file (about 40 MB).
- **Community** (`#/community`): live chat channels plus the trade-ideas feed. Chat sign-in is one wallet signature that lasts 7 days.

Backend for these: run `supabase db push` (this applies `0002_scripts_chat_leaderboard.sql`), then `supabase functions deploy publish-script chat-login chat-post leaderboard`.
