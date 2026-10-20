import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  // THIRD_PARTY_NOTICES.md, shown as text by the browser.
  '.md': 'text/markdown; charset=utf-8',
};

export const UI_NOT_BUILT = 'LiveMap UI is not built';

function inside(dir: string, p: string): boolean {
  return p === dir || p.startsWith(dir + path.sep);
}

/** The real path of a regular file under uiDir for this URL path, or null. */
async function resolveAsset(realUi: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const candidate = path.resolve(realUi, '.' + path.posix.normalize('/' + decoded.replace(/\\/g, '/')));
  if (!inside(realUi, candidate)) return null;
  try {
    const real = await fs.realpath(candidate);
    if (!inside(realUi, real)) return null;
    const st = await fs.stat(real);
    return st.isFile() ? real : null;
  } catch {
    return null;
  }
}

async function send(res: ServerResponse, file: string, extraHeaders: Record<string, string>): Promise<void> {
  const body = await fs.readFile(file);
  res.writeHead(200, {
    ...extraHeaders,
    'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': String(body.length),
  });
  res.end(body);
}

/**
 * Serves a file from uiDir, or index.html for anything else. Never lists directories
 * and never follows a path (or symlink) out of uiDir. 503 when the UI has not been built.
 */
export async function serveStatic(uiDir: string, pathname: string, res: ServerResponse, extraHeaders: Record<string, string>): Promise<void> {
  let realUi: string;
  try {
    realUi = await fs.realpath(uiDir);
  } catch {
    realUi = '';
  }
  const index = realUi ? await resolveAsset(realUi, '/index.html') : null;
  if (!index) {
    res.writeHead(503, { ...extraHeaders, 'content-type': 'text/plain; charset=utf-8' });
    res.end(UI_NOT_BUILT);
    return;
  }
  const asset = (await resolveAsset(realUi, pathname)) ?? index;
  await send(res, asset, extraHeaders);
}
