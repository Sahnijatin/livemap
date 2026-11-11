import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { GuardRule } from '@shared/types.js';
import type { AiSettings, SettingsView } from '@shared/settings.js';
import type { SummaryProvider } from '@shared/summaries.js';
import { useStore } from '../store';
import { getSettings, saveAiSettings, saveGuardrails } from '../api';

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.');
const PROVIDERS: { id: SummaryProvider; name: string; key: string | null; model: string }[] = [
  { id: 'anthropic', name: 'Anthropic', key: 'ANTHROPIC_API_KEY', model: 'the default model' },
  { id: 'openai', name: 'OpenAI', key: 'OPENAI_API_KEY', model: 'the default model' },
  { id: 'ollama', name: 'Ollama (local)', key: null, model: 'required, for example llama3' },
];

/** AI summaries and Ask: on or off, the provider and its key. The key is write-only: the server never sends it back. */
function AiSection({ ai, configFile, onSaved }: { ai: AiSettings; configFile: string; onSaved: (v: SettingsView) => void }) {
  const [enabled, setEnabled] = useState(ai.enabled);
  const [provider, setProvider] = useState<SummaryProvider>(ai.provider ?? 'anthropic');
  // Only a model the user saved: the field stays blank for the provider's default, and saving never drops a saved one.
  const [model, setModel] = useState(ai.savedModel ?? '');
  const [url, setUrl] = useState(ai.url ?? '');
  const [cap, setCap] = useState(ai.monthlyTokenCap ? String(ai.monthlyTokenCap) : '');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const spec = PROVIDERS.find(p => p.id === provider)!;
  const sameProvider = ai.provider === provider;
  const keyHint = !spec.key ? '' : sameProvider && ai.keySource === 'config' ? 'A key is saved. Leave blank to keep it.'
    : sameProvider && ai.keySource === 'env' ? `Using ${spec.key} from your environment. Enter a key to save one instead.` : 'Paste your API key';

  const save = async (e: FormEvent, removeKey = false) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      const capNum = cap.trim() ? Number(cap) : undefined;
      const v = await saveAiSettings({
        enabled, provider, model: model.trim(), url: url.trim(),
        ...(capNum !== undefined ? { monthlyTokenCap: capNum } : {}),
        ...(removeKey ? { apiKey: null } : key.trim() ? { apiKey: key.trim() } : {}),
      });
      setKey('');
      setSaved(true);
      onSaved(v);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="set-sec" onSubmit={save} aria-labelledby="set-ai-h">
      <div className="set-row">
        <div>
          <h3 id="set-ai-h">AI summaries and Ask</h3>
          <p className="muted">Plain-English summaries of files and changes, and answers about the project. When on, LiveMap sends code to the provider you choose.</p>
        </div>
        <label className="set-switch">
          <input type="checkbox" role="switch" checked={enabled} onChange={e => setEnabled(e.target.checked)} aria-label="AI summaries and Ask" />
          <span aria-hidden="true" />
        </label>
      </div>
      <div className="set-grid">
        <label>Provider
          <select value={provider} onChange={e => setProvider(e.target.value as SummaryProvider)}>
            {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Model
          <input value={model} onChange={e => setModel(e.target.value)} placeholder={spec.model} autoComplete="off" spellCheck={false} />
        </label>
        {spec.key && (
          <label className="wide">API key
            <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder={keyHint} autoComplete="off" spellCheck={false} />
          </label>
        )}
        <label className="wide">Address (optional)
          <input value={url} onChange={e => setUrl(e.target.value)} placeholder={provider === 'ollama' ? 'http://127.0.0.1:11434' : 'Only for a proxy or a self-hosted endpoint'} autoComplete="off" spellCheck={false} inputMode="url" />
        </label>
        <label className="wide">Monthly token cap (optional)
          <input value={cap} onChange={e => setCap(e.target.value.replace(/[^\d]/g, ''))} placeholder="2000000" inputMode="numeric" />
        </label>
      </div>
      <p className="set-note">The key is saved in <code>{configFile}</code> on this machine, readable only by you. LiveMap never shows it again or sends it anywhere but the provider. Changing the provider or address removes a saved key.</p>
      {ai.problem && <p className="set-err" role="alert">{ai.problem}</p>}
      {error && <p className="set-err" role="alert">{error}</p>}
      <div className="set-actions">
        <span className="set-state">{ai.active ? `On: ${ai.provider}${ai.model ? `, ${ai.model}` : ''}` : 'Off'}{saved && !error ? ' · Saved' : ''}</span>
        {sameProvider && ai.keySource === 'config' && <button type="button" className="set-btn" disabled={busy} onClick={e => save(e, true)}>Remove saved key</button>}
        <button type="submit" className="set-btn primary" disabled={busy}>{busy ? 'Saving' : 'Save'}</button>
      </div>
    </form>
  );
}

const lines = (s: string): string[] => s.split('\n').map(l => l.trim()).filter(Boolean);

