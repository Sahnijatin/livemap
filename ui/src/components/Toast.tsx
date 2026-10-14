import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { useStore } from '../store';

const SHOW_MS = 3200;

/** A short message under the toolbar for pause, resume and request errors. */
export function Toast() {
  const toast = useStore(s => s.toast);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setVisible(true);
    const id = window.setTimeout(() => setVisible(false), toast.tone === 'error' ? SHOW_MS * 1.5 : SHOW_MS);
    return () => window.clearTimeout(id);
  }, [toast]);
  return (
    <div className={clsx('toast', visible && 'show', toast?.tone === 'error' && 'err')} role={toast?.tone === 'error' ? 'alert' : 'status'} aria-live="polite">
      {toast?.text}
    </div>
  );
}
