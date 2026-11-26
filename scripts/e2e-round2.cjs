// Round-2 chart features against live data: watchlist, drawing edit/colour/delete, pen, text, arrows,
// chart styles, volume profile, ghost candle, saved heatmap history.
const { chromium } = require('playwright');
const SHOT = process.env.SHOT || '.';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
  const log = (...a) => console.log(...a);
  await page.goto('http://localhost:4173/?debug#/trade/BTC');
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.waitForTimeout(2500);

  // Watchlist
  const rows = await page.locator('.wl-row').allInnerTexts();
  log('watchlist rows:', rows.map((r) => r.replace(/\s+/g, ' ').trim()).join(' | '));
  await page.fill('.wl-search input', 'gold');
  await page.waitForTimeout(200);
  log('search gold:', (await page.locator('.wl-results button').allInnerTexts()).slice(0, 3).join(' / '));
  await page.locator('.wl-results button').first().click();
  log('after add:', (await page.locator('.wl-row .wl-ticker').allInnerTexts()).join(','));
  // rename first section
  await page.locator('.wl-name').first().dblclick();
  await page.fill('.wl-rename', 'Majors');
  await page.keyboard.press('Enter');
  log('section names:', (await page.locator('.wl-name').allInnerTexts()).join(' / '));
  // drag SOL before BTC
  const sol = page.locator('.wl-row', { hasText: 'SOL' }).first();
  const btc = page.locator('.wl-row', { hasText: 'BTC' }).first();
  await sol.dragTo(btc);
  await page.waitForTimeout(200);
  log('after drag:', (await page.locator('.wl-row .wl-ticker').allInnerTexts()).join(','));
  await page.locator('.wl-row', { hasText: 'ETH' }).first().click();
  await page.waitForTimeout(1500);
  log('route after click:', await page.evaluate(() => location.hash));
  await page.goto('http://localhost:4173/?debug#/trade/BTC');
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.waitForTimeout(1500);

  const box = await page.locator('.chart-host').boundingBox();
  const kinds = () => page.evaluate(() => JSON.parse(localStorage.getItem('hs.drawings.BTC') || '[]').map((d) => d.kind + ':' + d.color).join(','));
  // trend, pen, arrows, text
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 150, box.y + 300); await page.waitForTimeout(80);
  await page.mouse.click(box.x + 350, box.y + 150); await page.waitForTimeout(200);
  await page.keyboard.press('p');
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) await page.mouse.move(box.x + 400 + i * 8, box.y + 300 - Math.sin(i / 3) * 40);
  await page.mouse.up();
  await page.waitForTimeout(200);
  await page.keyboard.press('u');
  await page.mouse.click(box.x + 250, box.y + 420); await page.waitForTimeout(150);
  await page.keyboard.press('d');
  await page.mouse.click(box.x + 300, box.y + 120); await page.waitForTimeout(150);
  await page.keyboard.press('x');
  await page.mouse.click(box.x + 520, box.y + 380); await page.waitForTimeout(300);
  await page.keyboard.type('Breakout retest here');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  log('drawings:', await kinds());
  // select the trend line and recolour + delete only it
  await page.mouse.click(box.x + 250, box.y + 225); await page.waitForTimeout(600);
  log('edit bar:', await page.locator('.draw-edit').isVisible());
  await page.locator('.draw-edit .swatch').nth(1).click();
  log('after recolour:', await kinds());
  await page.screenshot({ path: SHOT + '/r2-drawings.png' });
  await page.locator('.draw-edit .danger').click();
  log('after delete one:', await kinds());

  // style
  await page.getByRole('button', { name: 'Chart style ▾' }).click();
  await page.locator('.style-menu select').selectOption('hollow');
  await page.getByRole('button', { name: /Classic/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: SHOT + '/r2-hollow-classic.png' });
  await page.locator('.style-menu select').selectOption('area');
  await page.waitForTimeout(300);
  log('series after area:', await page.evaluate(() => window.__hl.chart.panes()[0].getSeries().map((s) => s.seriesType()).join(',')));
  await page.locator('.style-menu select').selectOption('candles');
  await page.getByRole('button', { name: /HyperSpace/ }).click();
  await page.getByRole('button', { name: 'Chart style ▾' }).click();

  // profile + prediction
  await page.getByLabel('Volume profile').check();
  await page.getByLabel('Next-candle prediction').check();
  await page.waitForTimeout(3000);
  log('prediction readout:', (await page.locator('.pred-read').innerText().catch(() => 'none')).replace(/\s+/g, ' '));
  await page.screenshot({ path: SHOT + '/r2-profile-ghost.png' });

  // heatmap history survives reload
  await page.waitForTimeout(31000);
  const before = await page.evaluate(() => window.__hl.heat.snapshots.length);
  await page.reload();
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => window.__hl.heat.snapshots.length);
  log(`heatmap columns before reload ${before}, right after reload ${after}`);
  log('errors:', JSON.stringify(errors.slice(0, 5)));
  await browser.close();
})();
