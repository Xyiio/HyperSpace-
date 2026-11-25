const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('http://localhost:4173/?debug#/trade/BTC');
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: /Indicators/ }).click();
  for (const n of ['Bollinger Bands', 'VWAP (daily, UTC)', 'RSI', 'MACD']) await page.getByRole('button', { name: '+ ' + n, exact: true }).click();
  await page.getByRole('button', { name: /Indicators/ }).click();
  await page.waitForTimeout(800);
  const box = await page.locator('.chart-host').boundingBox();
  console.log('chart box', JSON.stringify(box));
  // trend line
  await page.getByRole('button', { name: 'Trend line' }).click();
  await page.mouse.click(box.x + 150, box.y + 300); await page.waitForTimeout(600);
  await page.mouse.move(box.x + 400, box.y + 120);
  await page.mouse.click(box.x + 400, box.y + 120); await page.waitForTimeout(600);
  // fib
  await page.getByRole('button', { name: 'Fib retracement' }).click();
  await page.mouse.click(box.x + 450, box.y + 80); await page.waitForTimeout(600);
  await page.mouse.click(box.x + 600, box.y + 330); await page.waitForTimeout(600);
  // hline + rect via shortcuts
  await page.keyboard.press('h');
  await page.mouse.click(box.x + 300, box.y + 200); await page.waitForTimeout(600);
  await page.keyboard.press('r');
  await page.mouse.click(box.x + 80, box.y + 150); await page.waitForTimeout(600);
  await page.mouse.click(box.x + 220, box.y + 260); await page.waitForTimeout(600);
  await page.waitForTimeout(500);
  console.log('stored drawings:', await page.evaluate(() => JSON.parse(localStorage.getItem('hs.drawings.BTC') || '[]').map(d => d.kind).join(',')));
  console.log('panes:', await page.evaluate(() => window.__hl.chart.panes().length));
  await page.screenshot({ path: 'tools.png' });
  // select and delete the horizontal line
  await page.mouse.click(box.x + 500, box.y + 200); await page.waitForTimeout(600);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(300);
  console.log('after delete:', await page.evaluate(() => JSON.parse(localStorage.getItem('hs.drawings.BTC') || '[]').map(d => d.kind).join(',')));
  // reload: drawings and indicators persist
  await page.reload();
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.waitForTimeout(1500);
  console.log('after reload indicators:', await page.getByRole('button', { name: /Indicators/ }).innerText(), 'panes', await page.evaluate(() => window.__hl.chart.panes().length));
  // remove RSI and MACD -> panes go away
  await page.getByRole('button', { name: /Indicators/ }).click();
  await page.getByTitle('Remove RSI 14').click();
  await page.getByTitle('Remove MACD 12, 26, 9').click();
  await page.waitForTimeout(300);
  console.log('panes after removing oscillators:', await page.evaluate(() => window.__hl.chart.panes().length));
  console.log('errors:', JSON.stringify(errors.slice(0, 5)));
  await browser.close();
})();
