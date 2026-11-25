// Quick clicks (inside the double-click window) must place both points, and switching tools mid-drawing cancels the draft.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:4173/#/trade/BTC');
  await page.evaluate(() => localStorage.removeItem('hs.drawings.BTC'));
  await page.reload();
  await page.waitForSelector('.ladder-row', { timeout: 30000 });
  await page.waitForTimeout(1500);
  const box = await page.locator('.chart-host').boundingBox();
  const kinds = () => page.evaluate(() => JSON.parse(localStorage.getItem('hs.drawings.BTC') || '[]').map((d) => d.kind).join(','));
  // Back-to-back clicks, 100ms apart.
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 150, box.y + 300); await page.waitForTimeout(100);
  await page.mouse.click(box.x + 350, box.y + 150); await page.waitForTimeout(100);
  await page.keyboard.press('f');
  await page.mouse.click(box.x + 380, box.y + 100); await page.waitForTimeout(100);
  await page.mouse.click(box.x + 520, box.y + 300); await page.waitForTimeout(300);
  console.log('quick clicks:', await kinds(), '(want trend,fib)');
  const pts = await page.evaluate(() => JSON.parse(localStorage.getItem('hs.drawings.BTC')).map((d) => d.a.t !== d.b.t));
  console.log('distinct endpoints:', pts.join(','));
  // T, click, R, click -> the trend draft is dropped and a rectangle draft starts.
  await page.keyboard.press('t');
  await page.mouse.click(box.x + 200, box.y + 200); await page.waitForTimeout(100);
  await page.keyboard.press('r');
  await page.waitForTimeout(100);
  await page.mouse.click(box.x + 250, box.y + 250); await page.waitForTimeout(100);
  await page.mouse.click(box.x + 350, box.y + 350); await page.waitForTimeout(300);
  console.log('after tool switch:', await kinds(), '(want trend,fib,rect)');
  console.log('order price staged by drawing clicks:', await page.locator('.ticket input').first().inputValue().catch(() => 'n/a'));
  console.log('errors:', JSON.stringify(errors));
  await browser.close();
})();
