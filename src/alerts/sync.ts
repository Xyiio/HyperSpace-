// Keeps the backend's copy of your alerts up to date so its scheduled job can send them to
// Telegram while HyperSpace is closed. Needs the Supabase backend and a wallet session.
import { useEffect, useState } from 'react';
import { socialEnabled, syncAlertsRemote, telegramSend, walletSession, type AlertSyncStatus } from '../social/client';
import { getAlerts, replaceAlerts, subscribeAlerts, type AlertKind } from './store';
import { setTelegramSender } from './notify';
import { loadDrawings } from '../hl/drawings';

let status: AlertSyncStatus | null = null;
const statusListeners = new Set<(s: AlertSyncStatus | null) => void>();

/** The server's job covers these kinds; big-trade alerts need a live stream, so only the browser sends them. */
const SERVER_KINDS: AlertKind[] = ['price', 'drawing', 'funding', 'wallet', 'listing'];

/** True when the backend will deliver this alert to Telegram itself (linked, and its job ran in the last 5 minutes). */
export function serverDelivers(kind: AlertKind) {
  return !!status?.telegramLinked && !!status.lastRun && Date.now() - Date.parse(status.lastRun) < 5 * 60_000 && SERVER_KINDS.includes(kind);
}

function setStatus(s: AlertSyncStatus | null) {
  status = s;
  statusListeners.forEach((l) => l(s));
}

export function useSyncStatus() {
  const [s, setS] = useState(status);
  useEffect(() => {
    statusListeners.add(setS);
    return () => {
      statusListeners.delete(setS);
    };
  }, []);
  return s;
}

/** Refresh drawing alerts with the line as it is now, in case it was moved. */
function withCurrentLines() {
  return getAlerts().map((a) => {
    if (a.kind !== 'drawing' || !a.coin || !a.drawingId) return a;
    const d = loadDrawings(a.coin).find((x) => x.id === a.drawingId);
    return d && (d.kind === 'hline' || d.kind === 'trend') ? { ...a, line: { kind: d.kind, a: d.a, b: d.b } } : a;
  });
}

function applyFired(fired: Record<string, number>) {
  let changed = false;
  const next = getAlerts().map((a) => {
    const t = fired[a.id];
    if (!t || (a.lastFired && a.lastFired >= t)) return a;
    changed = true;
    const stream = a.kind === 'wallet' || a.kind === 'listing';
    return { ...a, lastFired: t, active: a.repeat || stream ? a.active : false };
  });
  if (changed) replaceAlerts(next);
}

export async function pushAlerts(address: string) {
  const s = await syncAlertsRemote(address, withCurrentLines());
  setStatus(s);
  applyFired(s.fired);
  return s;
}

/** Mounted once in the app: syncs on change and every 5 minutes, and installs Telegram delivery. */
export function AlertSync({ address }: { address: string | null }) {
  const [, force] = useState(0);
  useEffect(() => {
    setTelegramSender(null);
    setStatus(null);
    if (!socialEnabled || !address) return;
    let timer: number | undefined;
    let alive = true;
    const run = async () => {
      if (!walletSession(address)) return;
      try {
        const s = await pushAlerts(address);
        if (!alive) return;
        setTelegramSender(s.telegramLinked ? (title, body, link) => telegramSend(address, title, body, link).then(() => {}) : null);
        force((n) => n + 1);
      } catch {
        /* backend unreachable: browser alerts still work */
      }
    };
    void run();
    const unsub = subscribeAlerts(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(run, 2000);
    });
    const every = window.setInterval(run, 5 * 60_000);
    return () => {
      alive = false;
      unsub();
      window.clearTimeout(timer);
      window.clearInterval(every);
    };
  }, [address]);
  return null;
}
