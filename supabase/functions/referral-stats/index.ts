// POST { address } → the wallets it referred and the HyperSpace builder fees they paid since joining.
// Read from Hyperliquid fills; cached for 10 minutes. Payouts are manual (the "earned" figure is what is owed).
import { admin, cors, hlInfo, json } from '../_shared/verify.ts';

const SHARE = Number(Deno.env.get('REFERRAL_SHARE_PCT') ?? 20);
const BUILDER = (Deno.env.get('BUILDER_ADDRESS') ?? '').toLowerCase();

interface Fill {
  px: string;
  sz: string;
  time: number;
  builderFee?: string;
}

async function feesSince(user: string, start: number) {
  let fees = 0;
  let volume = 0;
  let from = start;
  for (let page = 0; page < 10; page++) {
    const fills = await hlInfo<Fill[]>({ type: 'userFillsByTime', user, startTime: from, aggregateByTime: true });
    for (const f of fills) {
      const bf = Number(f.builderFee ?? 0);
      if (bf > 0) {
        fees += bf;
        volume += Number(f.px) * Number(f.sz);
      }
    }
    if (fills.length < 2000) break;
    from = fills[fills.length - 1].time + 1;
  }
  return { fees, volume };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const { address } = await req.json().catch(() => ({}));
  if (typeof address !== 'string' || !/^0x[0-9a-f]{40}$/.test(address)) return json({ error: 'address required' }, 400);
  const db = admin();
  const key = `referral-stats:${address}`;
  const { data: cached } = await db.from('kv').select('value, updated_at').eq('key', key).maybeSingle();
  if (cached && Date.now() - Date.parse(cached.updated_at) < 10 * 60_000) return json(cached.value);

  const { data: refs } = await db.from('referrals').select('referee, created_at').eq('referrer', address).order('created_at').limit(500);
  const referees = [];
  for (const r of refs ?? []) {
    // Builder fees only count when this deployment has a builder address set.
    const s = BUILDER ? await feesSince(r.referee, Date.parse(r.created_at)) : { fees: 0, volume: 0 };
    referees.push({ address: r.referee, joined: r.created_at, builderFees: s.fees, volume: s.volume });
  }
  const totalFees = referees.reduce((a, r) => a + r.builderFees, 0);
  const out = { referrer: address, sharePct: SHARE, referees, totalFees, earned: (totalFees * SHARE) / 100, updatedAt: new Date().toISOString() };
  await db.from('kv').upsert({ key, value: out, updated_at: out.updatedAt }, { onConflict: 'key' });
  return json(out);
});
