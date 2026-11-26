// HyperScript: HyperSpace's indicator language.
//
// A small, safe, vectorised language. Scripts never touch JavaScript: they are parsed into a tree
// and evaluated here over whole price series at once, so a marketplace script cannot read your
// wallet, the page or the network. There are no loops, so running time is bounded by the script
// length times the number of bars.
//
//   indicator("EMA cross", overlay = true)
//   fastLen = input("Fast length", 9)
//   fast = ema(close, fastLen)
//   slow = ema(close, input("Slow length", 21))
//   plot(fast, "Fast", "#f5c542")
//   plot(slow, "Slow", "#a78bfa")
//   plotshape(crossover(fast, slow), "Buy", "up")
//   plotshape(crossunder(fast, slow), "Sell", "down")

export type Value = number | string | Float64Array;

export interface ScriptCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Plot {
  title: string;
  color: string;
  width: number;
  values: Float64Array;
  style: 'line' | 'histogram';
}
export interface HLine {
  value: number;
  title: string;
  color: string;
}
export interface Shape {
  title: string;
  dir: 'up' | 'down';
  color: string;
  bars: number[]; // bar indexes where the condition is true
}
export interface InputDef {
  name: string;
  def: number;
}
export interface ScriptOutput {
  name: string;
  overlay: boolean;
  plots: Plot[];
  hlines: HLine[];
  shapes: Shape[];
  inputs: InputDef[];
}

export class ScriptError extends Error {
  constructor(
    message: string,
    public line: number,
  ) {
    super(line ? `Line ${line}: ${message}` : message);
  }
}

export const LIMITS = { chars: 20_000, statements: 400, plots: 12, shapes: 8, lookback: 2000 };

// ---------- Tokenizer ----------

type Tok =
  | { k: 'num'; v: number; line: number }
  | { k: 'str'; v: string; line: number }
  | { k: 'id'; v: string; line: number }
  | { k: 'op'; v: string; line: number }
  | { k: 'nl'; line: number }
  | { k: 'eof'; line: number };

const OPS = ['==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '(', ')', '[', ']', ',', '=', '?', ':'];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let depth = 0; // newlines inside brackets do not end a statement
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\n') {
      if (depth === 0) out.push({ k: 'nl', line });
      line++;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?/i.exec(src.slice(i))!;
      out.push({ k: 'num', v: Number(m[0]), line });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(src.slice(i))!;
      out.push({ k: 'id', v: m[0], line });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end < 0 || src.slice(i, end).includes('\n')) throw new ScriptError('Unclosed string', line);
      out.push({ k: 'str', v: src.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ScriptError(`Unexpected character "${ch}"`, line);
    if (op === '(' || op === '[') depth++;
    if (op === ')' || op === ']') depth = Math.max(0, depth - 1);
    out.push({ k: 'op', v: op, line });
    i += op.length;
  }
  out.push({ k: 'nl', line }, { k: 'eof', line });
  return out;
}

// ---------- Parser (Pratt) ----------

type Node =
  | { t: 'num'; v: number; line: number }
  | { t: 'str'; v: string; line: number }
  | { t: 'var'; name: string; line: number }
  | { t: 'un'; op: string; a: Node; line: number }
  | { t: 'bin'; op: string; a: Node; b: Node; line: number }
  | { t: 'tern'; c: Node; a: Node; b: Node; line: number }
  | { t: 'idx'; a: Node; n: Node; line: number }
  | { t: 'call'; name: string; args: Node[]; named: Record<string, Node>; line: number };

type Stmt = { t: 'assign'; name: string; e: Node; line: number } | { t: 'expr'; e: Node; line: number };

const BP: Record<string, number> = { or: 1, and: 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6 };

