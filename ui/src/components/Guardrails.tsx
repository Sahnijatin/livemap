import type { GuardRule } from '@shared/types.js';
import { useStore } from '../store';
import { agentName, ago } from '../agents';
import { useNow } from '../recent';

const MAX_HITS = 5;
const FILE = '.livemap/guardrails.json';

function RuleRow({ rule }: { rule: GuardRule }) {
  return (
    <div className={rule.enabled === false ? 'guardrule off' : 'guardrule'}>
      {rule.enabled === false
        ? <span className="tg t-off">Off</span>
        : <span className={`tg ${rule.action === 'pause' ? 't-chg' : 't-del'}`}>{rule.action === 'pause' ? 'Pause' : 'Block'}</span>}
      <div className="gr-tx">
        <div className="gr-pats">
          {rule.paths.map(p => <code key={`p:${p}`}>{p}</code>)}
          {rule.commands.map(c => <code key={`c:${c}`} title="A shell command containing this text">$ {c}</code>)}
        </div>
        {rule.on === 'any' && rule.paths.length > 0 && <small>Reads too</small>}
        {rule.message && <span>{rule.message}</span>}
      </div>
    </div>
  );
}

/** The project's guardrails in the Live session view: active rules, file errors and the latest blocked calls. */
export function Guardrails() {
  const guard = useStore(s => s.control.guard);
  const replay = useStore(s => s.replay);
  const now = useNow(15_000);
  if (!guard) {
    // An export has no agent to guard, so it has nothing to set up.
    if (replay) return null;
    return (
      <div className="sec">
        <h4>Guardrails</h4>
        <div className="muted" style={{ fontSize: 12 }}>
          Stop the agent before it touches files or runs commands you rule out: add rules to <code>{FILE}</code>.
        </div>
      </div>
    );
  }
  const hits = [...guard.hits].reverse().slice(0, MAX_HITS);
  return (
    <div className="sec">
      <h4>Guardrails</h4>
      {guard.errors.length > 0 && (
        <div className="guard-err" role="alert">
          <b>{guard.file}</b>
          {guard.errors.map(e => <span key={e}>{e}</span>)}
        </div>
      )}
      {guard.rules.length > 0
        ? <div className="guardlist">{guard.rules.map((r, i) => <RuleRow rule={r} key={i} />)}</div>
        : !guard.errors.length && <div className="muted" style={{ fontSize: 12 }}>No rules in <code>{guard.file}</code> yet.</div>}
      {hits.length > 0 && (
        <div className="guardhits">
          {hits.map((h, i) => (
            <div className="guardhit" key={`${h.at}:${i}`} title={h.target}>
              <b>{h.action === 'pause' ? 'Paused' : 'Blocked'}</b>
              <code>{h.target}</code>
              <small>{agentName(h.agent)} · {ago(h.at, now)}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
