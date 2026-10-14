/** Pill colors per method (prototype `.mth m-GET`); anything not listed is grey like ANY. */
const KNOWN = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY', 'PAGE', 'SCREEN']);

/** An HTTP method (or PAGE / SCREEN) as a small colored pill. Shared by the API view and the inspector. */
export function MethodPill({ method }: { method: string }) {
  const m = method.toUpperCase();
  return <span className={`mth m-${KNOWN.has(m) ? m : 'ANY'}`}>{m}</span>;
}
