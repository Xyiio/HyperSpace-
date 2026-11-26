// POST { message, signature } → stores a trade idea stamped with the author's live Hyperliquid state.
import { admin, cors, hlInfo, json, verifyRequest } from '../_shared/verify.ts';
import { validateIdea } from '../_shared/proof.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const raw: { message?: string; signature?: string } = await req.clone().json().catch(() => ({}));
  const parsed = await verifyRequest(req, 'post-idea');
  if (parsed instanceof Response) return parsed;
  const idea = validateIdea(parsed.payload);
  if (typeof idea === 'string') return json({ error: idea }, 400);

  const dex = idea.coin.includes(':') ? idea.coin.split(':')[0] : '';
  const db = admin();
  const signature = raw.signature!;

  // Replay protection: one idea per signature.
  const dup = await db.from('ideas').select('id').eq('signature', signature).maybeSingle();
  if (dup.data) return json({ error: 'Already posted.' }, 409);

  // Rate limit: 10 ideas per wallet per day.
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await db.from('ideas').select('id', { count: 'exact', head: true }).eq('author', parsed.address).gte('created_at', since);
  if ((count ?? 0) >= 10) return json({ error: 'Daily limit of 10 ideas reached.' }, 429);

  // Stamp: market price plus the author's position, account value and all-time PnL right now.
  const [mids, state, portfolio] = await Promise.all([
    hlInfo<Record<string, string>>({ type: 'allMids', dex }),
    hlInfo<{ assetPositions: { position: Record<string, unknown> }[]; marginSummary: { accountValue: string } }>({ type: 'clearinghouseState', user: parsed.address, dex }),
    hlInfo<[string, { pnlHistory: [number, string][] }][]>({ type: 'portfolio', user: parsed.address }),
  ]);
  const mark = Number(mids[idea.coin]);
  if (!Number.isFinite(mark)) return json({ error: `Unknown market ${idea.coin}` }, 400);
  const position = state.assetPositions.find((a) => a.position.coin === idea.coin)?.position ?? null;
  const allTime = portfolio.find(([p]) => p === 'allTime')?.[1].pnlHistory ?? [];
  const snapshot = {
    position,
    accountValue: state.marginSummary.accountValue,
    allTimePnl: allTime.length ? allTime[allTime.length - 1][1] : null,
    readAt: Date.now(),
  };

  const { data, error } = await db
    .from('ideas')
    .insert({
      author: parsed.address,
      coin: idea.coin,
      dex,
      direction: idea.direction,
      entry: idea.entry,
      target: idea.target,
      stop: idea.stop,
      timeframe: idea.timeframe,
      body: idea.body,
      mark_at_post: mark,
      snapshot,
      signed_message: raw.message,
      signature,
    })
    .select()
    .single();
  if (error) return json({ error: error.message }, 500);
  return json({ idea: data });
});
