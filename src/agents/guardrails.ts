import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { AgentKind, GuardHit, GuardRule, GuardState } from '../shared/types.js';

/** The user's rules file, relative to the project folder. LiveMap only reads it. */
export const GUARDRAILS_FILE = '.livemap/guardrails.json';
const MAX_FILE = 256 * 1024;
const MAX_RULES = 100;
const MAX_PATTERNS = 50;
const MAX_TEXT = 500;
const MAX_HITS = 50;
export const GUARD_PAUSE_MESSAGE = "The session is now paused in LiveMap. Stop and wait for the user's instructions.";

/** What a blockable hook says its tool call will do. `command` is matched in memory only and never stored. */
export interface GuardCall {
  tool: string;
  /** Project-relative POSIX paths the call names. */
  paths: string[];
  command?: string;
  access: 'read' | 'write' | 'other';
}
export interface GuardMatch { target: string; pattern: string }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A list of non-empty strings (trimmed, capped), or an error text. Missing means empty. */
function texts(v: unknown, key: string): string[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return `"${key}" must be a list of text`;
  const out = (v as string[]).map(s => s.trim()).filter(Boolean);
  if (out.length > MAX_PATTERNS) return `"${key}" holds more than ${MAX_PATTERNS} entries`;
  const long = out.find(s => s.length > MAX_TEXT);
  return long ? `"${key}" has an entry over ${MAX_TEXT} characters` : out;
}

function parseRule(v: unknown): GuardRule | string {
  if (!isObj(v)) return 'must be an object';
  const paths = texts(v.paths, 'paths');
  if (typeof paths === 'string') return paths;
  const commands = texts(v.commands, 'commands');
  if (typeof commands === 'string') return commands;
  if (!paths.length && !commands.length) return 'needs "paths" or "commands"';
  const negated = paths.find(p => p.startsWith('!'));
  if (negated) return `"!" patterns are not supported: ${negated}`;
  const action = v.action ?? 'block';
  if (action !== 'block' && action !== 'pause') return '"action" must be "block" or "pause"';
  const on = v.on ?? 'write';
  if (on !== 'write' && on !== 'any') return '"on" must be "write" or "any"';
  if (v.message !== undefined && typeof v.message !== 'string') return '"message" must be text';
  // One line: the message is part of the block text the agent reads.
  const message = typeof v.message === 'string' ? v.message.trim().replace(/\s*\n\s*/g, ' ').slice(0, MAX_TEXT).trim() : '';
  return { paths, commands, action, on, ...(message ? { message } : {}) };
}

/** The valid rules of a guardrails file, and one error per rule that was skipped. */
export function parseGuardrails(text: string): { rules: GuardRule[]; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { rules: [], errors: ['not valid JSON'] };
  }
  if (!isObj(raw) || !Array.isArray(raw.rules)) return { rules: [], errors: ['expected {"rules": [...]}'] };
  const rules: GuardRule[] = [];
  const errors: string[] = [];
  raw.rules.slice(0, MAX_RULES).forEach((v, i) => {
    const r = parseRule(v);
    if (typeof r === 'string') errors.push(`rule ${i + 1}: ${r}`);
    else rules.push(r);
  });
  if (raw.rules.length > MAX_RULES) errors.push(`only the first ${MAX_RULES} rules are used`);
  return { rules, errors };
}

function pathMatches(pattern: string, rel: string): boolean {
  try {
    return ignore().add(pattern).ignores(rel);
  } catch {
    return false; // a path or pattern the matcher cannot express never matches
  }
}

/** What in `call` the rule forbids: a path with the pattern it matched, or a command pattern. */
export function matchRule(rule: GuardRule, call: GuardCall): GuardMatch | null {
  if (call.access === 'write' || rule.on === 'any') {
    for (const p of call.paths) {
      const pattern = rule.paths.find(pat => pathMatches(pat, p));
      if (pattern) return { target: p, pattern };
    }
  }
  if (call.command) {
    const pattern = rule.commands.find(c => call.command!.includes(c));
    if (pattern) return { target: `command contains "${pattern}"`, pattern };
  }
  return null;
}

export interface GuardDecision { block: string; pause: boolean; hit: GuardHit }

/**
 * The project's guardrails: re-read when the file's size or modification time changes (`refresh`), with
 * the latest hits. `state()` is undefined while the project has no rules file.
 */
export class Guardrails {
  private readonly file: string;
  private stamp = '';
  private rules: GuardRule[] = [];
  private errors: string[] = [];
  private hits: GuardHit[] = [];
  private present = false;

  constructor(root: string) {
    this.file = path.join(root, ...GUARDRAILS_FILE.split('/'));
    this.refresh();
  }

  /** Re-reads the file when it changed; true when the rules or errors may differ. */
  refresh(): boolean {
    let stamp = '';
    let size = 0;
    try {
      const st = fs.statSync(this.file);
      if (st.isFile()) { stamp = `${st.mtimeMs}:${st.size}`; size = st.size; }
    } catch { /* no file */ }
    if (stamp === this.stamp) return false;
    this.stamp = stamp;
    this.present = stamp !== '';
    if (!this.present) {
      this.rules = [];
      this.errors = [];
      return true;
    }
    if (size > MAX_FILE) {
      this.rules = [];
      this.errors = [`the file is over ${MAX_FILE / 1024} KB`];
      return true;
    }
    try {
      ({ rules: this.rules, errors: this.errors } = parseGuardrails(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, '')));
    } catch (e) {
      this.rules = [];
      this.errors = [`could not be read: ${(e as NodeJS.ErrnoException).code ?? 'error'}`];
    }
    return true;
  }

  state(): GuardState | undefined {
    if (!this.present && !this.hits.length) return undefined;
    return { file: GUARDRAILS_FILE, rules: this.rules.map(r => ({ ...r, paths: [...r.paths], commands: [...r.commands] })), errors: [...this.errors], hits: this.hits.map(h => ({ ...h })) };
  }

  /** The first rule (in file order) that forbids the call, recorded as a hit; null when none does. */
  check(call: GuardCall, who: { agent: AgentKind; sessionId: string }, now: number): GuardDecision | null {
    this.refresh();
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      const m = matchRule(rule, call);
      if (!m) continue;
      const hit: GuardHit = { at: now, rule: i, action: rule.action, target: m.target, agent: who.agent, sessionId: who.sessionId, tool: call.tool };
      this.hits.push(hit);
      if (this.hits.length > MAX_HITS) this.hits.splice(0, this.hits.length - MAX_HITS);
      const what = call.command && m.target.startsWith('command contains') ? `${m.target}.` : `${m.target} matches the rule "${m.pattern}".`;
      const tail = [rule.message, rule.action === 'pause' ? GUARD_PAUSE_MESSAGE : ''].filter(Boolean).join(' ');
      return { block: `Blocked by a LiveMap guardrail: ${what}${tail ? ` ${tail}` : ''}`, pause: rule.action === 'pause', hit };
    }
    return null;
  }

  /** Withdraws a hit whose block never reached the agent. */
  withdraw(hit: GuardHit): void {
    const i = this.hits.indexOf(hit);
    if (i !== -1) this.hits.splice(i, 1);
  }
}
