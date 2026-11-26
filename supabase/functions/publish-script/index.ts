// POST { message, signature, code } → publishes (or updates) a HyperScript indicator in the marketplace.
import { admin, cors, json, verifyRequest } from '../_shared/verify.ts';
import { MAX_SCRIPT_CHARS, sha256Hex, validateScript } from '../_shared/proof.ts';

const MAX_PER_DAY = 20;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const raw = await req.clone().json().catch(() => ({}));
  const parsed = await verifyRequest(req, 'publish-script');
  if (parsed instanceof Response) return parsed;
  const s = validateScript(parsed.payload);
  if (typeof s === 'string') return json({ error: s }, 400);
  const code = typeof raw.code === 'string' ? raw.code : '';
  if (!code.trim() || code.length > MAX_SCRIPT_CHARS) return json({ error: `Code must be 1 to ${MAX_SCRIPT_CHARS.toLocaleString()} characters.` }, 400);
  if ((await sha256Hex(code)) !== s.codeSha256) return json({ error: 'The code does not match what you signed.' }, 400);

  const db = admin();
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from('scripts').select('id', { count: 'exact', head: true }).eq('author', parsed.address).gte('updated_at', since);
  if ((count ?? 0) >= MAX_PER_DAY) return json({ error: `You can publish ${MAX_PER_DAY} times a day.` }, 429);

  const row = {
    author: parsed.address,
    name: s.name,
    description: s.description,
    price_hs: s.priceHs,
    code_sha256: s.codeSha256,
    signature: raw.signature,
    updated_at: new Date().toISOString(),
  };
  let script;
  if (s.scriptId) {
    const { data: existing } = await db.from('scripts').select('id, author, version').eq('id', s.scriptId).maybeSingle();
    if (!existing) return json({ error: 'Script not found.' }, 404);
    if (existing.author !== parsed.address) return json({ error: 'Only the author can update this script.' }, 403);
    const { data, error } = await db.from('scripts').update({ ...row, version: existing.version + 1 }).eq('id', s.scriptId).select().single();
    if (error) return json({ error: error.message }, 500);
    script = data;
  } else {
    const { data, error } = await db.from('scripts').insert(row).select().single();
    if (error) return json({ error: error.message }, 500);
    script = data;
  }
  const { error: codeErr } = await db.from('script_code').upsert({ script_id: script.id, code });
  if (codeErr) return json({ error: codeErr.message }, 500);
  return json({ script });
});
