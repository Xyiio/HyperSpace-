import { useEffect, useRef, useState } from 'react';
import { INDICATOR_INFO, PALETTE, shortName, type BuiltinKind, type IndicatorConfig } from '../hl/indicators';
import { useScriptLibrary, type SavedScript } from '../script/library';
import { run } from '../script/hyperscript';
import { DRAWING_INFO, DRAW_COLORS, type DrawingKind } from '../hl/drawings';
import { DEFAULT_STYLE, STYLE_LABELS, STYLE_PRESETS, type CandleStyle, type ChartStyle } from '../hl/chartStyle';

/** useState that is saved in localStorage under `key`. */
export function usePersistent<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* not persisted */
    }
  }, [key, v]);
  return [v, setV] as const;
}

const KEY = 'hs.indicators';
export const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'd-ema50', kind: 'ema', params: [50], color: PALETTE[0] },
  { id: 'd-ema200', kind: 'ema', params: [200], color: PALETTE[1] },
];

export function useIndicators() {
  const [list, setList] = useState<IndicatorConfig[]>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as IndicatorConfig[]) : DEFAULT_INDICATORS;
    } catch {
      return DEFAULT_INDICATORS;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* not persisted */
    }
  }, [list]);
  return [list, setList] as const;
}

interface Props {
  indicators: IndicatorConfig[];
  onIndicators: (l: IndicatorConfig[]) => void;
  tool: DrawingKind | null;
  onTool: (t: DrawingKind | null) => void;
  onClearDrawings: () => void;
  drawColor: string;
  onDrawColor: (c: string) => void;
  chartStyle: ChartStyle;
  onChartStyle: (s: ChartStyle) => void;
}

export function ChartTools({ indicators, onIndicators, tool, onTool, onClearDrawings, drawColor, onDrawColor, chartStyle, onChartStyle }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  // Keyboard shortcuts for drawing tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = (Object.keys(DRAWING_INFO) as DrawingKind[]).find((d) => DRAWING_INFO[d].key === e.key.toUpperCase());
      if (k) onTool(tool === k ? null : k);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, onTool]);

  const [scripts] = useScriptLibrary();
  const nextColor = () => {
    const used = new Set(indicators.map((i) => i.color));
    return PALETTE.find((c) => !used.has(c)) ?? PALETTE[indicators.length % PALETTE.length];
  };
  const add = (kind: BuiltinKind) =>
    onIndicators([...indicators, { id: crypto.randomUUID(), kind, params: INDICATOR_INFO[kind].params.map((p) => p.def), color: nextColor() }]);
  const addScript = (sc: SavedScript) =>
    onIndicators([...indicators, { id: crypto.randomUUID(), kind: 'script', params: [], color: nextColor(), name: sc.name, code: sc.code, scriptId: sc.id, inputs: {} }]);
  const scriptInputs = (code: string) => {
    try {
      return run(code, []).inputs;
    } catch {
      return [];
    }
  };
  const update = (id: string, i: number, v: number) =>
    onIndicators(indicators.map((c) => (c.id === id ? { ...c, params: c.params.map((p, j) => (j === i ? v : p)) } : c)));
  const remove = (id: string) => onIndicators(indicators.filter((c) => c.id !== id));

  return (
    <div className="chart-tools">
      <div className="ind-menu" ref={ref}>
        <button onClick={() => setOpen((o) => !o)}>Indicators ({indicators.length}) ▾</button>
        {open && (
          <div className="menu">
            {indicators.length > 0 && <div className="muted small">On the chart</div>}
            {indicators.map((c) => (
              <div key={c.id} className="ind-row">
                <span className="sw" style={{ background: c.color }} />
                <span className={c.kind === 'script' ? 'ind-name script' : 'ind-name'} title={shortName(c)}>
                  {c.kind === 'script' ? c.name : c.kind.toUpperCase()}
                </span>
                {c.kind === 'script' &&
                  scriptInputs(c.code ?? '').map((inp) => (
                    <input
                      key={inp.name}
                      className="num tiny"
                      title={inp.name}
                      type="number"
                      value={c.inputs?.[inp.name] ?? inp.def}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) onIndicators(indicators.map((x) => (x.id === c.id ? { ...x, inputs: { ...x.inputs, [inp.name]: v } } : x)));
                      }}
                    />
                  ))}
                {c.kind !== 'script' &&
                  INDICATOR_INFO[c.kind].params.map((p, i) => (
                  <input
                    key={p.name}
                    className="num tiny"
                    title={p.name}
                    type="number"
                    min={1}
                    step={c.kind === 'bb' && i === 1 ? 0.5 : 1}
                    value={c.params[i]}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (v > 0 && v <= 1000) update(c.id, i, v);
                    }}
                  />
                ))}
                <button className="link" onClick={() => remove(c.id)} title={`Remove ${shortName(c)}`}>
                  ✕
                </button>
              </div>
            ))}
            <div className="muted small">Add</div>
            {(Object.keys(INDICATOR_INFO) as BuiltinKind[]).map((k) => (
              <button key={k} className="ind-add" onClick={() => add(k)}>
                + {INDICATOR_INFO[k].label}
              </button>
            ))}
            <div className="muted small">My HyperScripts</div>
            {scripts.map((sc) => (
              <button key={sc.id} className="ind-add" onClick={() => addScript(sc)}>
                + {sc.name} {sc.origin === 'market' && <span className="muted small">· market</span>}
              </button>
            ))}
            <a className="ind-add small" href="#/studio">
              {scripts.length ? 'Open the Studio to write or edit scripts →' : 'Write your own in the Studio, or install one from the Market →'}
            </a>
          </div>
        )}
      </div>
      <div className="draw-tools">
        {(Object.keys(DRAWING_INFO) as DrawingKind[]).map((k) => (
          <button
            key={k}
            className={`${tool === k ? 'on' : ''}${k === 'arrowUp' ? ' up' : k === 'arrowDown' ? ' down' : ''}`}
            onClick={() => onTool(tool === k ? null : k)}
            title={`${DRAWING_INFO[k].label} (${DRAWING_INFO[k].key})`}
            aria-label={DRAWING_INFO[k].label}
          >
            {DRAWING_INFO[k].icon}
          </button>
        ))}
        <ColorPick value={drawColor} onChange={onDrawColor} title="Colour for new drawings" />
        <button className="link small" onClick={onClearDrawings} title="Remove every drawing on this market">
          Clear all
        </button>
      </div>
      <StyleMenu style={chartStyle} onChange={onChartStyle} />
      <span className="muted small">Click a drawing to recolour or delete it</span>
    </div>
  );
}

