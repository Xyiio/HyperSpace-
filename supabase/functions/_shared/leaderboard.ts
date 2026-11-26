// Reduces Hyperliquid's full leaderboard (tens of thousands of rows, ~40 MB) to the top traders
// per time window. Shared by the browser and the leaderboard edge function.

export type LbWindow = 'day' | 'week' | 'month' | 'allTime';
export const LB_WINDOWS: LbWindow[] = ['day', 'week', 'month', 'allTime'];

export interface RawLeaderboardRow {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
}

export interface Trader {
  address: string;
  name: string | null;
  accountValue: number;
  pnl: number;
  roi: number;
  volume: number;
}

export interface Leaderboard {
  fetchedAt: number;
  traders: number; // rows in the source
  byPnl: Record<LbWindow, Trader[]>;
  byRoi: Record<LbWindow, Trader[]>;
}

/**
 * ROI ranking ignores tiny accounts, where a few dollars of PnL is a huge percentage, and ROI above
 * 1,000%, which in this data comes from deposits into a near-empty account rather than trading.
 */
export const MIN_ROI_ACCOUNT = 10_000;
export const MAX_ROI = 10;
const TOP = 200;

export function reduceLeaderboard(rows: RawLeaderboardRow[], now = Date.now()): Leaderboard {
  const byPnl = {} as Record<LbWindow, Trader[]>;
  const byRoi = {} as Record<LbWindow, Trader[]>;
  for (const w of LB_WINDOWS) {
    const list: Trader[] = [];
    for (const r of rows) {
      const perf = r.windowPerformances.find(([k]) => k === w)?.[1];
      if (!perf) continue;
      list.push({
        address: r.ethAddress.toLowerCase(),
        name: r.displayName,
        accountValue: Number(r.accountValue),
        pnl: Number(perf.pnl),
        roi: Number(perf.roi),
        volume: Number(perf.vlm),
      });
    }
    byPnl[w] = [...list].sort((a, b) => b.pnl - a.pnl).slice(0, TOP);
    byRoi[w] = list
      .filter((t) => t.accountValue >= MIN_ROI_ACCOUNT && t.volume > 0 && t.roi <= MAX_ROI)
      .sort((a, b) => b.roi - a.roi)
      .slice(0, TOP);
  }
  return { fetchedAt: now, traders: rows.length, byPnl, byRoi };
}

export const LEADERBOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
