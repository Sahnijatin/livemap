import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import clsx from 'clsx';
import type { DomainIndex, EnvVar, Tech } from '@shared/domain.js';
import type { SummaryStatus } from '@shared/summaries.js';
import { depKey, useStore } from '../store';
import { LAYERS, LAYER_ORDER, layerOf, type Layer } from '../layers';
import { isNarrow } from '../media';

type Category = Tech['category'];
const CATEGORIES: [Category, string, string][] = [
  ['frontend', 'Frontend', 'var(--blue)'],
  ['backend', 'Backend', 'var(--indigo)'],
  ['mobile', 'Mobile', 'var(--purple)'],
  ['database', 'Database', 'var(--orange)'],
  ['orm', 'ORM', 'var(--teal)'],
  ['styling', 'Styling', 'var(--pink)'],
  ['ai', 'AI', 'var(--purple)'],
  ['testing', 'Testing', 'var(--green)'],
  ['tooling', 'Tooling', 'var(--ink3)'],
  ['language', 'Language', 'var(--ink2)'],
];
/** Rows shown per dependency group before "Show all". */
const DEP_PAGE = 12;
const ENV_TEMPLATE = /(^|\/)\.env\.(example|sample|template)$/;
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;

/** Open a file (and a line, where known) in the inspector. */
function open(path: string, line?: number): void {
  const s = useStore.getState();
  if (line) s.revealLine(path, line);
  else s.select(path);
  if (isNarrow()) s.setPanel('inspector');
}

/** True after the first paint, so bars grow from zero on mount. */
function useGrown(): boolean {
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const h = window.requestAnimationFrame(() => setGrown(true));
    return () => window.cancelAnimationFrame(h);
  }, []);
  return grown;
}

