import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** The light theme's tokens: the first :root block. */
function lightToken(name: string): string {
  const root = /:root\s*\{([^}]*)\}/.exec(css)![1];
  return new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(root)![1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string): number => {
  const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (hi + 0.05) / (lo + 0.05);
};

describe('light theme contrast (WCAG AA)', () => {
  it('tertiary text (--ink3) reads at 4.5:1 or better on the page background and on white cards', () => {
    const ink3 = lightToken('ink3');
    expect(contrast(ink3, lightToken('bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink3, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    // Still lighter than secondary text, so the hierarchy holds.
    expect(luminance(ink3)).toBeGreaterThan(luminance(lightToken('ink2')));
  });
});
