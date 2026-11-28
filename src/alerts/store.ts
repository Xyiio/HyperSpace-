// Alerts and watched wallets, saved in this browser. When the backend is connected they are
// also synced (see sync.ts) so Telegram alerts keep working with the tab closed.
import { useEffect, useState } from 'react';
import type { Pt } from '../hl/drawings';
import { NETWORK } from '../hl/network';
import { currentLimits, limitMessage } from '../token/premium';

export type AlertKind = 'price' | 'drawing' | 'funding' | 'bigTrade' | 'wallet' | 'listing';

export interface Alert {
  id: string;
  kind: AlertKind;
  createdAt: number;
  active: boolean;
  /** Fire every time (with a cool-down) instead of once. */
  repeat: boolean;
  lastFired?: number;
  coin?: string;
  op?: 'above' | 'below' | 'cross';
  /** price: price; funding: % per hour; bigTrade: minimum USD. */
  value?: number;
  /** Price when the alert was made, so "above" means crossing up from here. */
  refPx?: number;
  /** drawing alerts: the line, copied so it also works on the server. */
  drawingId?: string;
  line?: { kind: 'hline' | 'trend'; a: Pt; b: Pt };
  /** wallet watch */
  address?: string;
  label?: string;
}

const KEY = `hs.alerts.${NETWORK}`;
const listeners = new Set<(a: Alert[]) => void>();

function read(): Alert[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Alert[];
  } catch {
    return [];
  }
}

let current: Alert[] = read();

function write(list: Alert[]) {
  current = list;
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* not persisted */
  }
  listeners.forEach((l) => l(list));
}

export const getAlerts = () => current;

export function subscribeAlerts(l: (a: Alert[]) => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const isWatch = (a: Alert) => a.kind === 'wallet';

/** Adds an alert; returns an error message when a free-plan limit is reached. */
export function addAlert(a: Omit<Alert, 'id' | 'createdAt' | 'active'>): string | null {
  const lim = currentLimits();
  if (isWatch(a as Alert)) {
    if (current.filter(isWatch).length >= lim.walletWatch) return limitMessage('walletWatch');
    if (current.some((x) => x.kind === 'wallet' && x.address === a.address)) return 'You already watch this wallet.';
  } else if (current.filter((x) => !isWatch(x)).length >= lim.alerts) return limitMessage('alerts');
  write([...current, { ...a, id: crypto.randomUUID(), createdAt: Date.now(), active: true }]);
  return null;
}

export function updateAlert(id: string, patch: Partial<Alert>) {
  write(current.map((a) => (a.id === id ? { ...a, ...patch } : a)));
}

export function removeAlert(id: string) {
  write(current.filter((a) => a.id !== id));
}

export function replaceAlerts(list: Alert[]) {
  write(list);
}

export function useAlerts(): Alert[] {
  const [list, setList] = useState(current);
  useEffect(() => subscribeAlerts(setList), []);
  return list;
}

/** Price of a horizontal or trend line at time t (trend lines extend past their end point). */
export function linePriceAt(line: NonNullable<Alert['line']>, t: number): number {
  if (line.kind === 'hline' || line.b.t === line.a.t) return line.a.p;
  return line.a.p + ((line.b.p - line.a.p) * (t - line.a.t)) / (line.b.t - line.a.t);
}

/** True when price moved from `prev` to `now` across `level` in the alert's direction. */
export function crossed(op: Alert['op'], prev: number, now: number, level: number, prevLevel = level): boolean {
  const up = prev < prevLevel && now >= level;
  const down = prev > prevLevel && now <= level;
  return op === 'above' ? up : op === 'below' ? down : up || down;
}

export function describeAlert(a: Alert): string {
  const fmt = (v?: number) => (v === undefined ? '' : Number(v.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 8 }));
  switch (a.kind) {
    case 'price':
      return `${a.coin} ${a.op === 'below' ? 'falls to' : a.op === 'above' ? 'rises to' : 'crosses'} ${fmt(a.value)}`;
    case 'drawing':
      return `${a.coin} crosses your ${a.line?.kind === 'trend' ? 'trend line' : 'line at ' + fmt(a.line?.a.p)}`;
    case 'funding':
      return `${a.coin} funding ${a.op === 'below' ? 'below' : 'above'} ${a.value}%/h`;
    case 'bigTrade':
      return `${a.coin} trade of $${fmt(a.value)} or more`;
    case 'wallet':
      return `${a.label || a.address} opens or closes a position`;
    case 'listing':
      return 'A new market lists on Hyperliquid (including HIP-3 stocks)';
  }
}