function parse(src: string): Stmt[] {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const isOp = (v: string) => peek().k === 'op' && (peek() as { v: string }).v === v;
  const expectOp = (v: string) => {
    const t = next();
    if (t.k !== 'op' || t.v !== v) throw new ScriptError(`Expected "${v}"`, t.line);
  };

  const primary = (): Node => {
    const t = next();
    if (t.k === 'num') return { t: 'num', v: t.v, line: t.line };
    if (t.k === 'str') return { t: 'str', v: t.v, line: t.line };
    if (t.k === 'op' && t.v === '(') {
      const e = expr(0);
      expectOp(')');
      return e;
    }
    if (t.k === 'op' && t.v === '-') return { t: 'un', op: '-', a: expr(7), line: t.line };
    if (t.k === 'id') {
      if (t.v === 'not') return { t: 'un', op: 'not', a: expr(3), line: t.line };
      if (t.v === 'true') return { t: 'num', v: 1, line: t.line };
      if (t.v === 'false') return { t: 'num', v: 0, line: t.line };
      if (t.v === 'na') return { t: 'num', v: NaN, line: t.line };
      if (isOp('(')) {
        next();
        const args: Node[] = [];
        const named: Record<string, Node> = {};
        while (!isOp(')')) {
          const a = peek();
          const b = toks[p + 1];
          if (a.k === 'id' && b.k === 'op' && b.v === '=') {
            p += 2;
            named[a.v] = expr(0);
          } else args.push(expr(0));
          if (!isOp(')')) {
            const t2 = peek();
            if (t2.k === 'eof' || (t2.k === 'op' ? t2.v !== ',' : t2.line !== t.line)) throw new ScriptError(`"(" after ${t.v} is never closed`, t.line);
            expectOp(',');
          }
        }
        next();
        return { t: 'call', name: t.v, args, named, line: t.line };
      }
      return { t: 'var', name: t.v, line: t.line };
    }
    throw new ScriptError(t.k === 'nl' || t.k === 'eof' ? 'Unexpected end of line' : `Unexpected "${(t as { v: unknown }).v}"`, t.line);
  };

  const postfix = (): Node => {
    let e = primary();
    while (isOp('[')) {
      const line = next().line;
      const n = expr(0);
      expectOp(']');
      e = { t: 'idx', a: e, n, line };
    }
    return e;
  };

  const expr = (minBp: number): Node => {
    let left = postfix();
    for (;;) {
      const t = peek();
      if (t.k === 'op' && t.v === '?' && minBp === 0) {
        next();
        const a = expr(0);
        expectOp(':');
        const b = expr(0);
        left = { t: 'tern', c: left, a, b, line: t.line };
        continue;
      }
      const op = t.k === 'op' ? t.v : t.k === 'id' && (t.v === 'and' || t.v === 'or') ? t.v : null;
      const bp = op ? BP[op] : undefined;
      if (!op || bp === undefined || bp <= minBp) break;
      next();
      left = { t: 'bin', op, a: left, b: expr(bp), line: t.line };
    }
    return left;
  };

  const stmts: Stmt[] = [];
  while (peek().k !== 'eof') {
    if (peek().k === 'nl') {
      next();
      continue;
    }
    const t = peek();
    const n2 = toks[p + 1];
    if (t.k === 'id' && n2.k === 'op' && n2.v === '=') {
      p += 2;
      stmts.push({ t: 'assign', name: t.v, e: expr(0), line: t.line });
    } else stmts.push({ t: 'expr', e: expr(0), line: t.line });
    if (peek().k !== 'nl' && peek().k !== 'eof') throw new ScriptError('Expected a new line', peek().line);
    if (stmts.length > LIMITS.statements) throw new ScriptError(`Scripts are limited to ${LIMITS.statements} statements`, t.line);
  }
  return stmts;
}

// ---------- Series maths ----------

const isSeries = (v: Value): v is Float64Array => v instanceof Float64Array;

function num(v: Value, line: number, what: string): number {
  if (typeof v === 'number') return v;
  throw new ScriptError(`${what} must be a number`, line);
}
function str(v: Value | undefined, line: number, what: string, def: string): string {
  if (v === undefined) return def;
  if (typeof v === 'string') return v;
  throw new ScriptError(`${what} must be text in quotes`, line);
}

function lengthArg(v: Value, line: number): number {
  const n = Math.round(num(v, line, 'Length'));
  if (!(n >= 1 && n <= LIMITS.lookback)) throw new ScriptError(`Length must be between 1 and ${LIMITS.lookback}`, line);
  return n;
}

