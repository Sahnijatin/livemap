/**
 * A record keyed by file path (or another user-chosen name), with no prototype: a file named `constructor` or
 * `__proto__` reads as absent until set, and setting it never changes the record's prototype. Copies `from` in order.
 */
export const dict = <T>(...from: Record<string, T>[]): Record<string, T> => Object.assign(Object.create(null) as Record<string, T>, ...from);
