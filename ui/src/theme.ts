import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';
const KEY = 'livemap-theme';

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function storedTheme(): Theme | null {
  try {
    const t = window.localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

/** Follows prefers-color-scheme until the user picks a theme, which is then remembered. */
export function useTheme(): { theme: Theme; toggle(): void } {
  const [manual, setManual] = useState<Theme | null>(storedTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setSystem(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (manual) root.dataset.theme = manual;
    else delete root.dataset.theme;
  }, [manual]);

  const theme = manual ?? system;
  const toggle = useCallback(() => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setManual(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  }, [theme]);

  return { theme, toggle };
}
