// Playwright check of the wallet + trading flow against live market data, with a simulated
// browser wallet and a mocked Hyperliquid account. Nothing signed here is sent to Hyperliquid:
// /exchange and the account-specific /info calls are intercepted.
// Usage: VITE_BUILDER_ADDRESS=0x1111111111111111111111111111111111111111 npm run build && npx vite preview --port 4173 & node scripts/e2e-wallet.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright');
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';

const main = privateKeyToAccount(generatePrivateKey());
const sent = [];
let approvedAgent = null;
let approvedFee = 0;
const resting = [];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.exposeFunction('__signTypedData', async (json) => {
  const td = JSON.parse(json);
  const { EIP712Domain, ...types } = td.types;
  return main.signTypedData({ domain: td.domain, types, primaryType: td.primaryType, message: td.message });
});
await page.addInitScript((addr) => {
  const provider = {
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [addr];
      if (method === 'eth_chainId') return '0xa4b1';
      if (method === 'eth_signTypedData_v4') return window.__signTypedData(params[1]);
      throw new Error('unsupported ' + method);
    },
    on() {},
    removeListener() {},
  };
  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { uuid: 'test', name: 'Test Wallet', icon: '', rdns: 'test' }, provider } }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}, main.address);

await page.route('https://api.hyperliquid.xyz/**', async (route) => {
  const req = route.request();
  const url = req.url();
  const body = req.postDataJSON();
  if (url.endsWith('/exchange')) {
    sent.push(body);
    const a = body.action;
    if (a.type === 'approveAgent') {
      const signer = await recoverTypedDataAddress({
        domain: { name: 'HyperliquidSignTransaction', version: '1', chainId: parseInt(a.signatureChainId, 16), verifyingContract: '0x0000000000000000000000000000000000000000' },
        types: { 'HyperliquidTransaction:ApproveAgent': [
          { name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }] },
        primaryType: 'HyperliquidTransaction:ApproveAgent',
        message: { hyperliquidChain: a.hyperliquidChain, agentAddress: a.agentAddress, agentName: a.agentName, nonce: BigInt(a.nonce) },
        signature: { r: body.signature.r, s: body.signature.s, v: BigInt(body.signature.v) },
      });
      console.log('approveAgent signed by main wallet:', signer === main.address, '| chain', a.hyperliquidChain, '| name', a.agentName);
      approvedAgent = a.agentAddress.toLowerCase();
      return route.fulfill({ json: { status: 'ok', response: { type: 'default' } } });
    }
    if (a.type === 'approveBuilderFee') {
      approvedFee = Math.round(parseFloat(a.maxFeeRate) * 1000);
      return route.fulfill({ json: { status: 'ok', response: { type: 'default' } } });
    }
    if (a.type === 'order') {
      const o = a.orders[0];
      resting.push({ coin: 'BTC', side: o.b ? 'B' : 'A', limitPx: o.p, sz: o.s, origSz: o.s, oid: 4242 + resting.length, timestamp: Date.now(), orderType: 'Limit', reduceOnly: o.r, tif: 'Gtc' });
      return route.fulfill({ json: { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid: resting.at(-1).oid } }] } } } });
    }
    if (a.type === 'cancel') {
      const i = resting.findIndex((r) => r.oid === a.cancels[0].o);
      if (i >= 0) resting.splice(i, 1);
      return route.fulfill({ json: { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } } });
    }
  }
  if (url.endsWith('/info')) {
    const t = body?.type;
    if (t === 'extraAgents') return route.fulfill({ json: approvedAgent ? [{ name: 'HyperSpace', address: approvedAgent, validUntil: Date.now() + 86400000 }] : [] });
    if (t === 'maxBuilderFee') return route.fulfill({ json: approvedFee });
    if (t === 'clearinghouseState' && body.user?.toLowerCase() === main.address.toLowerCase())
      return route.fulfill({ json: { assetPositions: [], marginSummary: { accountValue: '1000', totalNtlPos: '0', totalMarginUsed: '0' }, withdrawable: '1000', time: Date.now() } });
    if (t === 'frontendOpenOrders') return route.fulfill({ json: body.dex ? [] : resting });
  }
  return route.continue();
});

await page.goto('http://localhost:4173/#/trade/BTC');
await page.waitForSelector('.ladder-row', { timeout: 30000 });
await page.getByRole('button', { name: 'Connect wallet' }).click();
await page.getByRole('button', { name: 'Test Wallet' }).click();
await page.getByRole('button', { name: 'Enable trading' }).waitFor();
await page.getByRole('button', { name: 'Enable trading' }).click();
// Stage a buy 3% under the mark from the bottom of the bid ladder.
await page.locator('.ladder-row.bid').last().click();
const buy = page.locator('button.submit');
await buy.waitFor();
await page.waitForFunction(() => /^Buy /.test(document.querySelector('button.submit')?.textContent ?? ''), null, { timeout: 15000 });
console.log('button before:', await buy.innerText());
await buy.click();
console.log('button after first click:', await buy.innerText());
await buy.click();
await page.waitForSelector('.hint.ok', { timeout: 10000 });
console.log('result:', await page.locator('.hint.ok').innerText());
await page.getByRole('button', { name: /Open orders \(1\)/ }).click({ timeout: 10000 });
await page.screenshot({ path: process.env.SHOT ?? 'wallet-flow.png' });
await page.getByRole('button', { name: 'Cancel' }).click();
await page.getByRole('button', { name: /Open orders \(0\)/ }).waitFor({ timeout: 10000 });

const order = sent.find((s) => s.action.type === 'order');
console.log('exchange actions:', sent.map((s) => s.action.type).join(', '));
console.log('order:', JSON.stringify(order.action));
console.log('order signed (r,s,v present):', !!(order.signature?.r && order.signature?.s && order.signature?.v));
console.log('builder fee approved at', approvedFee, 'tenths of a bp');
console.log('page errors:', JSON.stringify(errors));
await browser.close();
