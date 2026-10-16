import clsx from 'clsx';
import { useStore } from '../store';
import { clock } from '../agents';

// Apart from Timeline (which loads after first paint) because the banner shows over the center pane at once.

/** "Back to live": stops playback and returns to the live state. */
export function BackToLive({ className, onClick }: { className?: string; onClick?: () => void }) {
  const backToLive = useStore(s => s.backToLive);
  const replay = useStore(s => s.replay);
  if (replay) return null;
  return <button type="button" className={clsx('tl-back', className)} onClick={onClick ?? (() => void backToLive())}>Back to live</button>;
}

/** The note over the center pane while it shows the past. */
export function RewoundBanner() {
  const rewound = useStore(s => s.rewound);
  if (!rewound) return null;
  return (
    <div className="rw-banner glass" role="status">
      <i className="rw-dot" aria-hidden="true" />
      <span>Viewing {clock(rewound.at)}. Changes made since then are hidden.</span>
      <BackToLive />
    </div>
  );
}