function DetectedStack({ stack, base }: { stack: Tech[]; base: Set<string> }) {
  const groups = CATEGORIES.map(([c, label, color]) => ({ c, label, color, techs: stack.filter(t => t.category === c) })).filter(g => g.techs.length);
  return (
    <section className="box b-stack">
      <h4>Detected stack</h4>
      {groups.length === 0 && <p className="muted">Nothing detected yet. LiveMap reads package.json, requirements.txt, go.mod, Cargo.toml and other manifests.</p>}
      <div className="tgroups">
        {groups.map(g => (
          <div className="tgroup" key={g.c}>
            <span className="tg-h">{g.label}</span>
            <div className="techs">
              {g.techs.map(t => {
                const fresh = !base.has(t.id);
                const linked = t.source !== 'files';
                return (
                  <button
                    type="button"
                    key={t.id}
                    className={clsx('tech', fresh && 'new fi')}
                    style={{ '--c': fresh ? 'var(--green)' : g.color } as CSSProperties}
                    disabled={!linked}
                    title={linked ? `Declared in ${t.source}` : 'Detected from source files'}
                    onClick={() => open(t.source)}
                  >
                    <i aria-hidden="true" />{t.name}{fresh && <small>new</small>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Bars({ rows, grown }: { rows: { label: string; value: number; color: string }[]; grown: boolean }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div className="bars">
      {rows.map(r => (
        <div className="bar" key={r.label}>
          <span>{r.label}</span>
          <span className="tr"><i style={{ '--c': r.color, width: grown ? `${(r.value / max) * 100}%` : 0 } as CSSProperties} /></span>
          <b>{r.value.toLocaleString()}</b>
        </div>
      ))}
    </div>
  );
}

function WhatExists({ counts }: { counts: DomainIndex['counts'] }) {
  const files = useStore(s => s.files);
  const grown = useGrown();
  const layers = useMemo(() => {
    const n = {} as Record<Layer, number>;
    for (const [p, f] of Object.entries(files)) {
      const l = layerOf(p, f);
      n[l] = (n[l] ?? 0) + 1;
    }
    return LAYER_ORDER.filter(l => n[l]).map(l => ({ label: LAYERS[l].name, value: n[l], color: LAYERS[l].color }));
  }, [files]);
  const total = Object.keys(files).length;
  const domain = [
    { label: 'Routes', value: counts.routes, color: 'var(--teal)' },
    { label: 'Pages', value: counts.pages, color: 'var(--purple)' },
    { label: 'Screens', value: counts.screens, color: 'var(--pink)' },
    { label: 'Tables', value: counts.tables, color: 'var(--orange)' },
    { label: 'Dependencies', value: counts.deps, color: 'var(--blue)' },
  ].filter(r => r.value > 0 || r.label === 'Routes' || r.label === 'Tables' || r.label === 'Dependencies');
  return (
    <section className="box b-exists">
      <h4>What exists</h4>
      <div className="ex-total"><b>{total.toLocaleString()}</b><span>{total === 1 ? 'file' : 'files'}</span></div>
      {layers.length > 0 && (
        <div className="layerbar" aria-hidden="true">
          {layers.map(l => <i key={l.label} style={{ '--c': l.color, flexGrow: grown ? l.value : 0 } as CSSProperties} />)}
        </div>
      )}
      <Bars rows={layers} grown={grown} />
      <div className="ex-sep" />
      <Bars rows={domain} grown={grown} />
    </section>
  );
}

type DepRow = DomainIndex['deps'][number];

function DepList({ title, deps, base }: { title?: string; deps: DepRow[]; base: Set<string> }) {
  const [all, setAll] = useState(false);
  const shown = all ? deps : deps.slice(0, DEP_PAGE);
  return (
    <div className="dsub">
      {title && <span className="ds-h">{title}</span>}
      {shown.map((d, i) => {
        const fresh = !base.has(depKey(d));
        return (
          <button type="button" key={`${d.name}:${d.line ?? i}`} className={clsx('drow', fresh && 'new fi')} onClick={() => open(d.file, d.line)} title={`${d.name} in ${d.file}`}>
            <span className="dn">{d.name}{fresh && <small className="tg t-add">new</small>}</span>
            <span className="v">{d.version || 'any'}</span>
          </button>
        );
      })}
      {deps.length > DEP_PAGE && (
        <button type="button" className="dmore" onClick={() => setAll(a => !a)}>
          {all ? 'Show fewer' : `Show all ${deps.length.toLocaleString()}`}
        </button>
      )}
    </div>
  );
}

function Dependencies({ deps, base }: { deps: DepRow[]; base: Set<string> }) {
  const byFile = useMemo(() => {
    const m = new Map<string, { prod: DepRow[]; dev: DepRow[] }>();
    for (const d of deps) {
      let g = m.get(d.file);
      if (!g) m.set(d.file, g = { prod: [], dev: [] });
      (d.dev ? g.dev : g.prod).push(d);
    }
    return [...m];
  }, [deps]);
  return (
    <section className="box b-deps">
      <h4>Dependencies · {deps.length.toLocaleString()}</h4>
      {byFile.length === 0 && <p className="muted">No dependencies declared yet.</p>}
      {byFile.map(([file, g]) => (
        <div className="dgroup" key={file}>
          <button type="button" className="dg-h" onClick={() => open(file)}>{file}</button>
          {g.prod.length > 0 && <DepList deps={g.prod} base={base} title={g.dev.length ? 'Production' : undefined} />}
          {g.dev.length > 0 && <DepList deps={g.dev} base={base} title="Dev" />}
        </div>
      ))}
    </section>
  );
}

function Scripts({ scripts }: { scripts: DomainIndex['scripts'] }) {
  const files = new Set(scripts.map(s => s.file));
  return (
    <section className="box b-scripts">
      <h4>Scripts</h4>
      {scripts.map(s => (
        <button type="button" key={`${s.file}:${s.name}`} className="drow script" onClick={() => open(s.file)} title={s.file}>
          <span className="dn">{s.name}{files.size > 1 && <small className="v"> {s.file}</small>}</span>
          <code className="v">{s.command}</code>
        </button>
      ))}
    </section>
  );
}

function Env({ env, hasExample }: { env: EnvVar[]; hasExample: boolean }) {
  return (
    <section className="box b-env">
      <h4>Environment variables · {env.length.toLocaleString()}</h4>
      {env.length === 0 && <p className="muted">No environment variables referenced yet.</p>}
      {env.map(v => {
        const code = v.files.filter(f => !ENV_FILE.test(f));
        const missing = hasExample && !v.inExample && code.length > 0;
        return (
          <div className={clsx('erow', missing && 'warn')} key={v.name}>
            <div className="er-top">
              <span className="en">{v.name}</span>
              {hasExample && v.inExample && <span className="echip ok">In .env.example</span>}
              {missing && <span className="echip miss">Missing from .env.example</span>}
              {v.definedInEnvFile && <span className="echip def">Defined in .env</span>}
            </div>
            {code.length > 0 && (
              <div className="efiles">
                {code.map(f => <button type="button" key={f} onClick={() => open(f)}>{f}</button>)}
              </div>
            )}
          </div>
        );
      })}
      <p className="enote">Names only. Values in .env are never read.</p>
    </section>
  );
}

const EXAMPLE_CONFIG = `${JSON.stringify({ summaries: { enabled: true, provider: 'anthropic', apiKey: 'your-api-key' } }, null, 2)}\n`;

const PROVIDERS: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', ollama: 'Ollama' };

function stateText(s: SummaryStatus): string {
  if (s.state === 'error') return `error: ${s.error ?? 'unknown'}`;
  return s.state === 'cap' ? 'cap reached' : s.state;
}

/** Whether AI summaries are on, which model writes them, and this month's token use against the cap. */
function AiSummaries() {
  const status = useStore(s => s.summaries.status);
  const copy = (): void => {
    const { showToast } = useStore.getState();
    navigator.clipboard.writeText(EXAMPLE_CONFIG).then(
      () => showToast('Example config copied. Paste it into ~/.livemap/config.json.'),
      () => showToast('Could not copy the example config.', 'error'),
    );
  };
  if (status.state === 'off') {
    return (
      <section className="box b-ai">
        <h4>AI summaries</h4>
        <p className="muted">Off. Add a key and enable summaries in ~/.livemap/config.json to get one-line explanations.</p>
        <button type="button" className="linkbtn" onClick={copy}>Copy an example config</button>
      </section>
    );
  }
  const pct = status.capTokens > 0 ? Math.min(100, (status.usedTokens / status.capTokens) * 100) : 100;
  return (
    <section className="box b-ai">
      <h4>AI summaries</h4>
      <div className="ai-row">
        <span className="ai-prov">{PROVIDERS[status.provider ?? ''] ?? status.provider}</span>
        <code>{status.model}</code>
        <span className={clsx('ai-state', `s-${status.state}`)}>{stateText(status)}</span>
      </div>
      <span className={clsx('ai-bar', status.state === 'cap' && 'full')}><i style={{ width: `${Math.round(pct * 10) / 10}%` }} /></span>
      <p className="ai-use">{status.usedTokens.toLocaleString()} of {status.capTokens.toLocaleString()} tokens this month</p>
    </section>
  );
}

/** The Stack tab: detected technologies, counts, AI summaries, dependencies, scripts and env var names. */
export function StackView() {
  const domain = useStore(s => s.domain);
  const base = useStore(s => s.domainBase);
  const files = useStore(s => s.files);
  // A replay hides the AI box: it would show the exporter's provider, model and use, not the viewer's.
  const replay = useStore(s => s.replay);
  const hasExample = useMemo(() => Object.keys(files).some(p => ENV_TEMPLATE.test(p)) || domain.env.some(v => v.inExample), [files, domain.env]);
  return (
    <div className="stackv">
      {/* Two masonry columns; a narrow pane flattens them into one list in reading order. */}
      <div className="sgrid">
        <div className="scol">
          <DetectedStack stack={domain.stack} base={base.stack} />
          <Dependencies deps={domain.deps} base={base.deps} />
          {domain.scripts.length > 0 && <Scripts scripts={domain.scripts} />}
        </div>
        <div className="scol">
          <WhatExists counts={domain.counts} />
          {!replay && <AiSummaries />}
          <Env env={domain.env} hasExample={hasExample} />
        </div>
      </div>
    </div>
  );
}
