import { describe, it, expect } from 'vitest';
import { clock, when } from './agents';

const NOW = new Date(2026, 9, 20, 15, 0).getTime();
const enUS = Intl.DateTimeFormat().resolvedOptions().locale === 'en-US';

describe('when', () => {
  it('is the time of day alone for today', () => {
    const at = new Date(2026, 9, 20, 0, 5).getTime();
    expect(when(at, NOW)).toBe(clock(at));
  });

  it('adds the date for another day of this year', () => {
    const at = new Date(2026, 9, 3, 10, 42).getTime();
    const s = when(at, NOW);
    expect(s).not.toBe(clock(at));
    expect(s).toContain('3');
    expect(s).not.toContain('2026');
    if (enUS) expect(s).toBe('Oct 3, 10:42 AM');
  });

  it('adds the year for another year', () => {
    const at = new Date(2025, 11, 31, 22, 58).getTime();
    const s = when(at, NOW);
    expect(s).toContain('2025');
    if (enUS) expect(s).toBe('Dec 31, 2025, 10:58 PM');
  });

  it('treats yesterday late at night as another day', () => {
    const at = new Date(2026, 9, 19, 23, 59).getTime();
    expect(when(at, NOW)).not.toBe(clock(at));
  });
});
