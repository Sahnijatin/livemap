import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { addFlag, removeFlag, setPaused, ApiError } from './api';

const fetchMock = vi.fn();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('api', () => {
  it('sends JSON with the same-origin cookie on POST and DELETE', async () => {
    fetchMock.mockResolvedValueOnce(json(201, { id: 3, target: 'a.ts', note: 'n', createdAt: 1 }));
    fetchMock.mockResolvedValueOnce(json(200, { paused: false, flags: [] }));
    fetchMock.mockResolvedValueOnce(json(200, { paused: true, flags: [] }));
    expect(await addFlag('a.ts', 'n')).toEqual({ id: 3, target: 'a.ts', note: 'n', createdAt: 1 });
    await removeFlag(3);
    await setPaused(true);
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls.map(c => [c[0], c[1].method])).toEqual([['/api/flags', 'POST'], ['/api/flags/3', 'DELETE'], ['/api/pause', 'POST']]);
    for (const [, init] of calls) {
      expect(init.credentials).toBe('same-origin');
      expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    }
    expect(JSON.parse(String(calls[0][1].body))).toEqual({ target: 'a.ts', note: 'n' });
    expect(calls[1][1].body).toBeUndefined();
    expect(JSON.parse(String(calls[2][1].body))).toEqual({ paused: true });
  });

  it('turns {error} replies and network failures into readable errors with a status', async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: 'agent activity is not available' }));
    const e1 = await setPaused(true).catch(e => e);
    expect(e1).toBeInstanceOf(ApiError);
    expect(e1.message).toBe('Agent activity is not available');
    expect(e1.status).toBe(503);

    fetchMock.mockResolvedValueOnce(new Response('oops', { status: 500 }));
    const e2 = await removeFlag(1).catch(e => e);
    expect(e2.message).toBe('Request failed (500)');
    expect(e2.status).toBe(500);

    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const e3 = await addFlag(null, 'x').catch(e => e);
    expect(e3.message).toBe('LiveMap is not reachable. Is it still running?');
    expect(e3.status).toBe(0);
  });
});
