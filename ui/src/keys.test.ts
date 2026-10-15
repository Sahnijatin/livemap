// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { typingIn } from './keys';

const el = (html: string): Element => {
  const box = document.createElement('div');
  box.innerHTML = html;
  document.body.appendChild(box);
  return box.querySelector('[data-t]')!;
};

describe('typingIn', () => {
  it('for the palette shortcut (text entry only, the palette input excepted)', () => {
    const palette = { palette: false };
    expect(typingIn(el('<input data-t>'), palette)).toBe(true);
    expect(typingIn(el('<textarea data-t></textarea>'), palette)).toBe(true);
    expect(typingIn(el('<input type="checkbox" data-t>'), palette)).toBe(false);
    expect(typingIn(el('<select data-t></select>'), palette)).toBe(false);
    expect(typingIn(el('<div role="combobox" tabindex="0" data-t></div>'), palette)).toBe(false);
    expect(typingIn(el('<div cmdk-dialog><input data-t></div>'), palette)).toBe(false);
    expect(typingIn(el('<button data-t></button>'), palette)).toBe(false);
    expect(typingIn(null, palette)).toBe(false);
  });

  it('for single-key shortcuts (every form control, the palette input too)', () => {
    const controls = { controls: true };
    expect(typingIn(el('<input data-t>'), controls)).toBe(true);
    expect(typingIn(el('<input type="checkbox" data-t>'), controls)).toBe(true);
    expect(typingIn(el('<select data-t></select>'), controls)).toBe(true);
    expect(typingIn(el('<textarea data-t></textarea>'), controls)).toBe(true);
    expect(typingIn(el('<div contenteditable="true"><span data-t></span></div>'), controls)).toBe(true);
    expect(typingIn(el('<div role="textbox" tabindex="0" data-t></div>'), controls)).toBe(true);
    expect(typingIn(el('<div role="combobox" tabindex="0" data-t></div>'), controls)).toBe(true);
    expect(typingIn(el('<div cmdk-dialog><input data-t></div>'), controls)).toBe(true);
    expect(typingIn(el('<button data-t></button>'), controls)).toBe(false);
  });
});
