/** A text field other than the palette's own input: a shortcut key typed there belongs to the field. */
export function typingElsewhere(el: Element | null): boolean {
  if (!el || el.closest('[cmdk-dialog]')) return false;
  if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'].includes(el.type);
}
