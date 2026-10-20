import { describe, it, expect } from 'vitest';
import { dict } from './dict';

describe('dict (#72)', () => {
  it('reads inherited names as absent and stores __proto__ as a plain key', () => {
    const d = dict<number>();
    expect(d.constructor).toBeUndefined();
    expect('toString' in d).toBe(false);
    d['__proto__'] = 1;
    expect(Object.keys(d)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(d)).toBeNull();
  });

  it('copies sources in order, later keys winning, including an own __proto__ key from JSON', () => {
    const d = dict<number>({ a: 1, b: 2 }, JSON.parse('{"b":3,"__proto__":4}') as Record<string, number>);
    expect({ ...d }).toEqual({ a: 1, b: 3, ['__proto__']: 4 });
    expect(Object.getPrototypeOf(d)).toBeNull();
  });
});