export const fns = {
  sma(x: Float64Array, n: number) {
    const out = new Float64Array(x.length).fill(NaN);
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (!Number.isNaN(v)) {
        sum += v;
        cnt++;
      }
      if (i >= n && !Number.isNaN(x[i - n])) {
        sum -= x[i - n];
        cnt--;
      }
      if (i >= n - 1 && cnt === n) out[i] = sum / n;
    }
    return out;
  },
  ema(x: Float64Array, n: number, alpha = 2 / (n + 1)) {
    const out = new Float64Array(x.length).fill(NaN);
    let prev = NaN;
    let seed = 0;
    let cnt = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (Number.isNaN(v)) continue;
      if (Number.isNaN(prev)) {
        seed += v;
        if (++cnt === n) out[i] = prev = seed / n;
        continue;
      }
      out[i] = prev = v * alpha + prev * (1 - alpha);
    }
    return out;
  },
  wma(x: Float64Array, n: number) {
    const out = new Float64Array(x.length).fill(NaN);
    const denom = (n * (n + 1)) / 2;
    for (let i = n - 1; i < x.length; i++) {
      let s = 0;
      for (let j = 0; j < n; j++) s += x[i - j] * (n - j);
      out[i] = s / denom;
    }
    return out;
  },
  stdev(x: Float64Array, n: number) {
    const m = fns.sma(x, n);
    const out = new Float64Array(x.length).fill(NaN);
    for (let i = n - 1; i < x.length; i++) {
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (x[j] - m[i]) ** 2;
      out[i] = Math.sqrt(s / n);
    }
    return out;
  },
  window(x: Float64Array, n: number, pick: (a: number, b: number) => number) {
    const out = new Float64Array(x.length).fill(NaN);
    for (let i = n - 1; i < x.length; i++) {
      let r = x[i];
      for (let j = i - n + 1; j < i; j++) r = pick(r, x[j]);
      out[i] = r;
    }
    return out;
  },
  rsi(x: Float64Array, n: number) {
    const out = new Float64Array(x.length).fill(NaN);
    let g = 0;
    let l = 0;
    for (let i = 1; i < x.length; i++) {
      const d = x[i] - x[i - 1];
      const up = Math.max(d, 0);
      const dn = Math.max(-d, 0);
      if (i <= n) {
        g += up;
        l += dn;
        if (i === n) {
          g /= n;
          l /= n;
          out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
        }
      } else {
        g = (g * (n - 1) + up) / n;
        l = (l * (n - 1) + dn) / n;
        out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
      }
    }
    return out;
  },
  shift(x: Float64Array, n: number) {
    const out = new Float64Array(x.length).fill(NaN);
    for (let i = n; i < x.length; i++) out[i] = x[i - n];
    return out;
  },
};

/** Function catalogue shown in the editor's reference panel. */
export const REFERENCE: { sig: string; doc: string }[] = [
  { sig: 'open high low close volume', doc: 'Price and volume series of the chart' },
  { sig: 'hl2 hlc3 ohlc4', doc: 'Averages of high/low(/close/open)' },
  { sig: 'bar_index time', doc: 'Bar number from 0, and bar open time in ms' },
  { sig: 'indicator(name, overlay = true)', doc: 'Name the script; overlay = false draws in its own pane' },
  { sig: 'input(name, default)', doc: 'A number users can change from the chart' },
  { sig: 'plot(series, title, color, width = 2, style = "line")', doc: 'Draw a line (or "histogram")' },
  { sig: 'hline(value, title, color)', doc: 'Horizontal reference line' },
  { sig: 'plotshape(condition, title, "up" | "down", color)', doc: 'Arrow marker on bars where the condition is true' },
  { sig: 'sma ema wma rma(x, n)', doc: 'Moving averages' },
  { sig: 'rsi(x, n)  stdev(x, n)  atr(n)  vwap()', doc: 'Oscillators and volatility' },
  { sig: 'highest lowest(x, n)  change(x, n = 1)  roc(x, n)', doc: 'Window high/low, difference, % rate of change' },
  { sig: 'crossover crossunder(a, b)', doc: '1 on the bar where a crosses above / below b' },
  { sig: 'x[n]', doc: 'Value n bars ago' },
  { sig: 'abs min max sqrt log exp pow round floor ceil sign', doc: 'Maths, element by element' },
  { sig: 'nz(x, v = 0)  na(x)', doc: 'Replace missing values; test for missing' },
  { sig: 'and or not  ? :  == != < <= > >=', doc: 'Logic, conditions and comparisons (true = 1, false = 0)' },
];

// ---------- Evaluator ----------

