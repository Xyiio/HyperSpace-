// HyperScript Studio: write an indicator, see it run on live Hyperliquid candles, save it,
// put it on your chart, or publish it to the marketplace.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Interval, Market } from '../hl/api';
import { EXAMPLES, REFERENCE, type ScriptError, type ScriptOutput } from '../script/hyperscript';
import { useScriptLibrary, type SavedScript } from '../script/library';
import { ScriptPreview } from '../components/ScriptPreview';
import { PALETTE, type IndicatorConfig } from '../hl/indicators';
import { DEFAULT_INDICATORS } from '../components/ChartTools';
import { publishScript, socialEnabled } from '../social/client';
import { validateScript } from '../../supabase/functions/_shared/proof';
import { errorText, useWallet } from '../wallet/WalletContext';

const BLANK = `indicator("My indicator", overlay = true)
len = input("Length", 20)
basis = sma(close, len)
plot(basis, "Basis", "#f5c542")
`;

const INTERVALS: Interval[] = ['5m', '15m', '1h', '4h', '1d'];

/** Put a script on the chart (or refresh its code if it is already there). */
export function addScriptToChart(sc: SavedScript) {
  try {
    const raw = localStorage.getItem('hs.indicators');
    const list = raw ? (JSON.parse(raw) as IndicatorConfig[]) : [...DEFAULT_INDICATORS];
    const i = list.findIndex((c) => c.kind === 'script' && c.scriptId === sc.id);
    if (i >= 0) list[i] = { ...list[i], name: sc.name, code: sc.code };
    else {
      const used = new Set(list.map((c) => c.color));
      list.push({ id: crypto.randomUUID(), kind: 'script', params: [], color: PALETTE.find((c) => !used.has(c)) ?? PALETTE[0], name: sc.name, code: sc.code, scriptId: sc.id, inputs: {} });
    }
    localStorage.setItem('hs.indicators', JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}

export function Studio({ markets, scriptId, onRoute }: { markets: Market[]; scriptId: string | null; onRoute: (h: string) => void }) {
  const w = useWallet();
  const [library, setLibrary] = useScriptLibrary();
  const current = library.find((s) => s.id === scriptId) ?? null;
  const [code, setCode] = useState(current?.code ?? BLANK);
  const [name, setName] = useState(current?.name ?? '');
  const [dirty, setDirty] = useState(false);
  const [coin, setCoin] = useState('BTC');
  const [interval, setIv] = useState<Interval>('1h');
  const [result, setResult] = useState<{ out: ScriptOutput | null; error: ScriptError | null; ms: number } | null>(null);
  const [inputs, setInputs] = useState<Record<string, number>>({});
  const [note, setNote] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [desc, setDesc] = useState('');
  const [price, setPrice] = useState('0');
  const [busy, setBusy] = useState(false);
  const [pubMsg, setPubMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Load the selected script when the route changes.
  useEffect(() => {
    setCode(current?.code ?? BLANK);
    setName(current?.name ?? '');
    setDirty(false);
    setInputs({});
    setPubMsg(null);
  }, [scriptId]); // eslint-disable-line react-hooks/exhaustive-deps

  const scriptName = result?.out?.name ?? name;

  const save = (): SavedScript => {
    const finalName = (name || result?.out?.name || 'Untitled script').slice(0, 60);
    const sc: SavedScript = current
      ? { ...current, name: finalName, code, updatedAt: Date.now() }
      : { id: crypto.randomUUID(), name: finalName, code, origin: 'mine', updatedAt: Date.now() };
    setLibrary((l) => (current ? l.map((x) => (x.id === sc.id ? sc : x)) : [sc, ...l]));
    setName(finalName);
    setDirty(false);
    setNote('Saved in this browser.');
    if (!current) onRoute(`#/studio/${sc.id}`);
    return sc;
  };

  const toChart = () => {
    const sc = save();
    addScriptToChart(sc);
    onRoute(`#/trade/${coin}`);
  };

  const remove = () => {
    if (!current) return;
    setLibrary((l) => l.filter((x) => x.id !== current.id));
    onRoute('#/studio');
  };

  const openExample = (i: number) => {
    const ex = EXAMPLES[i];
    const sc: SavedScript = { id: crypto.randomUUID(), name: ex.name, code: ex.code, origin: 'example', updatedAt: Date.now() };
    setLibrary((l) => [sc, ...l]);
    onRoute(`#/studio/${sc.id}`);
  };

  const publish = async () => {
    setPubMsg(null);
    if (!w.address) return setPubMsg({ ok: false, text: 'Connect a wallet first.' });
    if (result?.error) return setPubMsg({ ok: false, text: 'Fix the script errors before publishing.' });
    const sc = save();
    const meta = { scriptId: sc.marketId ?? null, name: sc.name, description: desc, priceHs: Number(price) };
    const v = validateScript({ ...meta, codeSha256: '0'.repeat(64) });
    if (typeof v === 'string') return setPubMsg({ ok: false, text: v });
    setBusy(true);
    try {
      const r = await publishScript(w.address, meta, sc.code, w.signMessage);
      setLibrary((l) => l.map((x) => (x.id === sc.id ? { ...x, marketId: r.script.id, author: w.address! } : x)));
      setPubMsg({ ok: true, text: meta.scriptId ? `Updated to version ${r.script.version}.` : 'Published to the Market.' });
    } catch (e) {
      setPubMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const errLine = result?.error?.line ?? 0;
  const sortedMarkets = useMemo(() => [...markets].sort((a, b) => Number(b.ctx.dayNtlVlm) - Number(a.ctx.dayNtlVlm)).slice(0, 80), [markets]);

  return (
    <div className="studio">
      <div className="studio-bar">
        <select value={current?.id ?? ''} onChange={(e) => onRoute(e.target.value ? `#/studio/${e.target.value}` : '#/studio')}>
          <option value="">New script</option>
          {library.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.origin === 'market' ? ' (installed)' : s.marketId ? ' (published)' : ''}
            </option>
          ))}
        </select>
        <input className="studio-name" placeholder={scriptName || 'Script name'} value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} />
        <button onClick={save} className={dirty ? 'primary' : ''}>
          Save
        </button>
        <button onClick={toChart} disabled={!!result?.error}>
          Add to chart
        </button>
        <button onClick={() => setPublishing((p) => !p)} disabled={current?.origin === 'market'}>
          Publish…
        </button>
        {current && (
          <button className="link small" onClick={remove}>
            Delete
          </button>
        )}
        <span className="muted small">{note}</span>
        <span className="studio-examples">
          Examples:
          {EXAMPLES.map((ex, i) => (
            <button key={ex.name} className="link small" onClick={() => openExample(i)}>
              {ex.name}
            </button>
          ))}
        </span>
      </div>
      {publishing && (
        <div className="publish-panel">
          {!socialEnabled && <div className="warn-text small">The marketplace backend is not connected yet, so publishing will fail until Supabase is set up.</div>}
          <textarea rows={2} placeholder="What does it do, and how should traders read it? (10 to 1,000 characters)" value={desc} onChange={(e) => setDesc(e.target.value)} />
          <div className="row">
            <label>
              Price
              <input className="num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} /> HYPERSPACE
            </label>
            <span className="muted small">
              0 = free for everyone. Paid indicators are listed now; buying opens when the HYPERSPACE token launches, and payments go straight to your wallet.
            </span>
            <button className="primary" onClick={publish} disabled={busy}>
              {busy ? 'Check your wallet…' : current?.marketId ? 'Sign and update' : 'Sign and publish'}
            </button>
            {pubMsg && <span className={pubMsg.ok ? 'up' : 'warn-text'}>{pubMsg.text}</span>}
          </div>
        </div>
      )}
      <div className="studio-main">
        <div className="editor">
          <Editor
            value={code}
            errorLine={errLine}
            readOnly={current?.origin === 'market'}
            onChange={(v) => {
              setCode(v);
              setDirty(true);
            }}
          />
          <div className={`editor-status ${result?.error ? 'warn-text' : 'muted'}`}>
            {current?.origin === 'market'
              ? 'Installed from the Market (read only). Save a copy by selecting "New script" and pasting it in.'
              : result?.error
                ? result.error.message
                : result?.out
                  ? `OK · ${result.out.plots.length} plot${result.out.plots.length === 1 ? '' : 's'}, ${result.out.shapes.reduce((n, s) => n + s.bars.length, 0)} markers · ran in ${result.ms.toFixed(1)} ms`
                  : 'Running…'}
          </div>
        </div>
        <div className="studio-side">
          <div className="row">
            <select value={coin} onChange={(e) => setCoin(e.target.value)}>
              {sortedMarkets.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
            <div className="seg">
              {INTERVALS.map((iv) => (
                <button key={iv} className={iv === interval ? 'on' : ''} onClick={() => setIv(iv)}>
                  {iv}
                </button>
              ))}
            </div>
          </div>
          <ScriptPreview code={code} coin={coin} interval={interval} inputs={inputs} onResult={setResult} height={380} />
          {result?.out && result.out.inputs.length > 0 && (
            <div className="studio-inputs">
              {result.out.inputs.map((inp) => (
                <label key={inp.name}>
                  {inp.name}
                  <input type="number" className="num" value={inputs[inp.name] ?? inp.def} onChange={(e) => setInputs({ ...inputs, [inp.name]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
          )}
          <details className="reference" open>
            <summary>HyperScript reference</summary>
            <table>
              <tbody>
                {REFERENCE.map((r) => (
                  <tr key={r.sig}>
                    <td>
                      <code>{r.sig}</code>
                    </td>
                    <td>{r.doc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted small">
              Scripts run in a sandbox: they only see candles, cannot reach the internet or your wallet, and have no loops, so a script from the
              Market is always safe to run.
            </p>
          </details>
        </div>
      </div>
    </div>
  );
}

function Editor({ value, onChange, errorLine, readOnly }: { value: string; onChange: (v: string) => void; errorLine: number; readOnly?: boolean }) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = value.split('\n').length;
  return (
    <div className="code">
      <div className="gutter" ref={gutter} aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={i + 1 === errorLine ? 'err' : ''}>
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        spellCheck={false}
        value={value}
        readOnly={readOnly}
        aria-label="HyperScript code"
        onScroll={(e) => gutter.current && (gutter.current.scrollTop = e.currentTarget.scrollTop)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return;
          e.preventDefault();
          const t = e.currentTarget;
          const { selectionStart: a, selectionEnd: b } = t;
          onChange(value.slice(0, a) + '  ' + value.slice(b));
          requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
        }}
      />
    </div>
  );
}