function ColorPick({ value, onChange, title }: { value: string; onChange: (c: string) => void; title: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <div className="color-pick" ref={ref}>
      <button title={title} aria-label={title} onClick={() => setOpen((o) => !o)}>
        <span className="sw" style={{ background: value }} /> ▾
      </button>
      {open && (
        <div className="menu swatches">
          {DRAW_COLORS.map((c) => (
            <button
              key={c}
              className={`swatch${value === c ? ' on' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => {
                onChange(c);
                setOpen(false);
              }}
            />
          ))}
          <input type="color" value={value} onChange={(e) => onChange(e.target.value)} title="Custom colour" />
        </div>
      )}
    </div>
  );
}

function StyleMenu({ style, onChange }: { style: ChartStyle; onChange: (s: ChartStyle) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const set = (patch: Partial<ChartStyle>) => onChange({ ...style, ...patch });
  const color = (label: string, key: keyof ChartStyle) => (
    <label className="style-row">
      <span>{label}</span>
      <input type="color" value={style[key] as string} onChange={(e) => set({ [key]: e.target.value })} />
    </label>
  );
  return (
    <div className="ind-menu" ref={ref}>
      <button onClick={() => setOpen((o) => !o)}>Chart style ▾</button>
      {open && (
        <div className="menu style-menu">
          <label className="style-row">
            <span>Type</span>
            <select value={style.type} onChange={(e) => set({ type: e.target.value as CandleStyle })}>
              {(Object.keys(STYLE_LABELS) as CandleStyle[]).map((k) => (
                <option key={k} value={k}>
                  {STYLE_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          {color('Up candles', 'up')}
          {color('Down candles', 'down')}
          {color('Up wicks', 'wickUp')}
          {color('Down wicks', 'wickDown')}
          {color('Background', 'bg')}
          <label className="style-row">
            <span>Grid</span>
            <span>
              <input type="checkbox" checked={style.grid} onChange={(e) => set({ grid: e.target.checked })} />{' '}
              <input type="color" value={style.gridColor} onChange={(e) => set({ gridColor: e.target.value })} disabled={!style.grid} />
            </span>
          </label>
          <div className="muted small">Presets</div>
          <div className="presets">
            {STYLE_PRESETS.map((p) => (
              <button key={p.name} onClick={() => onChange({ ...DEFAULT_STYLE, ...p.style, type: style.type })}>
                <span className="sw" style={{ background: p.style.up ?? DEFAULT_STYLE.up }} />
                <span className="sw" style={{ background: p.style.down ?? DEFAULT_STYLE.down }} /> {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