/** The project's guardrails: turn each rule on or off, remove it, or add one. Every change is saved at once. */
function GuardSection() {
  const guard = useStore(s => s.control.guard);
  const [rules, setRules] = useState<GuardRule[]>(guard?.rules ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'paths' | 'commands'>('paths');
  const [patterns, setPatterns] = useState('');
  const [action, setAction] = useState<'block' | 'pause'>('block');
  const [message, setMessage] = useState('');
  // The server sends the rules again right after a save, and within 2 seconds of an edit made by hand.
  useEffect(() => { setRules(guard?.rules ?? []); }, [guard]);

  const write = async (next: GuardRule[]): Promise<boolean> => {
    if (busy) return false;
    const before = rules;
    setBusy(true); setError(null);
    setRules(next); // shown at once; put back if the save fails
    try {
      await saveGuardrails(next);
      return true;
    } catch (err) {
      setRules(before);
      setError(errText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const toggle = (i: number, on: boolean) => write(rules.map((r, j) => {
    if (j !== i) return r;
    const { enabled: _drop, ...rest } = r;
    return on ? rest : { ...rest, enabled: false as const };
  }));
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const list = lines(patterns);
    if (!list.length) { setError(kind === 'paths' ? 'Enter at least one file pattern.' : 'Enter the command text to look for.'); return; }
    const rule: GuardRule = { paths: kind === 'paths' ? list : [], commands: kind === 'commands' ? list : [], action, on: 'write', ...(message.trim() ? { message: message.trim() } : {}) };
    if (await write([...rules, rule])) { setPatterns(''); setMessage(''); }
  };

  return (
    <section className="set-sec" aria-labelledby="set-guard-h">
      <h3 id="set-guard-h">Guardrails</h3>
      <p className="muted">Stop an agent before it edits files or runs commands you rule out. Rules are saved in <code>.livemap/guardrails.json</code> in this project; commit that file to share them.</p>
      {guard && guard.errors.length > 0 && <p className="set-err" role="alert">{guard.errors.join(' · ')}</p>}
      {rules.length > 0 && (
        <ul className="set-rules">
          {rules.map((r, i) => {
            const what = [...r.paths, ...r.commands.map(c => `$ ${c}`)].join(', ');
            return (
              <li key={i} className={r.enabled === false ? 'off' : undefined}>
                <label className="set-switch sm">
                  <input type="checkbox" role="switch" checked={r.enabled !== false} disabled={busy} onChange={e => toggle(i, e.target.checked)} aria-label={`Rule ${i + 1}: ${what}`} />
                  <span aria-hidden="true" />
                </label>
                <div className="set-rule-tx">
                  <code>{what}</code>
                  <small>{r.action === 'pause' ? 'Block and pause every agent' : 'Block'}{r.on === 'any' && r.paths.length ? ' · reads too' : ''}{r.message ? ` · ${r.message}` : ''}</small>
                </div>
                <button type="button" className="set-x" disabled={busy} aria-label={`Remove rule ${i + 1}: ${what}`} onClick={() => write(rules.filter((_, j) => j !== i))}>×</button>
              </li>
            );
          })}
        </ul>
      )}
      <form className="set-add" onSubmit={add}>
        <div className="set-grid">
          <label>Stop the agent from
            <select value={kind} onChange={e => setKind(e.target.value as 'paths' | 'commands')}>
              <option value="paths">Changing these files</option>
              <option value="commands">Running commands containing</option>
            </select>
          </label>
          <label>Then
            <select value={action} onChange={e => setAction(e.target.value as 'block' | 'pause')}>
              <option value="block">Block the action</option>
              <option value="pause">Block it and pause every agent</option>
            </select>
          </label>
          <label className="wide">{kind === 'paths' ? 'File patterns, one per line (as in .gitignore)' : 'Command text, one per line'}
            <textarea rows={2} value={patterns} onChange={e => setPatterns(e.target.value)} placeholder={kind === 'paths' ? 'db/migrations/**\n.env*' : 'git push\nrm -rf'} spellCheck={false} />
          </label>
          <label className="wide">Message for the agent (optional)
            <input value={message} onChange={e => setMessage(e.target.value)} placeholder="Do not edit migrations; ask first." maxLength={500} />
          </label>
        </div>
        {error && <p className="set-err" role="alert">{error}</p>}
        <div className="set-actions"><button type="submit" className="set-btn primary" disabled={busy}>Add rule</button></div>
      </form>
    </section>
  );
}

/** The Settings dialog: AI, guardrails and the version. Esc, the backdrop or the close button closes it. */
export default function Settings() {
  const close = useStore(s => s.closeSettings);
  const [view, setView] = useState<SettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    // On the window, in the capture phase: Esc closes Settings wherever the focus went, before the panels see it.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey, true);
    let live = true;
    getSettings().then(v => { if (live) setView(v); }, e => { if (live) setError(errText(e)); });
    return () => { live = false; window.removeEventListener('keydown', onKey, true); };
  }, [close]);

  return (
    <div className="set-back" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="set-box glass" role="dialog" aria-modal="true" aria-labelledby="set-h" tabIndex={-1} ref={box}>
        <div className="set-head">
          <h2 id="set-h">Settings</h2>
          <button type="button" className="iconbtn" aria-label="Close settings" onClick={close}>×</button>
        </div>
        {error && <p className="set-err" role="alert">{error}</p>}
        {view && <AiSection ai={view.ai} configFile={view.configFile} onSaved={setView} />}
        <GuardSection />
        <section className="set-sec set-about">
          <span>LiveMap {view?.version ?? ''}</span>
          <a href="/THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener noreferrer">Third-party notices</a>
        </section>
      </div>
    </div>
  );
}
