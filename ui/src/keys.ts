const NOT_TEXT = ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'];

/**
 * Whether a key typed with focus on `el` belongs to the field there, not to a shortcut.
 * - `controls`: any form control counts (every input, select, role textbox or combobox), for single-key shortcuts
 *   like [ and ]. Otherwise only text entry does (the ⌘K check).
 * - `palette`: false makes the palette's own input not count, so ⌘K there closes the palette.
 */
export function typingIn(el: Element | null, { controls = false, palette = true }: { controls?: boolean; palette?: boolean } = {}): boolean {
  if (!el || (!palette && el.closest('[cmdk-dialog]'))) return false;
  if ((el as HTMLElement).isContentEditable || el.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return true;
  if (controls && el.closest('input, select, [role=textbox], [role=combobox]')) return true;
  return el instanceof HTMLInputElement && !NOT_TEXT.includes(el.type);
}
