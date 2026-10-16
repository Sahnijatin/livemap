import { describe, it, expect } from 'vitest';
import { RECENT_MS, isRecent, liveRecent } from './recent';

describe('recent window', () => {
  it('is 60 seconds and expires exactly at the boundary', () => {
    expect(RECENT_MS).toBe(60_000);
    const at = 1_000_000;
    expect(isRecent({ at }, at)).toBe(true);
    expect(isRecent({ at }, at + 59_999)).toBe(true);
    expect(isRecent({ at }, at + 60_000)).toBe(false);
    expect(isRecent(undefined, at)).toBe(false);
  });

  it('maps live entries to NEW / EDITED badges and drops expired ones', () => {
    const now = 5_000_000;
    expect(liveRecent({
      'a.ts': { kind: 'created', at: now - 1000 },
      'b.ts': { kind: 'modified', at: now - 30_000 },
      'c.ts': { kind: 'modified', at: now - 61_000 },
    }, now)).toEqual({ 'a.ts': 'new', 'b.ts': 'edited' });
  });
});

describe('live badges', () => {
  it('have no prototype, so a file named like an object key has no badge', () => {
    const live = liveRecent({}, Date.now());
    expect(Object.getPrototypeOf(live)).toBeNull();
    expect(live['constructor']).toBeUndefined();
  });
});
