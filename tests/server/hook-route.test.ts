import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type http from 'node:http';
import { AgentHub } from '../../src/agents/hub.js';
import { handleHook } from '../../src/server/agent-routes.js';

const TOKEN = 'tok';
const hubs: AgentHub[] = [];
afterEach(() => { for (const h of hubs.splice(0)) h.stop(); });

function fakeReq(body: unknown, destroyed: boolean): http.IncomingMessage {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage;
  Object.assign(req, { method: 'POST', headers: { 'x-livemap-token': TOKEN, 'content-type': 'application/json' }, socket: { destroyed } });
  return req;
}
function fakeRes() {
  const res = new EventEmitter() as EventEmitter & { writableFinished: boolean };
  res.writableFinished = false;
  return res;
}
const codexPre = { agent: 'codex', event: 'PreToolUse', payload: { session_id: 'c', tool_name: 'Bash', tool_use_id: 'b', tool_input: { command: 'ls' } } };

describe('M1: POST /hook flag delivery', () => {
  it('skips the control check when the hook connection is already gone', async () => {
    const hub = new AgentHub('/proj');
    hubs.push(hub);
    hub.control.addFlag(null, 'wait');
    const replies: unknown[] = [];
    await handleHook(fakeReq(codexPre, true), fakeRes() as never, (_s, b) => { replies.push(b); }, TOKEN, hub);
    expect(replies).toEqual([{ block: null }]);
    expect(hub.control.state().flags[0].deliveredAt).toBeUndefined();
    expect(hub.events().map((e) => e.type)).toEqual(['tool_start']);
  });

  it('undelivers the flags when the response closes before it finished', async () => {
    const hub = new AgentHub('/proj');
    hubs.push(hub);
    hub.control.addFlag(null, 'wait');
    const res = fakeRes();
    await handleHook(fakeReq(codexPre, false), res as never, () => {}, TOKEN, hub);
    expect(hub.control.state().flags[0].deliveredAt).toBeTypeOf('number');
    res.emit('close');
    expect(hub.control.state().flags[0].deliveredAt).toBeUndefined();
  });

  it('keeps the flags delivered when the response finished', async () => {
    const hub = new AgentHub('/proj');
    hubs.push(hub);
    hub.control.addFlag(null, 'wait');
    const res = fakeRes();
    await handleHook(fakeReq(codexPre, false), res as never, () => { res.writableFinished = true; }, TOKEN, hub);
    res.emit('close');
    expect(hub.control.state().flags[0].deliveredAt).toBeTypeOf('number');
  });
});
