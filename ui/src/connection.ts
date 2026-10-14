import type { ServerMessage } from '@shared/protocol.js';
import { useStore } from './store';

const WS_UNAUTHORIZED = 4401;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 5000;

/** The key from the first load's `?t=`, kept in memory only; the HttpOnly cookie covers reloads. */
let token: string | null = null;
let started = false;

/** Reads `?t=` once and removes it from the address bar (R11). */
export function takeToken(): string | null {
  const url = new URL(window.location.href);
  const t = url.searchParams.get('t');
  if (t) {
    token = t;
    url.searchParams.delete('t');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }
  return token;
}

/** Headers for API requests: the token when we have it, otherwise the cookie does the work. */
export function authHeaders(): Record<string, string> {
  return token ? { 'x-livemap-token': token } : {};
}

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = token ? `?t=${encodeURIComponent(token)}` : '';
  return `${proto}//${window.location.host}/ws${q}`;
}

/** Opens the live socket, feeds every message to the store, and reconnects with backoff. */
export function connect(): void {
  if (started) return;
  started = true;
  takeToken();
  const store = useStore.getState();
  let delay = BACKOFF_START_MS;

  const open = (): void => {
    store.setConnection('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      retry();
      return;
    }
    ws.onopen = () => {
      delay = BACKOFF_START_MS;
      useStore.getState().setConnection('open');
    };
    ws.onmessage = ev => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMessage;
      } catch {
        return;
      }
      useStore.getState().apply(msg);
    };
    ws.onclose = ev => {
      if (ev.code === WS_UNAUTHORIZED) {
        useStore.getState().setConnection('unauthorized');
        return; // a bad key never gets better by retrying
      }
      retry();
    };
    ws.onerror = () => {
      // onclose follows and decides what to do.
    };
  };

  const retry = (): void => {
    useStore.getState().setConnection('closed');
    const wait = delay;
    delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    window.setTimeout(open, wait);
  };

  open();
}
