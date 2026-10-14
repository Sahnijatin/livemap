export function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function assertPositive(n: number): void {
  if (!(n > 0)) throw new Error('must be positive');
}
