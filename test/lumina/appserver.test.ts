import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AppServerClient } from '../../src/lumina/appserver/client.js';

// Fake app server: answers initialize/echo, emits a notification, issues a server request, exits when stdin closes.
const FAKE = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialized') { console.log(JSON.stringify({ method: 'thread/started', params: { n: 1 } })); return; }
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: { userAgent: 'fake', codexHome: '/x', platformOs: 'test' } }));
  else if (m.method === 'echo') console.log(JSON.stringify({ id: m.id, result: m.params }));
  else if (m.method === 'ask') { console.log(JSON.stringify({ id: 'srv1', method: 'item/commandExecution/requestApproval', params: { c: 'ls' } })); }
  else if (m.method === 'fail') console.log(JSON.stringify({ id: m.id, error: { code: -1, message: 'boom' } }));
  else if (m.method === 'spawn') { const c = require('child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); console.log(JSON.stringify({ id: m.id, result: { pid: c.pid } })); }
  else if (m.method === 'hang') {}
  else if (m.id === 'srv1' || m.result !== undefined || m.error !== undefined) console.log(JSON.stringify({ method: 'got/response', params: m }));
});
rl.on('close', () => process.exit(0));
`;
const fake = () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-')), 'srv.cjs');
  fs.writeFileSync(f, FAKE);
  return new AppServerClient({ bin: process.execPath, args: [f], requestTimeoutMs: 300 });
};

describe('AppServerClient (fake server)', () => {
  it('close() reaps processes the server left running (no orphans), and the server runs in its own group', async () => {
    const c = fake();
    await c.start();
    const { pid } = await c.request<{ pid: number }>('spawn');
    expect(() => process.kill(pid, 0)).not.toThrow(); // alive
    await c.close();
    const gone = async () => { for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 50)); } return false; };
    expect(await gone()).toBe(true); // killed with the group (reaped by init, so allow a moment)
  });
  it('handshakes, correlates responses, delivers notifications, rejects errors/timeouts', async () => {
    const c = fake();
    const seen: string[] = [];
    c.onNotification((m) => seen.push(m));
    const info = await c.start();
    expect(info.userAgent).toBe('fake');
    expect(await c.request('echo', { a: 1 })).toEqual({ a: 1 });
    await expect(c.request('fail')).rejects.toThrow(/boom/);
    await expect(c.request('hang')).rejects.toThrow(/timed out/);
    expect(seen).toContain('thread/started');
    expect(await c.close()).toBe(0);
  });
  it('rejects server requests by default and routes them to a handler when set', async () => {
    const c = fake();
    const seen: { method: string; params: { error?: { message: string }; result?: unknown } }[] = [];
    c.onNotification((m, p) => seen.push({ method: m, params: p as never }));
    await c.start();
    await c.request('ask').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.find((s) => s.method === 'got/response')?.params.error?.message).toMatch(/Unhandled server request/);
    c.onServerRequest((m) => ({ decision: m }));
    seen.length = 0;
    await c.request('ask').catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.find((s) => s.method === 'got/response')?.params.result).toEqual({ decision: 'item/commandExecution/requestApproval' });
    await c.close();
  });
  it('rejects pending requests when the process dies and when it cannot start', async () => {
    const c = fake();
    await c.start();
    await c.close();
    await expect(c.request('echo')).rejects.toThrow(/not running/);
    const bad = new AppServerClient({ bin: '/nonexistent/codex' });
    await expect(bad.start()).rejects.toThrow();
  });
});

const hasCodex = (() => { try { execFileSync('codex', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
describe.skipIf(!hasCodex)('AppServerClient (real codex app-server)', () => {
  it('initializes, lists models, shuts down cleanly', async () => {
    const c = new AppServerClient();
    const info = await c.start();
    expect(info.userAgent).toMatch(/^lumina\//);
    const models = await c.request<{ data: { model: string }[] }>('model/list', {});
    expect(models.data.length).toBeGreaterThan(0);
    expect(await c.close()).toBe(0);
  }, 30000);
});
