// Studio → chart, Market originals, Leaderboard (live), Community without backend.
const { chromium } = require('playwright');
const SHOT = process.env.SHOT || '.';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text().slice(0, 160)));
  await page.goto('http://localhost:4173/?debug#/studio');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForTimeout(3500);
  console.log('studio status:', await page.locator('.editor-status').innerText());
  // break the script
  await page.locator('.code textarea').fill('indicator("Broken")\nx = sma(close, 10\nplot(x)');
  await page.waitForTimeout(800);
  console.log('error status:', await page.locator('.editor-status').innerText());
  // open an example, save, add to chart
  await page.getByRole('button', { name: 'Keltner channel' }).click();
  await page.waitForTimeout(2500);
  console.log('example status:', await page.locator('.editor-status').innerText());
  await page.screenshot({ path: SHOT + '/studio.png' });
  await page.getByRole('button', { name: 'Add to chart' }).click();
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('chart series:', await page.evaluate(() => window.__hl.chart.panes()[0].getSeries().length), 'indicators:', await page.getByRole('button', { name: /Indicators/ }).innerText());
  await page.screenshot({ path: SHOT + '/chart-script.png' });
  // market
  await page.goto('http://localhost:4173/#/market');
  await page.waitForTimeout(800);
  console.log('market originals:', await page.locator('.market-card').count(), '| community:', (await page.locator('.panel-empty').innerText()).slice(0, 60));
  // leaderboard
  await page.goto('http://localhost:4173/#/leaderboard');
  await page.waitForSelector('.lb-table tbody tr', { timeout: 60000 });
  console.log('leaderboard first rows:', (await page.locator('.lb-table tbody tr').nth(0).innerText()).replace(/\s+/g, ' '), '|', await page.locator('.lb-tools .muted').innerText());
  await page.getByRole('button', { name: 'By ROI' }).click();
  await page.getByRole('button', { name: '30 days' }).click();
  console.log('roi 30d first:', (await page.locator('.lb-table tbody tr').nth(0).innerText()).replace(/\s+/g, ' '));
  await page.screenshot({ path: SHOT + '/leaderboard.png' });
  // community
  await page.goto('http://localhost:4173/#/community/chat/btc');
  await page.waitForTimeout(800);
  console.log('community:', (await page.locator('.chat-main').innerText()).replace(/\s+/g, ' ').slice(0, 120));
  await page.goto('http://localhost:4173/#/community/ideas');
  await page.waitForTimeout(500);
  console.log('ideas tab:', (await page.locator('.ideas h2').innerText()));
  console.log('errors:', JSON.stringify(errors.slice(0, 5)));
  await browser.close();
})();
