export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/**
 * The scrollTop that puts `line` a third of the way down `box`. Measured with client rects, so
 * it does not depend on which ancestor is the offsetParent.
 */
export function lineScrollTop(box: HTMLElement, line: HTMLElement): number {
  const offset = line.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
  return Math.max(0, Math.round(offset - box.clientHeight / 3));
}
