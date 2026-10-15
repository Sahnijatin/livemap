import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type { RawAgentEvent } from '../shared/types.js';
import { toolLabel, toolMeta, toolPaths, redactSecretInput, outputMentionsSecret } from './labels.js';

const MAX_OUTPUT = 4000;
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p): p is Obj => isObj(p) && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

/** Parse one Claude Code transcript line into zero or more events. `at` falls back to `fallbackAt`, or is NaN-free 0 when absent. */
export function parseClaudeLine(line: string, root: string, fallbackAt?: number): RawAgentEvent[] {
  let obj: unknown;
  try { obj = JSON.parse(line); } catch { return []; }
  if (!isObj(obj) || (obj.type !== 'user' && obj.type !== 'assistant') || !isObj(obj.message)) return [];
  const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  const at = Number.isFinite(ts) ? ts : fallbackAt ?? Date.now();
  const base = { agent: 'claude-code' as const, sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : '', at, ...(obj.isSidechain === true ? { subagent: true } : {}) };
  const content = obj.message.content;
  const out: RawAgentEvent[] = [];

  if (obj.type === 'user') {
    if (obj.isMeta === true) return [];
    const prompt = (text: string) => {
      const t = text.trimStart();
      if (t.startsWith('<command-') || t.startsWith('<local-command')) return;
      const clean = text.replace(REMINDER, '').trim();
      if (clean) out.push({ ...base, type: 'prompt', text: clean });
    };
    if (typeof content === 'string') prompt(content);
    else if (Array.isArray(content)) {
      const texts: string[] = [];
      for (const b of content) {
        if (!isObj(b)) continue;
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        else if (b.type === 'tool_result') {
          const output = resultText(b.content).slice(0, MAX_OUTPUT);
          out.push({
            ...base, type: 'tool_end',
            tool: { id: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined, name: '', label: '', ok: b.is_error !== true, ...(outputMentionsSecret(output) ? {} : { output }), paths: [] },
          });
        }
      }
      if (texts.length) prompt(texts.join('\n'));
    }
    return out;
  }

  if (!Array.isArray(content)) return [];
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === 'text' && typeof b.text === 'string' && b.text) out.push({ ...base, type: 'message', text: b.text });
    else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) out.push({ ...base, type: 'thinking', text: b.thinking });
    else if (b.type === 'tool_use' && typeof b.name === 'string') {
      out.push({
        ...base, type: 'tool_start',
        tool: { id: typeof b.id === 'string' ? b.id : undefined, name: b.name, label: toolLabel(b.name, b.input, root), input: redactSecretInput(b.name, b.input), paths: toolPaths(b.name, b.input, root), ...toolMeta(b.name, b.input) },
      });
    }
  }
  return out;
}

export interface ClaudeTailerOptions {
  backfillMs?: number;
  pollMs?: number;
  maxBackfillBytes?: number;
  /** After this long without growth, poll every idlePollMs instead of pollMs. */
  idleAfterMs?: number;
  idlePollMs?: number;
  /** Resume reading here (no backfill) instead of backfilling the end of the file. */
  startOffset?: number;
}

/** Tails a Claude Code transcript file, emitting 'events' (RawAgentEvent[]) and 'error'. */
export class ClaudeTailer extends EventEmitter {
  private offset = 0;
  private pending: Buffer = Buffer.alloc(0);
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = true;
  private started = 0;
  private activeAt = 0;
  private gen = 0;
  private readonly backfillMs: number;
  private readonly pollMs: number;
  private readonly maxBackfillBytes: number;
  private readonly idleAfterMs: number;
  private readonly idlePollMs: number;
  private readonly startOffset?: number;

  constructor(private readonly file: string, private readonly root: string, opts: ClaudeTailerOptions = {}) {
    super();
    this.backfillMs = opts.backfillMs ?? 600_000;
    this.pollMs = opts.pollMs ?? 300;
    this.maxBackfillBytes = opts.maxBackfillBytes ?? 262_144;
    this.idleAfterMs = opts.idleAfterMs ?? 120_000;
    this.idlePollMs = opts.idlePollMs ?? 5000;
    this.startOffset = opts.startOffset;
  }

  /** Bytes of complete lines consumed so far (where a resumed tailer should start); a pending partial line is not counted. */
  get position(): number { return this.offset - this.pending.length; }
  /** When the file last grew (or the tailer started). */
  get lastActiveAt(): number { return this.activeAt; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.started = this.activeAt = Date.now();
    const backfill = this.startOffset === undefined;
    if (!backfill) this.offset = this.startOffset as number;
    void this.loop(++this.gen, backfill);
  }

  stop(): void {
    this.stopped = true;
    this.gen++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async loop(gen: number, backfill: boolean): Promise<void> {
    await this.poll(backfill);
    if (this.stopped || gen !== this.gen) return;
    const delay = Date.now() - this.activeAt >= this.idleAfterMs ? this.idlePollMs : this.pollMs;
    this.timer = setTimeout(() => void this.loop(gen, false), delay);
    this.timer.unref?.();
  }

  private async poll(backfill: boolean): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      await this.readNew(backfill);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.emit('error', err);
    } finally {
      this.busy = false;
    }
  }

  private async readNew(backfill: boolean): Promise<void> {
    // A cheap stat first: an unchanged file is never opened.
    if (!backfill && (await fs.promises.stat(this.file)).size === this.offset) return;
    this.activeAt = Date.now();
    const fh = await fs.promises.open(this.file, 'r');
    try {
      const { size } = await fh.stat();
      let dropFirst = false;
      if (backfill) {
        this.offset = Math.max(0, size - this.maxBackfillBytes);
        dropFirst = this.offset > 0;
        this.pending = Buffer.alloc(0);
      } else if (size < this.offset) {
        this.offset = 0;
        this.pending = Buffer.alloc(0);
      }
      if (size === this.offset) return;
      const buf = Buffer.alloc(size - this.offset);
      let got = 0;
      while (got < buf.length) {
        const { bytesRead } = await fh.read(buf, got, buf.length - got, this.offset + got);
        if (!bytesRead) break;
        got += bytesRead;
      }
      this.offset += got;
      let data = Buffer.concat([this.pending, buf.subarray(0, got)]);
      const nl = data.lastIndexOf(0x0a);
      this.pending = nl === -1 ? data : data.subarray(nl + 1);
      data = nl === -1 ? Buffer.alloc(0) : data.subarray(0, nl);
      let lines = data.toString('utf8').split('\n');
      if (dropFirst) lines = lines.slice(1);
      if (this.stopped) return;
      const events: RawAgentEvent[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        if (backfill) {
          const evs = parseClaudeLine(line, this.root, -1);
          for (const e of evs) if (e.at >= 0 && e.at >= this.started - this.backfillMs) events.push(e);
        } else events.push(...parseClaudeLine(line, this.root));
      }
      if (events.length) this.emit('events', events);
    } finally {
      await fh.close();
    }
  }
}