export function run(src: string, candles: ScriptCandle[], inputValues: Record<string, number> = {}): ScriptOutput {
  if (src.length > LIMITS.chars) throw new ScriptError(`Scripts are limited to ${LIMITS.chars.toLocaleString()} characters`, 0);
  const stmts = parse(src);
  const N = candles.length;
  const col = (f: (k: ScriptCandle) => number) => Float64Array.from(candles, f);
  const vars = new Map<string, Value>();
  const builtins: Record<string, () => Value> = {
    open: () => col((k) => k.o),
    high: () => col((k) => k.h),
    low: () => col((k) => k.l),
    close: () => col((k) => k.c),
    volume: () => col((k) => k.v),
    hl2: () => col((k) => (k.h + k.l) / 2),
    hlc3: () => col((k) => (k.h + k.l + k.c) / 3),
    ohlc4: () => col((k) => (k.o + k.h + k.l + k.c) / 4),
    bar_index: () => Float64Array.from(candles, (_, i) => i),
    time: () => col((k) => k.t),
  };
  const out: ScriptOutput = { name: 'My script', overlay: true, plots: [], hlines: [], shapes: [], inputs: [] };

  const series = (v: Value, line: number): Float64Array => {
    if (isSeries(v)) return v;
    if (typeof v === 'number') return new Float64Array(N).fill(v);
    throw new ScriptError('Expected a number or series, got text', line);
  };
  const map1 = (v: Value, f: (x: number) => number, line: number): Value => {
    if (typeof v === 'number') return f(v);
    const s = series(v, line);
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = f(s[i]);
    return r;
  };
  const map2 = (a: Value, b: Value, f: (x: number, y: number) => number, line: number): Value => {
    if (typeof a === 'number' && typeof b === 'number') return f(a, b);
    const sa = series(a, line);
    const sb = series(b, line);
    const r = new Float64Array(N);
    for (let i = 0; i < N; i++) r[i] = f(sa[i], sb[i]);
    return r;
  };
  const truthy = (x: number) => !Number.isNaN(x) && x !== 0;

  const BIN: Record<string, (x: number, y: number) => number> = {
    '+': (x, y) => x + y,
    '-': (x, y) => x - y,
    '*': (x, y) => x * y,
    '/': (x, y) => (y === 0 ? NaN : x / y),
    '%': (x, y) => (y === 0 ? NaN : x % y),
    '<': (x, y) => (Number.isNaN(x) || Number.isNaN(y) ? NaN : +(x < y)),
    '<=': (x, y) => (Number.isNaN(x) || Number.isNaN(y) ? NaN : +(x <= y)),
    '>': (x, y) => (Number.isNaN(x) || Number.isNaN(y) ? NaN : +(x > y)),
    '>=': (x, y) => (Number.isNaN(x) || Number.isNaN(y) ? NaN : +(x >= y)),
    '==': (x, y) => +(x === y),
    '!=': (x, y) => +(x !== y),
    and: (x, y) => +(truthy(x) && truthy(y)),
    or: (x, y) => +(truthy(x) || truthy(y)),
  };

  const call = (n: Extract<Node, { t: 'call' }>): Value => {
    const L = n.line;
    const a = n.args.map(ev);
    const named = Object.fromEntries(Object.entries(n.named).map(([k, v]) => [k, ev(v)]));
    const need = (k: number) => {
      if (a.length < k) throw new ScriptError(`${n.name}() needs ${k} argument${k > 1 ? 's' : ''}`, L);
    };
    const S = (i: number) => series(a[i], L);
    switch (n.name) {
      case 'indicator':
        out.name = str(a[0], L, 'Name', out.name).slice(0, 60);
        if (named.overlay !== undefined) out.overlay = truthy(num(named.overlay, L, 'overlay'));
        if (a[1] !== undefined) out.overlay = truthy(num(a[1], L, 'overlay'));
        return 0;
      case 'input': {
        need(2);
        const name = str(a[0], L, 'Input name', '');
        const def = num(a[1], L, 'Input default');
        if (!out.inputs.some((x) => x.name === name)) out.inputs.push({ name, def });
        const v = inputValues[name];
        return typeof v === 'number' && Number.isFinite(v) ? v : def;
      }
      case 'plot': {
        need(1);
        if (out.plots.length >= LIMITS.plots) throw new ScriptError(`At most ${LIMITS.plots} plots`, L);
        const style = str(named.style ?? a[4], L, 'Style', 'line');
        out.plots.push({
          values: Float64Array.from(S(0)),
          title: str(named.title ?? a[1], L, 'Title', `Plot ${out.plots.length + 1}`),
          color: str(named.color ?? a[2], L, 'Color', '#26c6da'),
          width: Math.max(1, Math.min(4, Math.round(num(named.width ?? a[3] ?? 2, L, 'Width')))),
          style: style === 'histogram' ? 'histogram' : 'line',
        });
        return 0;
      }
      case 'hline':
        need(1);
        out.hlines.push({ value: num(a[0], L, 'Value'), title: str(named.title ?? a[1], L, 'Title', ''), color: str(named.color ?? a[2], L, 'Color', '#4b5563') });
        return 0;
      case 'plotshape': {
        need(1);
        if (out.shapes.length >= LIMITS.shapes) throw new ScriptError(`At most ${LIMITS.shapes} plotshape calls`, L);
        const c = S(0);
        const dir = str(named.dir ?? a[2], L, 'Direction', 'up') === 'down' ? 'down' : 'up';
        const bars: number[] = [];
        for (let i = 0; i < N; i++) if (truthy(c[i])) bars.push(i);
        out.shapes.push({ title: str(named.title ?? a[1], L, 'Title', ''), dir, color: str(named.color ?? a[3], L, 'Color', dir === 'up' ? '#34d399' : '#f87171'), bars });
        return 0;
      }
      case 'sma':
        need(2);
        return fns.sma(S(0), lengthArg(a[1], L));
      case 'ema':
        need(2);
        return fns.ema(S(0), lengthArg(a[1], L));
      case 'rma': {
        need(2);
        const len = lengthArg(a[1], L);
        return fns.ema(S(0), len, 1 / len);
      }
      case 'wma':
        need(2);
        return fns.wma(S(0), lengthArg(a[1], L));
      case 'rsi':
        need(2);
        return fns.rsi(S(0), lengthArg(a[1], L));
      case 'stdev':
        need(2);
        return fns.stdev(S(0), lengthArg(a[1], L));
      case 'highest':
        need(2);
        return fns.window(S(0), lengthArg(a[1], L), Math.max);
      case 'lowest':
        need(2);
        return fns.window(S(0), lengthArg(a[1], L), Math.min);
      case 'change': {
        need(1);
        const k = a[1] === undefined ? 1 : lengthArg(a[1], L);
        return map2(S(0), fns.shift(S(0), k), BIN['-'], L);
      }
      case 'roc': {
        need(2);
        const prev = fns.shift(S(0), lengthArg(a[1], L));
        return map2(S(0), prev, (x, y) => (y ? ((x - y) / y) * 100 : NaN), L);
      }
      case 'atr': {
        need(1);
        const len = lengthArg(a[0], L);
        const tr = new Float64Array(N).fill(NaN);
        for (let i = 1; i < N; i++) {
          const k = candles[i];
          const pc = candles[i - 1].c;
          tr[i] = Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
        }
        return fns.ema(tr, len, 1 / len);
      }
      case 'vwap': {
        const r = new Float64Array(N).fill(NaN);
        let day = -1;
        let pv = 0;
        let vol = 0;
        candles.forEach((k, i) => {
          const d = Math.floor(k.t / 86_400_000);
          if (d !== day) {
            day = d;
            pv = vol = 0;
          }
          const tp = (k.h + k.l + k.c) / 3;
          pv += tp * k.v;
          vol += k.v;
          r[i] = vol > 0 ? pv / vol : tp;
        });
        return r;
      }
      case 'crossover':
      case 'crossunder': {
        need(2);
        const x = S(0);
        const y = S(1);
        const r = new Float64Array(N).fill(0);
        for (let i = 1; i < N; i++) {
          const up = x[i] > y[i] && x[i - 1] <= y[i - 1];
          const dn = x[i] < y[i] && x[i - 1] >= y[i - 1];
          r[i] = +(n.name === 'crossover' ? up : dn);
        }
        return r;
      }
      case 'nz':
        need(1);
        return map2(a[0], a[1] ?? 0, (x, d) => (Number.isNaN(x) ? d : x), L);
      case 'na':
        need(1);
        return map1(a[0], (x) => +Number.isNaN(x), L);
      case 'abs':
      case 'sqrt':
      case 'log':
      case 'exp':
      case 'round':
      case 'floor':
      case 'ceil':
      case 'sign':
        need(1);
        return map1(a[0], Math[n.name as "abs"], L);
      case 'min':
      case 'max':
      case 'pow':
        need(2);
        return map2(a[0], a[1], Math[n.name as "min"], L);
      default:
        throw new ScriptError(`Unknown function ${n.name}()`, L);
    }
  };

  const ev = (n: Node): Value => {
    switch (n.t) {
      case 'num':
        return n.v;
      case 'str':
        return n.v;
      case 'var': {
        const v = vars.get(n.name);
        if (v !== undefined) return v;
        const b = builtins[n.name];
        if (b) {
          const s = b();
          vars.set(n.name, s);
          return s;
        }
        throw new ScriptError(`Unknown name "${n.name}"`, n.line);
      }
      case 'un': {
        const a = ev(n.a);
        return n.op === '-' ? map1(a, (x) => -x, n.line) : map1(a, (x) => +!truthy(x), n.line);
      }
      case 'bin':
        return map2(ev(n.a), ev(n.b), BIN[n.op], n.line);
      case 'tern': {
        const c = ev(n.c);
        const a = ev(n.a);
        const b = ev(n.b);
        if (typeof c === 'number' && typeof a !== 'object' && typeof b !== 'object') return truthy(c) ? a : b;
        const sc = series(c, n.line);
        const sa = series(a, n.line);
        const sb = series(b, n.line);
        return Float64Array.from(sc, (x, i) => (truthy(x) ? sa[i] : sb[i]));
      }
      case 'idx': {
        const k = Math.round(num(ev(n.n), n.line, 'Index'));
        if (!(k >= 0 && k <= LIMITS.lookback)) throw new ScriptError(`Index must be between 0 and ${LIMITS.lookback}`, n.line);
        return fns.shift(series(ev(n.a), n.line), k);
      }
      case 'call':
        return call(n);
    }
  };

  for (const s of stmts) {
    if (s.t === 'assign') {
      if (s.name in builtins) throw new ScriptError(`"${s.name}" is built in and cannot be reassigned`, s.line);
      vars.set(s.name, ev(s.e));
    } else ev(s.e);
  }
  return out;
}

