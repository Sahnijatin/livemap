import { EventEmitter } from 'node:events';
import type { ChangeSummary, FileModel } from '../shared/types.js';
import { offStatus, type SummaryConfig, type SummaryStatus } from '../shared/summaries.js';

/** What the switch needs of a summarizer (`Summarizer`); tests pass a fake. */
export interface Engine {
  status(): SummaryStatus;
  summarizeFile(file: FileModel, text: string): Promise<string | null>;
  summarizeChange(change: ChangeSummary, file: FileModel | null): Promise<string | null>;
  ask(question: string, context: string): Promise<{ answer: string } | { error: string }>;
  stop(): void;
  on(event: 'status', listener: (status: SummaryStatus) => void): unknown;
  off(event: 'status', listener: (status: SummaryStatus) => void): unknown;
}

export const AI_OFF = 'AI is off: turn it on in Settings';

/**
 * The summarizer the server holds for the whole run, so Settings can turn AI on, off or to another provider
 * without a restart. While off its status is `off`, summaries resolve to null and questions are refused.
 * Emits 'status' for the current engine's status changes, and once on every switch.
 */
export class SwitchableSummarizer extends EventEmitter {
  private inner: Engine | undefined;
  private readonly forward = (s: SummaryStatus): void => { this.emit('status', s); };

  constructor(private readonly make: (cfg: SummaryConfig) => Engine, cfg?: SummaryConfig) {
    super();
    if (cfg) this.attach(cfg);
  }

  private attach(cfg: SummaryConfig): void {
    this.inner = this.make(cfg);
    this.inner.on('status', this.forward);
  }

  /** Replaces the engine (undefined: off). The old one is stopped, so its requests in flight are dropped. */
  set(cfg: SummaryConfig | undefined): void {
    const old = this.inner;
    this.inner = undefined;
    if (old) {
      old.off('status', this.forward);
      try { old.stop(); } catch { /* stopping anyway */ }
    }
    if (cfg) this.attach(cfg);
    this.emit('status', this.status());
  }

  status(): SummaryStatus {
    return this.inner ? this.inner.status() : offStatus(new Date().toISOString().slice(0, 7));
  }

  summarizeFile(file: FileModel, text: string): Promise<string | null> {
    return this.inner ? this.inner.summarizeFile(file, text) : Promise.resolve(null);
  }

  summarizeChange(change: ChangeSummary, file: FileModel | null): Promise<string | null> {
    return this.inner ? this.inner.summarizeChange(change, file) : Promise.resolve(null);
  }

  ask(question: string, context: string): Promise<{ answer: string } | { error: string }> {
    return this.inner ? this.inner.ask(question, context) : Promise.resolve({ error: AI_OFF });
  }

  stop(): void {
    this.inner?.stop();
  }
}
