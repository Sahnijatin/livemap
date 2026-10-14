import type { CSSProperties, ReactNode } from 'react';
import type { SymbolKind } from '@shared/types.js';
import { LAYERS, type Layer } from '../layers';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const LAYER_PATHS: Record<Layer, ReactNode> = {
  ui: <><rect x="3" y="4" width="18" height="14" rx="3" /><path d="M8 21h8" /></>,
  api: <path d="M4 12h5l2-5 3 10 2-5h4" />,
  logic: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
  data: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></>,
  core: <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /></>,
  val: <path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6z" />,
  test: <><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" /><path d="M7.5 15h9" /></>,
  docs: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
  config: <path d="M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6" />,
};

export function LayerIcon({ layer }: { layer: Layer }) {
  return <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">{LAYER_PATHS[layer]}</svg>;
}

/** Inline style that feeds a layer's colors into `.lic`, `.ic` and `.chip i`. */
export function layerVars(layer: Layer): CSSProperties {
  return { '--lt': LAYERS[layer].tint, '--lc': LAYERS[layer].color } as CSSProperties;
}

export function LayerTile({ layer, className = 'lic' }: { layer: Layer; className?: string }) {
  return <span className={className} style={layerVars(layer)}><LayerIcon layer={layer} /></span>;
}

const KB: Record<SymbolKind, [string, string, string]> = {
  function: ['ƒ', 'var(--blue-t)', 'var(--blue)'],
  method: ['ƒ', 'var(--blue-t)', 'var(--blue)'],
  component: ['◇', 'var(--purple-t)', 'var(--purple)'],
  hook: ['↻', 'var(--teal-t)', 'var(--teal)'],
  class: ['C', 'var(--indigo-t)', 'var(--indigo)'],
  struct: ['S', 'var(--indigo-t)', 'var(--indigo)'],
  trait: ['T', 'var(--indigo-t)', 'var(--indigo)'],
  impl: ['I', 'var(--indigo-t)', 'var(--indigo)'],
  interface: ['T', 'var(--hair)', 'var(--ink2)'],
  type: ['T', 'var(--hair)', 'var(--ink2)'],
  enum: ['E', 'var(--orange-t)', 'var(--orange)'],
  module: ['M', 'var(--hair)', 'var(--ink2)'],
  namespace: ['N', 'var(--hair)', 'var(--ink2)'],
  variable: ['c', 'var(--hair)', 'var(--ink2)'],
  heading: ['#', 'var(--pink-t)', 'var(--pink)'],
};

export function KindBadge({ kind }: { kind: SymbolKind }) {
  const [glyph, bg, fg] = KB[kind] ?? KB.variable;
  return <span className="kb" style={{ background: bg, color: fg }} title={kind} aria-label={kind}>{glyph}</span>;
}

export const Chevron = ({ className = 'chev' }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
);

export const SearchIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
);

export const SunIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><circle cx="12" cy="12" r="4.5" /><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4" /></svg>
);

export const MoonIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
);

export const MenuIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10" /></svg>
);

export const PanelIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></svg>
);

export const LockIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>
);

export const PauseIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="4.5" width="4" height="15" rx="1.2" /><rect x="14" y="4.5" width="4" height="15" rx="1.2" /></svg>
);

export const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z" /></svg>
);

export const FlagIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></svg>
);

export const GitIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="8" r="2.5" /><path d="M6 8.5v7M18 10.5c0 4-6 3.5-11 6" /></svg>
);

export const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);

export const CrossIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>
);

export const ArrowDownIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M12 5v14M6 13l6 6 6-6" /></svg>
);

export const PulseIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M4 12h4l3-7 3 14 3-7h3" /></svg>
);

export const PencilIcon = () => (
  <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>
);