/** Parse only: returns the first error, or null. */
export function check(src: string): ScriptError | null {
  try {
    run(src, []);
    return null;
  } catch (e) {
    return e instanceof ScriptError ? e : new ScriptError(String(e), 0);
  }
}

export const EXAMPLES: { name: string; description: string; code: string }[] = [
  {
    name: 'EMA cross signals',
    description: 'Fast and slow EMAs with arrows where they cross.',
    code: `indicator("EMA cross signals", overlay = true)
fast = ema(close, input("Fast length", 9))
slow = ema(close, input("Slow length", 21))
plot(fast, "Fast", "#f5c542")
plot(slow, "Slow", "#a78bfa")
plotshape(crossover(fast, slow), "Bull cross", "up")
plotshape(crossunder(fast, slow), "Bear cross", "down")
`,
  },
  {
    name: 'Keltner channel',
    description: 'EMA midline with ATR bands; closes outside the band are marked.',
    code: `indicator("Keltner channel", overlay = true)
len = input("Length", 20)
mult = input("ATR multiple", 2)
mid = ema(close, len)
upper = mid + mult * atr(len)
lower = mid - mult * atr(len)
plot(upper, "Upper", "#26c6da", 1)
plot(mid, "Mid", "#94a3b8", 1)
plot(lower, "Lower", "#26c6da", 1)
plotshape(close > upper and close[1] <= upper[1], "Break up", "up")
plotshape(close < lower and close[1] >= lower[1], "Break down", "down")
`,
  },
  {
    name: 'Volume-weighted momentum',
    description: 'Rate of change weighted by relative volume, in its own pane.',
    code: `indicator("Volume-weighted momentum", overlay = false)
len = input("Length", 14)
relVol = volume / sma(volume, len)
mom = ema(roc(close, len) * relVol, 5)
plot(mom, "Momentum", "#34d399", 2, "histogram")
plot(ema(mom, 9), "Signal", "#f472b6", 1)
hline(0)
`,
  },
  {
    name: 'Stochastic RSI',
    description: 'RSI scaled to its own recent range, with 20/80 levels.',
    code: `indicator("Stochastic RSI", overlay = false)
r = rsi(close, input("RSI length", 14))
n = input("Stoch length", 14)
k = sma(100 * (r - lowest(r, n)) / (highest(r, n) - lowest(r, n)), 3)
plot(k, "K", "#60a5fa")
plot(sma(k, 3), "D", "#fb923c")
hline(80)
hline(20)
`,
  },
];
