/** Code-unit string order: stable across locales, so sorted output is the same on every machine. */
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The last segment of a project-relative POSIX path. */
export const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
