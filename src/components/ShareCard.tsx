// A branded image of a trade, ready to post. Drawn on a canvas so it can be downloaded or
// copied; posting on X opens the composer with the text and a link back to the trader's
// verified PnL page (the image is attached by the user).
import { useEffect, useRef, useState } from 'react';
import { fmtUsd, shortAddr } from '../hl/stats';

export interface ShareTrade {
  coin: string;
  side: 'long' | 'short';
  /** Return on margin when known, otherwise the price move in the trade's direction. */
  pct: number;
  pctLabel: 'ROE' | 'move';
  pnl: number;
  entry: number;
  exit: number;
  status: 'open' | 'closed';
  time: number;
  wallet: string | null;
  paper: boolean;
}

const W = 1200;
const H = 630;

function draw(c: HTMLCanvasElement, t: ShareTrade) {
  const ctx = c.getContext('2d')!;
  c.width = W;
  c.height = H;
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#070a0e');
  g.addColorStop(0.55, '#0d1120');
  g.addColorStop(1, '#1a0f2e');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // Star field.
  let seed = Math.floor(t.time / 1000) % 9973;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.15 + rnd() * 0.5})`;
    ctx.beginPath();
    ctx.arc(rnd() * W, rnd() * H, rnd() * 1.4, 0, Math.PI * 2);
    ctx.fill();
  }
  const win = t.pnl >= 0;
  const accent = win ? '#34d399' : '#f87171';
  // Glow behind the number.
  const glow = ctx.createRadialGradient(330, 330, 20, 330, 330, 380);
  glow.addColorStop(0, win ? 'rgba(52,211,153,0.22)' : 'rgba(248,113,113,0.22)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const sans = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.textBaseline = 'alphabetic';
  // Brand.
  const brand = ctx.createLinearGradient(60, 0, 420, 0);
  brand.addColorStop(0, '#f5f3ff');
  brand.addColorStop(0.5, '#c4b5fd');
  brand.addColorStop(1, '#67e8f9');
  ctx.fillStyle = brand;
  ctx.font = `600 34px ${sans}`;
  ctx.fillText('H Y P E R S P A C E', 60, 86);
  ctx.fillStyle = '#7c8a9c';
  ctx.font = `400 22px ${sans}`;
  ctx.fillText(t.paper ? 'Paper trade' : 'Hyperliquid-native charting', 60, 120);

  // Market and side.
  ctx.font = `700 56px ${sans}`;
  ctx.fillStyle = '#e5e7eb';
  ctx.fillText(t.coin, 60, 230);
  const cw = ctx.measureText(t.coin).width;
  ctx.font = `700 26px ${sans}`;
  const tag = `${t.side.toUpperCase()} · ${t.status === 'open' ? 'OPEN' : 'CLOSED'}`;
  const tw = ctx.measureText(tag).width + 28;
  ctx.fillStyle = t.side === 'long' ? 'rgba(52,211,153,0.15)' : 'rgba(248,113,113,0.15)';
  ctx.strokeStyle = t.side === 'long' ? '#34d399' : '#f87171';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(60 + cw + 24, 192, tw, 46, 23);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = t.side === 'long' ? '#34d399' : '#f87171';
  ctx.fillText(tag, 60 + cw + 38, 225);

  // The number.
  ctx.fillStyle = accent;
  ctx.font = `800 132px ${sans}`;
  ctx.fillText(`${t.pct >= 0 ? '+' : ''}${(t.pct * 100).toFixed(t.pct * 100 >= 100 || t.pct * 100 <= -100 ? 0 : 2)}%`, 54, 390);
  ctx.font = `600 40px ${sans}`;
  ctx.fillText(`${t.pnl >= 0 ? '+' : ''}${fmtUsd(t.pnl, 2)}`, 60, 450);
  ctx.fillStyle = '#7c8a9c';
  ctx.font = `400 22px ${sans}`;
  ctx.fillText(t.pctLabel === 'ROE' ? 'return on margin' : 'price move in the trade’s direction', 60, 486);

  // Prices.
  const row = (label: string, value: string, y: number) => {
    ctx.fillStyle = '#7c8a9c';
    ctx.font = `400 24px ${sans}`;
    ctx.fillText(label, 760, y);
    ctx.fillStyle = '#e5e7eb';
    ctx.font = `600 30px ui-monospace, Menlo, monospace`;
    ctx.fillText(value, 760, y + 38);
  };
  row('Entry', String(t.entry), 220);
  row(t.status === 'open' ? 'Mark' : 'Exit', String(t.exit), 320);
  row('Date', new Date(t.time).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }), 420);

  // Footer.
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(0, H - 70, W, 70);
  ctx.fillStyle = '#c4b5fd';
  ctx.font = `500 22px ${sans}`;
  ctx.fillText(t.wallet && !t.paper ? `✓ Verified on-chain · ${shortAddr(t.wallet)}` : 'Practice account, not real money', 60, H - 28);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#7c8a9c';
  ctx.fillText(location.host || 'hyperspace', W - 60, H - 28);
  ctx.textAlign = 'left';
}

export function ShareCard({ trade, onClose }: { trade: ShareTrade; onClose: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (ref.current) draw(ref.current, trade);
  }, [trade]);

  const fileName = `hyperspace-${trade.coin.replace(/[^A-Za-z0-9]/g, '')}-${trade.side}.png`;
  const download = () => {
    const a = document.createElement('a');
    a.href = ref.current!.toDataURL('image/png');
    a.download = fileName;
    a.click();
  };
  const copy = async () => {
    try {
      const blob = await new Promise<Blob | null>((r) => ref.current!.toBlob(r, 'image/png'));
      if (!blob || !('ClipboardItem' in window)) throw new Error('unsupported');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setMsg('Image copied. Paste it into your post.');
    } catch {
      setMsg('This browser cannot copy images; use Download instead.');
    }
  };
  const proof = trade.wallet && !trade.paper ? `${location.origin}${location.pathname}#/wallet/${trade.wallet}` : '';
  const text = `${trade.side === 'long' ? 'Long' : 'Short'} ${trade.coin} ${trade.pct >= 0 ? '+' : ''}${(trade.pct * 100).toFixed(2)}% on HyperSpace${trade.paper ? ' (paper)' : ''}`;
  const xUrl = `https://x.com/intent/post?text=${encodeURIComponent(text)}${proof ? `&url=${encodeURIComponent(proof)}` : ''}`;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share-modal" role="dialog" aria-label="Share this trade">
        <canvas ref={ref} className="share-canvas" />
        <div className="modal-actions">
          <button className="primary" onClick={download}>
            Download PNG
          </button>
          <button onClick={() => void copy()}>Copy image</button>
          <a className="btn" href={xUrl} target="_blank" rel="noreferrer">
            Post on X
          </a>
          <button className="link" onClick={onClose}>
            Close
          </button>
          {msg && <span className="small muted">{msg}</span>}
        </div>
        {proof && <div className="small muted">The post links to your verified PnL page, so anyone can check the trade on-chain.</div>}
      </div>
    </div>
  );
}

/** Card data for a closing fill: entry is worked out from the fill price and its realized PnL. */
export function tradeFromFill(f: { coin: string; px: string; sz: string; dir: string; closedPnl: string; time: number }, wallet: string | null, paper: boolean): ShareTrade {
  const exit = Number(f.px);
  const sz = Number(f.sz);
  const pnl = Number(f.closedPnl);
  const long = /long/i.test(f.dir);
  const entry = sz ? (long ? exit - pnl / sz : exit + pnl / sz) : exit;
  return { coin: f.coin, side: long ? 'long' : 'short', pct: entry ? pnl / (entry * sz) : 0, pctLabel: 'move', pnl, entry: Number(entry.toPrecision(6)), exit, status: 'closed', time: f.time, wallet, paper };
}
