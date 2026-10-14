import { describe, it, expect } from 'vitest';
import { Control } from '../../src/agents/control.js';

describe('Control', () => {
  it('blocks with the exact pause message while paused and resumes', () => {
    const c = new Control();
    const changes: boolean[] = [];
    c.on('change', (s) => changes.push(s.paused));
    expect(c.check('claude-code', 's1')).toBeNull();
    c.setPaused(true);
    expect(c.check('claude-code', 's1')).toEqual({ block: 'The user paused this session in LiveMap. Stop and wait for their instructions.' });
    expect(c.state().paused).toBe(true);
    c.setPaused(false);
    expect(c.check('claude-code', 's1')).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  it('delivers undelivered flags once, in one block, and marks them delivered', () => {
    const c = new Control();
    const a = c.addFlag('src/a.ts', 'use redis', 100);
    const b = c.addFlag(null, 'no new deps', 101);
    expect(c.check('codex', 's9', 200)).toEqual({
      block: 'The user flagged this in LiveMap:\n- src/a.ts: use redis\n- Project: no new deps',
      flags: [a.id, b.id],
    });
    expect(c.check('codex', 's9', 201)).toBeNull();
    const flags = c.state().flags;
    expect(flags.map((f) => f.id)).toEqual([a.id, b.id]);
    for (const f of flags) {
      expect(f.deliveredAt).toBe(200);
      expect(f.deliveredTo).toEqual({ agent: 'codex', sessionId: 's9' });
    }
  });

  it('removing an undelivered flag stops delivery; unknown ids return false', () => {
    const c = new Control();
    const f = c.addFlag(null, 'x');
    expect(c.removeFlag(f.id)).toBe(true);
    expect(c.removeFlag(f.id)).toBe(false);
    expect(c.check('cursor', 's')).toBeNull();
  });

  it('pause wins over flags and leaves them undelivered', () => {
    const c = new Control();
    c.addFlag(null, 'later');
    c.setPaused(true);
    expect(c.check('cursor', 's')?.block).toMatch(/paused/);
    expect(c.state().flags[0].deliveredAt).toBeUndefined();
  });

  it('trims and caps notes, and rejects empty ones', () => {
    const c = new Control();
    expect(c.addFlag(null, '  hi  ').note).toBe('hi');
    expect(c.addFlag(null, 'y'.repeat(3000)).note.length).toBe(2000);
    expect(() => c.addFlag(null, '   ')).toThrow();
  });

  it('state returns a snapshot and addFlag/removeFlag emit change', () => {
    const c = new Control();
    let n = 0;
    c.on('change', () => n++);
    const f = c.addFlag(null, 'a');
    c.removeFlag(f.id);
    expect(n).toBe(2);
    const s = c.state();
    s.flags.push({ id: 99, target: null, note: 'x', createdAt: 0 });
    expect(c.state().flags).toEqual([]);
  });

  it('D1: a multi-line note becomes one line per flag', () => {
    const c = new Control();
    expect(c.addFlag(null, 'first line\n  second\r\n\n third').note).toBe('first line second third');
    expect(c.check('codex', 's')?.block).toBe('The user flagged this in LiveMap:\n- Project: first line second third');
  });

  it('M2: a throwing change listener still gets the flag block back', () => {
    const c = new Control();
    c.addFlag(null, 'careful');
    c.on('change', () => { throw new Error('listener bug'); });
    expect(c.check('codex', 's')?.block).toContain('- Project: careful');
    expect(c.state().flags[0].deliveredAt).toBeTypeOf('number');
  });

  it('M1: undeliver puts delivered flags back in the queue', () => {
    const c = new Control();
    const f = c.addFlag(null, 'again');
    const r = c.check('codex', 's', 5);
    let n = 0;
    c.on('change', () => n++);
    c.undeliver(r!.flags!);
    expect(n).toBe(1);
    expect(c.state().flags[0].deliveredAt).toBeUndefined();
    expect(c.state().flags[0].deliveredTo).toBeUndefined();
    expect(c.check('cursor', 't')?.flags).toEqual([f.id]);
    c.undeliver([12345]);
    expect(n).toBe(2);
  });
});
