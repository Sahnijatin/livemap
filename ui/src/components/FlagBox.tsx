import { useState, type FormEvent, type KeyboardEvent } from 'react';
import clsx from 'clsx';
import type { Flag } from '@shared/types.js';
import { useStore } from '../store';
import { addFlag, ApiError, removeFlag } from '../api';
import { agentName, ago } from '../agents';
import { useNow } from '../recent';
import { READ_ONLY_TIP } from '../history';
import { FlagIcon } from './icons';

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.');

/** The newest undelivered flag and the newest delivered one for a target (a file path, or null for the project). */
export function flagsFor(flags: Flag[], target: string | null, kind?: 'message'): { pending?: Flag; delivered?: Flag } {
  let pending: Flag | undefined;
  let delivered: Flag | undefined;
  for (const f of flags) {
    if (f.target !== target || f.kind !== kind) continue;
    if (!f.deliveredAt) { if (!pending || f.createdAt >= pending.createdAt) pending = f; }
    else if (!delivered || f.deliveredAt >= (delivered.deliveredAt ?? 0)) delivered = f;
  }
  return { pending, delivered };
}

/**
 * A note for the agent. A flag is delivered before its next action; with `message`, the note waits until the
 * agent finishes its turn and becomes its next instruction. Updating replaces the pending note.
 */
export function FlagBox({ target, message = false }: { target: string | null; message?: boolean }) {
  const kind = message ? 'message' as const : undefined;
  const flags = useStore(s => s.control.flags);
  // While the UI shows the past, flags (which act on the live agent) are off.
  const rewound = useStore(s => s.rewound !== null);
  const replay = useStore(s => s.replay);
  const now = useNow(15_000);
  const { pending, delivered } = flagsFor(flags, target, kind);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const text = note.trim();
    if (!text || busy || rewound) return;
    setBusy(true);
    setError(null);
    try {
      // A flag delivered in the meantime is already gone (404); replacing it still adds the new note.
      // Any other failure stops here so the old note is never silently doubled.
      if (pending) {
        await removeFlag(pending.id).catch((err: unknown) => {
          if (!(err instanceof ApiError && err.status === 404)) throw err;
        });
      }
      await (kind ? addFlag(target, text, kind) : addFlag(target, text));
      setNote('');
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      await removeFlag(pending.id);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
  };

  // A replay has no agent to flag.
  if (replay) return null;

  const status = pending
    ? message ? 'Waiting for the agent to finish its turn' : "Waiting for the agent's next action"
    : delivered
      ? `Delivered ${ago(delivered.deliveredAt!, now)} to ${agentName(delivered.deliveredTo?.agent)}`
      : message ? 'Delivered when the agent finishes its turn' : "Delivered before the agent's next action";

  return (
    <form className={clsx('flagbox', pending && 'pending', rewound && 'readonly')} onSubmit={submit} title={rewound ? READ_ONLY_TIP : undefined}>
      {pending && (
        <div className="flag-pending">
          <FlagIcon />
          <span>“{pending.note}”</span>
          <button type="button" className="linkbtn" onClick={remove} disabled={busy || rewound}>Remove</button>
        </div>
      )}
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        onKeyDown={onKey}
        placeholder={message ? 'Tell the agent what to do next' : target ? 'Tell the agent what to change here' : 'Tell the agent what to change in this project'}
        aria-label={message ? 'Message for the agent' : target ? 'Flag note for this file' : 'Flag note for the project'}
        rows={2}
        maxLength={4000}
        disabled={rewound}
      />
      <div className="row">
        <span className={clsx('fstate', pending && 'wait', !pending && delivered && 'done')}>{status}</span>
        <button type="submit" className={message ? 'btn-red btn-send' : 'btn-red'} disabled={busy || rewound || !note.trim()}>{message ? (pending ? 'Update' : 'Send') : pending ? 'Update flag' : 'Flag'}</button>
      </div>
      {error && <p className="flag-err" role="alert">{error}</p>}
    </form>
  );
}
