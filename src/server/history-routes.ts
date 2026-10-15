import type http from 'node:http';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import type { HistoryStore } from '../history/store.js';

const gzip = promisify(zlib.gzip);

const MIN_BUCKETS = 50;
const MAX_BUCKETS = 1000;
const DEFAULT_BUCKETS = 200;
const DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 5000;

type Json = (status: number, body: unknown, extra?: Record<string, string>) => void;

/** A non-negative integer query parameter: undefined when absent or empty, null when malformed. */
function intParam(url: URL, name: string): number | undefined | null {
  const v = url.searchParams.get(name);
  if (v === null || v === '') return undefined;
  return /^\d+$/.test(v) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
}

/** Sends a large JSON body, gzipped when the client accepts it. */
export async function sendJsonMaybeGzip(req: http.IncomingMessage, res: http.ServerResponse, json: Json, body: unknown, headers: Record<string, string>): Promise<void> {
  if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) return json(200, body);
  const gz = await gzip(Buffer.from(JSON.stringify(body)));
  res.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'gzip', vary: 'accept-encoding', 'content-length': String(gz.length) });
  res.end(gz);
}

/**
 * `/api/history/info|ticks|state|messages` for an already authenticated GET. Returns false when the path
 * is not one of them. Without a store each answers 404 `{error:'history disabled'}`.
 */
export async function handleHistoryApi(
  req: http.IncomingMessage, res: http.ServerResponse, json: Json, url: URL, history: HistoryStore | undefined, headers: Record<string, string>,
): Promise<boolean> {
  const m = /^\/api\/history\/(info|ticks|state|messages)$/.exec(url.pathname);
  if (!m) return false;
  if (!history) {
    json(404, { error: 'history disabled' });
    return true;
  }
  switch (m[1]) {
    case 'info':
      json(200, history.info());
      return true;
    case 'ticks': {
      const buckets = intParam(url, 'buckets');
      const from = intParam(url, 'from');
      const to = intParam(url, 'to');
      if (buckets === null || from === null || to === null) json(400, { error: 'expected integer buckets, from and to' });
      else json(200, history.ticks(Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, buckets ?? DEFAULT_BUCKETS)), from, to));
      return true;
    }
    case 'state': {
      const seq = intParam(url, 'seq');
      if (seq === undefined || seq === null) {
        json(400, { error: 'expected seq' });
        return true;
      }
      let state: Awaited<ReturnType<HistoryStore['stateAt']>>;
      try {
        state = await history.stateAt(seq);
      } catch (e) {
        if (e instanceof RangeError) json(400, { error: e.message });
        else json(500, { error: 'could not read history' });
        return true;
      }
      await sendJsonMaybeGzip(req, res, json, state, headers);
      return true;
    }
    case 'messages': {
      const info = history.info();
      const from = intParam(url, 'from');
      const to = intParam(url, 'to');
      const limit = intParam(url, 'limit');
      if (from === null || to === null || limit === null) json(400, { error: 'expected integer from, to and limit' });
      else if ((from ?? info.first) > (to ?? info.last)) json(400, { error: 'from is after to' });
      else json(200, history.messages(from ?? info.first, to ?? info.last, Math.min(MAX_LIMIT, limit ?? DEFAULT_LIMIT)));
      return true;
    }
  }
  return false;
}
