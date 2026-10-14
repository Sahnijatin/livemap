/** Below this width the file tree and inspector become slide-over panels. */
export const NARROW_QUERY = '(max-width:1080px)';

export const isNarrow = (): boolean => window.matchMedia?.(NARROW_QUERY).matches ?? false;
