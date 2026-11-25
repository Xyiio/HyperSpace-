// POST { message, signature } → creates or updates the signer's chartist profile.
import { admin, cors, json, verifyRequest } from '../_shared/verify.ts';
import { validateProfile } from '../_shared/proof.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const raw = await req.clone().json().catch(() => ({}));
  const parsed = await verifyRequest(req, 'save-profile');
  if (parsed instanceof Response) return parsed;
  const p = validateProfile(parsed.payload);
  if (typeof p === 'string') return json({ error: p }, 400);
  const { data, error } = await admin()
    .from('profiles')
    .upsert({ address: parsed.address, display_name: p.displayName, bio: p.bio, twitter: p.twitter, signature: raw.signature, updated_at: new Date().toISOString() })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ profile: data });
});
