import { useSyncExternalStore } from 'react';

/** Below 1080 px the file tree and inspector become slide-over panels (spec §10: wide ≥ 1280, medium 1080–1279). */
export const NARROW_QUERY = '(max-width:1079.98px)';
/** Phone widths: icon-only tabs, condensed toolbar, Map tools in the options menu. */
export const PHONE_QUERY = '(max-width:640px)';

const matches = (query: string): boolean => globalThis.matchMedia?.(query).matches ?? false;

export const isNarrow = (): boolean => matches(NARROW_QUERY);
export const isPhone = (): boolean => matches(PHONE_QUERY);

/** Whether a media query matches, kept current by its change events. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    notify => {
      const mq = window.matchMedia?.(query);
      if (!mq?.addEventListener) return () => {};
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => matches(query),
    () => false,
  );
}

const onResize = (notify: () => void) => {
  window.addEventListener('resize', notify);
  return () => window.removeEventListener('resize', notify);
};

/** The viewport width in CSS px, kept current by resize events. */
export function useViewportWidth(): number {
  return useSyncExternalStore(onResize, () => window.innerWidth, () => 1440);
}
