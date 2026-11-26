// GET/POST → the reduced Hyperliquid leaderboard, cached in the database for 10 minutes so each
// visitor downloads a few hundred KB instead of Hyperliquid's full ~40 MB file.
import { admin, cors, json } from '../_shared/verify.ts';
import { LEADERBOARD_URL, reduceLeaderboard, type RawLeaderboardRow } from '../_shared/leaderboard.ts';

const FRESH_MS = 10 * 60_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const db = admin();
  const { data: cached } = await db.from('leaderboard_cache').select('data, fetched_at').eq('id', 1).maybeSingle();
  if (cached && Date.now() - Date.parse(cached.fetched_at) < FRESH_MS) return json(cached.data);
  try {
    const r = await fetch(LEADERBOARD_URL);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { leaderboardRows } = (await r.json()) as { leaderboardRows: RawLeaderboardRow[] };
    const data = reduceLeaderboard(leaderboardRows);
    await db.from('leaderboard_cache').upsert({ id: 1, data, fetched_at: new Date().toISOString() });
    return json(data);
  } catch (e) {
    // Serve stale data rather than nothing.
    if (cached) return json(cached.data);
    return json({ error: `Could not load the leaderboard: ${(e as Error).message}` }, 502);
  }
});
