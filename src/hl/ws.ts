// Single shared WebSocket to Hyperliquid with automatic resubscribe.
// Subscriptions: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
import { WS_URL } from './api';

export type Subscription =
  | { type: 'l2Book'; coin: string; nSigFigs?: number | null }
  | { type: 'trades'; coin: string }
  | { type: 'candle'; coin: string; interval: string };

type Handler = (data: any) => void;

// Key a subscription by what the server echoes back in each message, so we can route it.
function subKey(s: Subscription): string {
  switch (s.type) {
    case 'l2Book':
      return `l2Book:${s.coin}`;
    case 'trades':
      return `trades:${s.coin}`;
    case 'candle':
      return `candle:${s.coin}:${s.interval}`;
  }
}

function msgKey(channel: string, data: any): string | null {
  switch (channel) {
    case 'l2Book':
      return `l2Book:${data.coin}`;
    case 'trades':
      return Array.isArray(data) && data.length ? `trades:${data[0].coin}` : null;
    case 'candle':
      return `candle:${data.s}:${data.i}`;
    default:
      return null; // subscriptionResponse, pong, error
  }
}

export type SocketStatus = 'connecting' | 'open' | 'closed';

class HLSocket {
  private ws: WebSocket | null = null;
  private subs = new Map<string, { sub: Subscription; handlers: Set<Handler> }>();
  private retry = 0;
  private pingTimer: number | undefined;
  private statusListeners = new Set<(s: SocketStatus) => void>();
  status: SocketStatus = 'closed';

  private setStatus(s: SocketStatus) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  onStatus(l: (s: SocketStatus) => void) {
    this.statusListeners.add(l);
    l(this.status);
    return () => {
      this.statusListeners.delete(l);
    };
  }

  private connect() {
    if (this.ws) return;
    this.setStatus('connecting');
    const ws = new WebSocket(WS_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      this.subs.forEach(({ sub }) => this.send({ method: 'subscribe', subscription: sub }));
      // The server drops idle connections after 60s.
      this.pingTimer = window.setInterval(() => this.send({ method: 'ping' }), 30_000);
    };
    ws.onmessage = (ev) => {
      let msg: { channel: string; data: any };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const key = msgKey(msg.channel, msg.data);
      if (!key) return;
      this.subs.get(key)?.handlers.forEach((h) => h(msg.data));
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      this.ws = null;
      this.setStatus('closed');
      if (this.subs.size === 0) return;
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      window.setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  private send(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  subscribe(sub: Subscription, handler: Handler): () => void {
    const key = subKey(sub);
    let entry = this.subs.get(key);
    if (!entry) {
      entry = { sub, handlers: new Set() };
      this.subs.set(key, entry);
      this.send({ method: 'subscribe', subscription: sub });
    }
    entry.handlers.add(handler);
    this.connect();
    return () => {
      const e = this.subs.get(key);
      if (!e) return;
      e.handlers.delete(handler);
      if (e.handlers.size === 0) {
        this.subs.delete(key);
        this.send({ method: 'unsubscribe', subscription: e.sub });
      }
    };
  }
}

export const hlSocket = new HLSocket();
