import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function newToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Constant-time comparison; false for any length mismatch or missing value. */
export function tokenMatches(expected: string, given: string | null | undefined): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * True when the `?t=` query or the x-livemap-token header carries the token. There is deliberately
 * no cookie: cookies ignore ports, so every other server on 127.0.0.1 would receive it.
 */
export function authenticate(req: IncomingMessage, url: URL, token: string): boolean {
  if (tokenMatches(token, url.searchParams.get('t'))) return true;
  const h = req.headers['x-livemap-token'];
  return tokenMatches(token, Array.isArray(h) ? h[0] : h);
}

/** Hostname of a `host[:port]` value, lowercased; IPv6 brackets kept. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const colon = h.indexOf(':');
  return colon < 0 ? h : h.slice(0, colon);
}

/** DNS-rebinding defense: the Host header must name the loopback address or localhost. */
export function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return typeof host === 'string' && LOCAL_HOSTS.has(hostnameOf(host));
}

/** A browser Origin, when present, must be this very host (scheme-agnostic host:port match). */
export function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === String(req.headers.host ?? '').toLowerCase();
  } catch {
    return false;
  }
}
