// Chart appearance: candle style and colours, background, grid. Saved in this browser.

export type CandleStyle = 'candles' | 'hollow' | 'bars' | 'line' | 'area';

export interface ChartStyle {
  type: CandleStyle;
  up: string;
  down: string;
  wickUp: string;
  wickDown: string;
  bg: string;
  grid: boolean;
  gridColor: string;
}

export const DEFAULT_STYLE: ChartStyle = {
  type: 'candles',
  up: '#34d399',
  down: '#f87171',
  wickUp: '#34d399',
  wickDown: '#f87171',
  bg: '#0b0f14',
  grid: true,
  gridColor: '#141b24',
};

export const STYLE_LABELS: Record<CandleStyle, string> = {
  candles: 'Candles',
  hollow: 'Hollow candles',
  bars: 'OHLC bars',
  line: 'Line',
  area: 'Area',
};

/** Ready-made colour sets. */
export const STYLE_PRESETS: { name: string; style: Partial<ChartStyle> }[] = [
  { name: 'HyperSpace', style: {} },
  { name: 'Classic', style: { up: '#26a69a', down: '#ef5350', wickUp: '#26a69a', wickDown: '#ef5350', bg: '#131722', gridColor: '#1e2230' } },
  { name: 'Mono', style: { up: '#e5e7eb', down: '#6b7280', wickUp: '#e5e7eb', wickDown: '#6b7280', bg: '#0a0a0a', gridColor: '#171717' } },
  { name: 'Blue / orange', style: { up: '#38bdf8', down: '#fb923c', wickUp: '#38bdf8', wickDown: '#fb923c', bg: '#0b1020', gridColor: '#151c30' } },
  { name: 'Light', style: { up: '#089981', down: '#f23645', wickUp: '#089981', wickDown: '#f23645', bg: '#ffffff', gridColor: '#eef0f3' } },
];

const KEY = 'hs.chartStyle';

export function loadStyle(): ChartStyle {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_STYLE, ...(JSON.parse(raw) as Partial<ChartStyle>) } : DEFAULT_STYLE;
  } catch {
    return DEFAULT_STYLE;
  }
}

export function saveStyle(s: ChartStyle) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

/** '#rrggbb' to 'rgba(r,g,b,a)'. */
export function withAlpha(hex: string, a: number) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

/** True when the background is light, so text and borders should be dark. */
export function isLight(hex: string) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return false;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}
