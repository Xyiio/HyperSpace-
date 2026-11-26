// Playwright: turn on the liquidation map for BTC against live Hyperliquid data and report coverage.
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let infoCalls = 0;
  page.on('request', (r) => r.url().endsWith('/info') && infoCalls++);
  await page.goto('http://localhost:4173/#/trade/BTC');
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.getByLabel('Liquidation map').check();
  const before = infoCalls;
  await page.waitForTimeout(Number(process.env.WAIT ?? 60000));
  console.log((await page.locator('.toolbar').innerText()).split('\n').find((l) => l.startsWith('Liq map')));
  console.log('info calls/min during scan:', Math.round(((infoCalls - before) * 60000) / Number(process.env.WAIT ?? 60000)));
  await page.screenshot({ path: process.env.SHOT ?? 'liqmap.png' });
  console.log('errors:', JSON.stringify(errors.slice(0, 5)));
  await browser.close();
})();
