const { chromium } = require('playwright');
const now = Date.now();
const MIN = 60000;
let px = 97000;
const candles = [];
for (let i = 500; i > 0; i--) {
  const t = Math.floor((now - i * MIN) / MIN) * MIN;
  const o = px; px += (Math.random() - 0.5) * 120; const c = px;
  candles.push({ t, T: t + MIN - 1, s: 'BTC', i: '1m', o: String(o), c: String(c), h: String(Math.max(o, c) + 30), l: String(Math.min(o, c) - 30), v: String(5 + Math.random() * 20), n: 100 });
}
const meta = [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }] },
  [{ funding: '0.0000125', openInterest: '30000', prevDayPx: '96000', dayNtlVlm: '3000000000', premium: '0', oraclePx: String(px), markPx: String(px), midPx: String(px) },
   { funding: '0.00001', openInterest: '500000', prevDayPx: '3500', dayNtlVlm: '1000000000', premium: '0', oraclePx: '3600', markPx: '3600', midPx: '3600' }]];
const addr = '0x' + 'ab'.repeat(20);
const fills = Array.from({ length: 40 }, (_, k) => ({ coin: 'BTC', px: String(px - 500 + k * 20), sz: '0.1', side: k % 2 ? 'A' : 'B', time: now - (40 - k) * 7 * MIN, startPosition: '0', dir: k % 2 ? 'Close Long' : 'Open Long', closedPnl: k % 2 ? String((Math.random() - 0.4) * 300) : '0', hash: '0x' + k, oid: k, crossed: true, fee: '1.5', ...(k === 13 ? { liquidation: { markPx: '1', method: 'market' } } : {}) }));
const hist = Array.from({ length: 60 }, (_, k) => [now - (60 - k) * 86400000, String(10000 + k * 150 + Math.sin(k / 4) * 900)]);
const portfolio = ['day', 'week', 'month', 'allTime'].map((p) => [p, { accountValueHistory: hist, pnlHistory: hist.map(([t, v]) => [t, String(Number(v) - 10000)]), vlm: '12345678' }]);
const state = { assetPositions: [{ type: 'oneWay', position: { coin: 'BTC', szi: '0.5', entryPx: '95000', positionValue: '48500', unrealizedPnl: '1000', returnOnEquity: '0.1', liquidationPx: '80000', leverage: { type: 'cross', value: 5 }, marginUsed: '9700' } }], marginSummary: { accountValue: '18900', totalNtlPos: '48500', totalMarginUsed: '9700' }, withdrawable: '9000', time: now };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route('https://api.hyperliquid.xyz/info', async (route) => {
    const b = JSON.parse(route.request().postData());
    const body = { perpDexs: [null], metaAndAssetCtxs: meta, candleSnapshot: candles, portfolio, userFills: fills, clearinghouseState: state }[b.type];
    await route.fulfill({ json: body ?? null, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.routeWebSocket('wss://api.hyperliquid.xyz/ws', (ws) => {
    const subs = [];
    ws.onMessage((m) => { const j = JSON.parse(m); if (j.method === 'subscribe') subs.push(j.subscription); });
    let tid = 0;
    const timer = setInterval(() => {
      px += (Math.random() - 0.5) * 20;
      for (const s of subs) {
        if (s.type === 'l2Book') {
          const step = 10;
          const mid = Math.round(px / step) * step;
          const lv = (dir) => Array.from({ length: 20 }, (_, k) => ({ px: String(mid + dir * (k + 1) * step), sz: String((Math.random() * 3 + (k === 7 ? 25 : 0)).toFixed(5)), n: 3 }));
          ws.send(JSON.stringify({ channel: 'l2Book', data: { coin: s.coin, time: Date.now(), levels: [lv(-1), lv(1)] } }));
        } else if (s.type === 'trades') {
          const big = Math.random() < 0.3;
          ws.send(JSON.stringify({ channel: 'trades', data: [{ coin: s.coin, side: Math.random() < 0.5 ? 'B' : 'A', px: String(px.toFixed(0)), sz: big ? '3.2' : '0.01', time: Date.now(), hash: '0x', tid: tid++, users: [addr, '0x' + 'cd'.repeat(20)] }] }));
        } else if (s.type === 'candle') {
          const t = Math.floor(Date.now() / MIN) * MIN;
          ws.send(JSON.stringify({ channel: 'candle', data: { t, T: t + MIN - 1, s: s.coin, i: s.interval, o: String(px), c: String(px), h: String(px + 5), l: String(px - 5), v: '1', n: 1 } }));
        } else if (s.type === 'allMids') {
          ws.send(JSON.stringify({ channel: 'allMids', data: { mids: { BTC: String(px) } } }));
        }
      }
    }, 250);
    ws.onClose(() => clearInterval(timer));
  });
  await page.goto('http://localhost:4173/?debug#/trade/BTC');
  await page.waitForTimeout(9000);
  await page.evaluate(() => {
    const h = window.__hl; const now = Date.now(); const bars = h.mapper.barTimesMs;
    const closes = h.series.data();
    for (let k = 3600; k > 0; k -= 5) {
      const t = now - k * 1000;
      const bi = Math.max(0, bars.length - 1 - Math.ceil(k / 60));
      const mid = Math.round(closes[bi].close / 10) * 10;
      const lv = (dir) => Array.from({ length: 20 }, (_, j) => [mid + dir * (j + 1) * 10, Math.random() * 2 + (j === 6 ? 20 : 0) + ((mid + dir*(j+1)*10) % 200 === 0 ? 15 : 0)]);
      h.heat.snapshots.push({ t, step: 10, bids: lv(-1), asks: lv(1) });
      if (k % 120 === 0) h.bubbles.trades.push({ t, px: closes[bi].close, notional: 300000 + Math.random() * 2e6, buy: Math.random() < 0.5 });
    }
    h.heat.snapshots.sort((a, b) => a.t - b.t);
    h.chart.timeScale().setVisibleLogicalRange({ from: bars.length - 75, to: bars.length + 5 });
    h.heat.update();
  });
  await page.waitForTimeout(800);
  await page.mouse.move(500, 400);
  await page.waitForTimeout(3000);
  await page.mouse.click(600, 350);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'terminal.png' });
  await page.goto(`http://localhost:4173/#/wallet/${addr}`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'wallet.png', fullPage: true });
  await page.goto(`http://localhost:4173/#/trade/BTC?wallet=${addr}`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'overlay.png' });
  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
