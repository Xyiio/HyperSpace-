// POST { message, signature } → rates an indicator 1 to 5 stars (one rating per wallet, updatable).
import { admin, cors, json, verifyRequest } from '../_shared/verify.ts';
import { validateRating } from '../_shared/proof.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const raw: { signature?: string } = await req.clone().json().catch(() => ({}));
  const parsed = await verifyRequest(req, 'rate-script');
  if (parsed instanceof Response) return parsed;
  const r = validateRating(parsed.payload);
  if (typeof r === 'string') return json({ error: r }, 400);
  const db = admin();
  const { data: script } = await db.from('scripts').select('author').eq('id', r.scriptId).maybeSingle();
  if (!script) return json({ error: 'Indicator not found.' }, 404);
  if (script.author === parsed.address) return json({ error: 'You cannot rate your own indicator.' }, 400);
  const { error } = await db
    .from('script_ratings')
    .upsert({ script_id: r.scriptId, rater: parsed.address, stars: r.stars, signature: raw.signature!, created_at: new Date().toISOString() }, { onConflict: 'script_id,rater' });
  if (error) return json({ error: /duplicate/.test(error.message) ? 'Already submitted.' : error.message }, 400);
  return json({ ok: true });
});
