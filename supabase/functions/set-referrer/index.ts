// POST { message, signature } → records who referred the signing wallet. The first confirmation is final.
import { admin, cors, json, verifyRequest } from '../_shared/verify.ts';
import { validateReferrer } from '../_shared/proof.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const raw: { signature?: string } = await req.clone().json().catch(() => ({}));
  const parsed = await verifyRequest(req, 'set-referrer');
  if (parsed instanceof Response) return parsed;
  const r = validateReferrer(parsed.payload, parsed.address);
  if (typeof r === 'string') return json({ error: r }, 400);
  const db = admin();
  const { data: existing } = await db.from('referrals').select('referrer').eq('referee', parsed.address).maybeSingle();
  if (existing) return json({ error: 'Your referrer is already recorded.' }, 409);
  // No referral loops: the referrer must not have been referred by this wallet.
  const { data: loop } = await db.from('referrals').select('referee').eq('referee', r.referrer).eq('referrer', parsed.address).maybeSingle();
  if (loop) return json({ error: 'That wallet was referred by you.' }, 400);
  const { error } = await db.from('referrals').insert({ referee: parsed.address, referrer: r.referrer, signature: raw.signature! });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
});
