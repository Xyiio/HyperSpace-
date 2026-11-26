// Pen follows curves (and stays on for more strokes); drawings can be dragged and reshaped without panning the chart.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:4173/?debug#/trade/BTC');
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.waitForTimeout(2000);
  const box = await page.locator('.chart-host').boundingBox();
  const X = (f) => box.x + box.width * f;
  const Y = (f) => box.y + box.height * f;
  const get = () => page.evaluate(() => JSON.parse(localStorage.getItem('hs.drawings.BTC') || '[]'));
  const range = () => page.evaluate(() => JSON.stringify(window.__hl.chart.timeScale().getVisibleLogicalRange()));

  // Pen: an S-curve, then a second stroke while the pen is still on.
  await page.keyboard.press('p');
  await page.mouse.move(X(0.2), Y(0.5));
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) await page.mouse.move(X(0.2 + i * 0.006), Y(0.5 - Math.sin(i / 6) * 0.12));
  await page.mouse.up();
  await page.mouse.move(X(0.3), Y(0.7));
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(X(0.3 + i * 0.01), Y(0.7 + i * 0.005));
  await page.mouse.up();
  await page.keyboard.press('Escape');
  let ds = await get();
  const pen = ds[0];
  const ps = pen.pts.map((q) => q.p);
  const turns = ps.slice(2).filter((p, i) => Math.sign(p - ps[i + 1]) !== Math.sign(ps[i + 1] - ps[i])).length;
  console.log('pen strokes:', ds.filter((d) => d.kind === 'pen').length, 'points in first:', pen.pts.length, 'direction changes:', turns);

  // Trend line, then drag the whole line and one end point; the chart must not pan.
  await page.keyboard.press('t');
  await page.mouse.click(X(0.4), Y(0.3)); await page.waitForTimeout(80);
  await page.mouse.click(X(0.55), Y(0.2)); await page.waitForTimeout(300);
  ds = await get();
  const t0 = ds.find((d) => d.kind === 'trend');
  const before = await range();
  await page.mouse.move(X(0.475), Y(0.25));
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(X(0.475 - i * 0.01), Y(0.25 + i * 0.01));
  await page.mouse.up();
  await page.waitForTimeout(200);
  ds = await get();
  const t1 = ds.find((d) => d.kind === 'trend');
  console.log('moved trend: dp a', (t1.a.p - t0.a.p).toFixed(1), 'dp b', (t1.b.p - t0.b.p).toFixed(1), 'dt a(min)', ((t1.a.t - t0.a.t) / 60000).toFixed(1), 'chart panned:', before !== (await range()));
  // drag end point b
  const bx = X(0.55 - 0.1), by = Y(0.2 + 0.1);
  await page.mouse.move(bx, by);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(bx + i * 10, by - i * 8);
  await page.mouse.up();
  await page.waitForTimeout(200);
  ds = await get();
  const t2 = ds.find((d) => d.kind === 'trend');
  console.log('end point: a unchanged', t2.a.p === t1.a.p, 'b moved', (t2.b.p - t1.b.p).toFixed(1));
  // drag a text box
  await page.keyboard.press('x');
  await page.mouse.click(X(0.6), Y(0.6)); await page.waitForTimeout(250);
  await page.keyboard.type('note'); await page.keyboard.press('Enter');
  ds = await get();
  const tx0 = ds.find((d) => d.kind === 'text');
  await page.mouse.move(X(0.6) + 10, Y(0.6) + 8);
  await page.mouse.down();
  await page.mouse.move(X(0.6) + 60, Y(0.6) + 60, { steps: 6 });
  await page.mouse.up();
  ds = await get();
  const tx1 = ds.find((d) => d.kind === 'text');
  console.log('text moved:', tx1.a.p !== tx0.a.p && tx1.a.t !== tx0.a.t, 'staged price:', await page.locator('.ticket input').first().inputValue());
  // plain drag on empty chart still pans
  const r0 = await range();
  await page.mouse.move(X(0.5), Y(0.85)); await page.mouse.down(); await page.mouse.move(X(0.3), Y(0.85), { steps: 8 }); await page.mouse.up();
  console.log('empty drag pans:', r0 !== (await range()));
  await page.screenshot({ path: (process.env.SHOT || '.') + '/drag.png' });
  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
