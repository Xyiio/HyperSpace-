import { useEffect, useRef, useState } from 'react';
import { INDICATOR_INFO, PALETTE, shortName, type IndicatorConfig, type IndicatorKind } from '../hl/indicators';
import { DRAWING_INFO, type DrawingKind } from '../hl/drawings';

const KEY = 'hs.indicators';
const DEFAULTS: IndicatorConfig[] = [
  { id: 'd-ema50', kind: 'ema', params: [50], color: PALETTE[0] },
  { id: 'd-ema200', kind: 'ema', params: [200], color: PALETTE[1] },
];

export function useIndicators() {
  const [list, setList] = useState<IndicatorConfig[]>(() => {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as IndicatorConfig[]) : DEFAULTS;
    } catch {
      return DEFAULTS;
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
}

export function ChartTools({ indicators, onIndicators, tool, onTool, onClearDrawings }: Props) {
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

  const add = (kind: IndicatorKind) => {
    const used = new Set(indicators.map((i) => i.color));
    const color = PALETTE.find((c) => !used.has(c)) ?? PALETTE[indicators.length % PALETTE.length];
    onIndicators([...indicators, { id: crypto.randomUUID(), kind, params: INDICATOR_INFO[kind].params.map((p) => p.def), color }]);
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
                <span className="ind-name">{c.kind.toUpperCase()}</span>
                {INDICATOR_INFO[c.kind].params.map((p, i) => (
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
            {(Object.keys(INDICATOR_INFO) as IndicatorKind[]).map((k) => (
              <button key={k} className="ind-add" onClick={() => add(k)}>
                + {INDICATOR_INFO[k].label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="draw-tools">
        {(Object.keys(DRAWING_INFO) as DrawingKind[]).map((k) => (
          <button key={k} className={tool === k ? 'on' : ''} onClick={() => onTool(tool === k ? null : k)} title={`${DRAWING_INFO[k].label} (${DRAWING_INFO[k].key})`}>
            {DRAWING_INFO[k].label}
          </button>
        ))}
        <button className="link small" onClick={onClearDrawings} title="Remove every drawing on this market">
          Clear drawings
        </button>
      </div>
      <span className="muted small">Click a drawing to select it, Delete to remove</span>
    </div>
  );
}
