// Delivery for alerts: an in-app toast, a browser notification, an optional sound, and
// Telegram through the HyperSpace backend when it is connected and linked.
import { useEffect, useState } from 'react';

export interface Toast {
  id: number;
  title: string;
  body: string;
  link?: string;
  time: number;
}

export interface NotifySettings {
  browser: boolean;
  sound: boolean;
  telegram: boolean;
}

const SETTINGS = 'hs.notify';
const listeners = new Set<(t: Toast[]) => void>();
let toasts: Toast[] = [];
let nextId = 1;
/** Hook for Telegram delivery, installed by the backend client when a chat is linked. */
let telegram: ((title: string, body: string, link?: string) => Promise<void>) | null = null;

export function setTelegramSender(f: typeof telegram) {
  telegram = f;
}

export function getNotifySettings(): NotifySettings {
  try {
    return { browser: true, sound: true, telegram: true, ...JSON.parse(localStorage.getItem(SETTINGS) ?? '{}') };
  } catch {
    return { browser: true, sound: true, telegram: true };
  }
}

export function setNotifySettings(s: NotifySettings) {
  try {
    localStorage.setItem(SETTINGS, JSON.stringify(s));
  } catch {
    /* not persisted */
  }
}

function emit() {
  listeners.forEach((l) => l(toasts));
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.4);
    o.onended = () => void ctx.close();
  } catch {
    /* no audio */
  }
}

/**
 * Shows an alert everywhere the user asked for. `telegramToo` is false for alerts the backend
 * already delivers to Telegram on its own schedule, so they do not arrive twice.
 */
export function notify(title: string, body: string, link?: string, telegramToo = true) {
  const s = getNotifySettings();
  const t: Toast = { id: nextId++, title, body, link, time: Date.now() };
  toasts = [t, ...toasts].slice(0, 6);
  emit();
  window.setTimeout(() => dismissToast(t.id), 15_000);
  if (s.sound) beep();
  if (s.browser && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: `hs-${t.id}`, icon: './favicon.svg' });
      n.onclick = () => {
        window.focus();
        if (link) location.hash = link;
        n.close();
      };
    } catch {
      /* some browsers only allow notifications from a service worker */
    }
  }
  if (s.telegram && telegramToo && telegram) void telegram(title, body, link).catch(() => {});
}

export function useToasts() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => {
      listeners.delete(setList);
    };
  }, []);
  return list;
}

export async function askBrowserPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  return Notification.requestPermission();
}
