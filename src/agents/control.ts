import { EventEmitter } from 'node:events';
import type { AgentKind, ControlState, Flag, GuardState } from '../shared/types.js';

const MAX_NOTE = 2000;
export const PAUSE_MESSAGE = 'The user paused this session in LiveMap. Stop and wait for their instructions.';
export const FLAG_PREFIX = 'The user flagged this in LiveMap:';
export const MESSAGE_PREFIX = 'The user sent this from LiveMap:';

/** Pause switch and user flags that are handed to an agent at its next blockable hook. Emits 'change' (ControlState). */
export class Control extends EventEmitter {
  private paused = false;
  private flags: Flag[] = [];
  private nextId = 1;
  private guard: GuardState | undefined;

  state(): ControlState {
    const flags = this.flags.map((f) => ({ ...f, ...(f.deliveredTo ? { deliveredTo: { ...f.deliveredTo } } : {}) }));
    return this.guard ? { paused: this.paused, flags, guard: this.guard } : { paused: this.paused, flags };
  }

  /** The guardrails' rules, errors and hits as the UI shows them (undefined: no rules file). */
  setGuard(guard: GuardState | undefined): void {
    this.guard = guard;
    this.emit('change', this.state());
  }

  addFlag(target: string | null, note: string, now: number = Date.now(), kind?: 'message'): Flag {
    // One line per flag in the block message.
    const text = note.trim().replace(/\s*\n\s*/g, ' ').slice(0, MAX_NOTE).trim();
    if (!text) throw new Error('Flag note is empty');
    const flag: Flag = { id: this.nextId++, target: kind === 'message' ? null : target, note: text, createdAt: now, ...(kind === 'message' ? { kind } : {}) };
    this.flags.push(flag);
    this.emit('change', this.state());
    return { ...flag };
  }

  removeFlag(id: number): boolean {
    const i = this.flags.findIndex((f) => f.id === id);
    if (i === -1) return false;
    this.flags.splice(i, 1);
    this.emit('change', this.state());
    return true;
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    this.emit('change', this.state());
  }

  /** The block for a blockable hook, or null. `flags` lists the flags this call marked delivered. */
  check(agent: AgentKind, sessionId: string, now: number = Date.now()): { block: string; flags?: number[] } | null {
    if (this.paused) return { block: PAUSE_MESSAGE };
    const pending = this.flags.filter((f) => f.deliveredAt === undefined && f.kind !== 'message');
    if (!pending.length) return null;
    for (const f of pending) {
      f.deliveredAt = now;
      f.deliveredTo = { agent, sessionId };
    }
    const result = { block: `${FLAG_PREFIX}\n${pending.map((f) => `- ${f.target ?? 'Project'}: ${f.note}`).join('\n')}`, flags: pending.map((f) => f.id) };
    try { this.emit('change', this.state()); } catch { /* a faulty listener must not lose the delivered flags */ }
    return result;
  }

  /**
   * The waiting messages for an agent that is about to stop, marked delivered: the stop hook hands the text back
   * and the agent carries on with it as its next instruction. Null when none waits.
   */
  takeMessages(agent: AgentKind, sessionId: string, now: number = Date.now()): { text: string; flags: number[] } | null {
    const pending = this.flags.filter((f) => f.deliveredAt === undefined && f.kind === 'message');
    if (!pending.length) return null;
    for (const f of pending) {
      f.deliveredAt = now;
      f.deliveredTo = { agent, sessionId };
    }
    const result = { text: `${MESSAGE_PREFIX}\n${pending.map((f) => f.note).join('\n')}`, flags: pending.map((f) => f.id) };
    try { this.emit('change', this.state()); } catch { /* a faulty listener must not lose the delivered messages */ }
    return result;
  }

  /** Marks flags undelivered again (their block never reached the agent). */
  undeliver(ids: number[]): void {
    let changed = false;
    for (const f of this.flags) {
      if (!ids.includes(f.id) || f.deliveredAt === undefined) continue;
      delete f.deliveredAt;
      delete f.deliveredTo;
      changed = true;
    }
    if (changed) this.emit('change', this.state());
  }
}
