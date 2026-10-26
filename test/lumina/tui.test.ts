import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/* eslint-disable no-control-regex */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30000 }); // real timers and child processes: generous under parallel load
import { AppClient, Chat } from '../../src/lumina/tui/chat.js';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { TurnRouter } from '../../src/lumina/tui/routing.js';
import { emulate } from './term.js';
import { COMMANDS } from '../../src/lumina/tui/commands.js';
import { main, runTui } from '../../src/lumina/tui/tui.js';

const CAT = [
  { slug: 'gpt-6-luna', name: 'GPT-6 Luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
];
type Handler = (m: string, p: unknown) => void;
class FakeClient implements AppClient {
  handlers = new Set<Handler>();
  closers = new Set<(e: Error) => void>();
  requests: { method: string; params: Record<string, any> }[] = [];
  closed = false;
  turns = 0;
  constructor(public reply: (text: string, n: number) => string[] = (t) => [`echo:${t}`]) {}
  emit(m: string, p: unknown) { for (const h of this.handlers) h(m, p); }
  request = (async (method: string, params: Record<string, any>) => {
    this.requests.push({ method, params });
    if (method === 'turn/interrupt') { this.interrupted.push(params); this.finish?.(); return {}; }
    if (method === 'thread/read') {
      if (this.readFail) throw new Error('boom');
      return { thread: { turns: this.history } };
    }
    if (method === 'account/rateLimits/read') {
      if (this.usageFail) throw new Error('not available for API-key auth');
      return { ordinaryUsageAllowed: true, rateLimits: { planType: 'team', primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 }, secondary: { usedPercent: 25, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 }, credits: { hasCredits: false, unlimited: false, balance: null }, rateLimitReachedType: null, spendControlReached: false }, rateLimitResetCredits: { availableCount: 3 } };
    }
    if (method === 'account/usage/read') return { summary: { lifetimeTokens: 8993742490, peakDailyTokens: 328538694, currentStreakDays: 32 }, dailyUsageBuckets: [{ startDate: new Date().toISOString().slice(0, 10), tokens: 1500000 }, { startDate: '2020-01-01', tokens: 9 }] };
    if (method === 'skills/list') return { data: [{ cwd: params.cwds?.[0], skills: this.skills, errors: [] }] };
    if (method === 'thread/list') return this.listPage ? this.listPage(params) : { data: [{ id: 'abcdef12-0000', preview: 'earlier chat' }, { id: 'zzzz9999-0000', preview: 'older' }] };
    if (method === 'thread/resume' && this.missing.includes(params.threadId)) throw new Error(`thread not found: ${params.threadId}`);
    if (method === 'thread/resume') return { thread: { id: params.threadId }, model: 'gpt-6-sol' };
    if (method === 'thread/start') return params.ephemeral ? { thread: { id: `iso-${++this.iso}` }, model: 'gpt-6-luna' } : { thread: { id: 't1' }, model: 'gpt-6-luna', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
    if (method === 'thread/compact/start') { setTimeout(() => this.emit('thread/compacted', { threadId: params.threadId, turnId: 'c' }), 5); return {}; }
    if (method === 'turn/start') {
      const n = ++this.turns;
      if (this.onTurn) {
        const threadId = params.threadId;
        this.finish = () => this.emit('turn/completed', { threadId, turn: { status: 'interrupted', error: null } });
        setTimeout(async () => { await this.onTurn!(threadId); }, 5);
        return { turn: { id: `u${n}` } };
      }
      setTimeout(() => {
        for (const d of this.reply(params.input[0].text, n)) this.emit('item/agentMessage/delta', { threadId: params.threadId, delta: d });
        this.emit('item/agentMessage/delta', { threadId: 'other', delta: 'LEAK' });
        this.emit('turn/completed', { threadId: params.threadId, turn: { status: 'completed', error: null } });
      }, 5);
      return { turn: { id: `u${n}` } };
    }
    return {};
  }) as AppClient['request'];
  onNotification = ((h: Handler) => { this.handlers.add(h); return () => this.handlers.delete(h); }) as AppClient['onNotification'];
  skills = [
    { name: 'caveman', description: 'Ultra-compressed communication mode', path: '/home/.agents/skills/caveman/SKILL.md', scope: 'user', enabled: true },
    { name: 'zebra-greeting', description: 'Use when asked to greet the zebra', path: '/w/.agents/skills/zebra-greeting/SKILL.md', scope: 'repo', enabled: true },
    { name: 'skill-creator', description: 'Create skills', path: '/sys/skill-creator/SKILL.md', scope: 'system', enabled: true },
    { name: 'disabled-one', description: 'off', path: '/x', scope: 'user', enabled: false },
  ];
  usageFail = false;
  listPage?: (params: Record<string, any>) => unknown;
  missing: string[] = [];
  iso = 0;
  readFail = false;
  history: unknown[] = [
    { status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Create auth module\n  with JWT' }] }, { type: 'reasoning', summary: ['secret thoughts'] }, { type: 'commandExecution', commandActions: [{ type: 'read' }], status: 'completed', exitCode: 0 }, { type: 'commandExecution', commandActions: [{ type: 'read' }], status: 'completed', exitCode: 0 }, { type: 'agentMessage', text: 'Done.\nAuth module added.' }] },
    { status: 'completed', items: [{ type: 'userMessage', content: [{ type: 'text', text: 'run tests' }, { type: 'skill', name: 'x' }] }, { type: 'commandExecution', commandActions: [{ type: 'unknown' }], status: 'failed', exitCode: 1 }, { type: 'agentMessage', text: 'Tests failed.' }] },
  ];
  serverHandler?: (m: string, p: unknown) => Promise<unknown> | unknown;
  onServerRequest = ((h: (m: string, p: unknown) => Promise<unknown> | unknown) => { this.serverHandler = h; }) as AppClient['onServerRequest'];
  interrupted: unknown[] = [];
  finish?: () => void;
  onTurn?: (threadId: string) => Promise<void> | void;
  onClose = ((h: (e: Error) => void) => { this.closers.add(h); }) as AppClient['onClose'];
  close = (async () => { this.closed = true; return 0; }) as AppClient['close'];
}

// earlier suites test single-turn behaviour; staged execution has its own suite
const LEGACY = ConfigSchema.parse({ stages: { enabled: false } });
process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-tui-')); // routing logs never touch the real home
process.env.TERM = 'xterm-256color'; // tty tests need a cursor-addressable terminal

describe('Chat', () => {
  it('streams deltas of its own thread, reuses one thread across turns, read-only/never-ask', async () => {
    const c = new FakeClient((t, n) => [`a${n}`, `-${t}`]);
    const out: string[] = [];
    const chat = new Chat(c, { cwd: '/w', onDelta: (d) => out.push(d) });
    expect((await chat.send('hi')).status).toBe('completed');
    await chat.send('again');
    expect(out.join('')).toBe('a1-hia2-again');
    expect(c.requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    expect(c.requests[0].params).toMatchObject({ cwd: '/w', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(c.requests.filter((r) => r.method === 'turn/start').every((r) => r.params.threadId === 't1')).toBe(true);
    expect(chat.model).toBe('gpt-6-luna');
    expect(c.handlers.size).toBe(0);
  });
  it('rejects overlapping turns and reports server death as failure', async () => {
    const c = new FakeClient();
    const chat = new Chat(c, { cwd: '/w', onDelta: () => undefined });
    const first = chat.send('a');
    await expect(chat.send('b')).rejects.toThrow(/already running/);
    await first;
    c.reply = () => [];
    const p = chat.send('c');
    await new Promise((r) => setTimeout(r, 1));
    for (const h of c.closers) h(new Error('gone'));
    expect((await p).status).toBe('failed');
  });
});

describe('TUI', () => {
  const setup = (client: FakeClient, resume?: string, tty = false) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 40, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    const done = runTui(client, '/w', { input, output }, { router, resume });
    return { input, output, done, text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it('multi-turn conversation with streamed output, then exit', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('hello\n');
    for (let i = 0; i < 250 && !t.text().includes('Completed in'); i++) await wait(20);
    t.input.write('world\n');
    for (let i = 0; i < 250 && (t.text().match(/Completed in/g) ?? []).length < 2; i++) await wait(20);
    expect(t.text()).toContain('echo:hello');
    expect(t.text()).toContain('echo:world');
    expect(t.text()).not.toContain('LEAK');
    expect(c.turns).toBe(2);
    t.input.write('exit\n');
    expect(await t.done).toBe(0);
    expect(c.closed).toBe(true);
  });
  it('ignores input during a turn, ends cleanly on Ctrl-D (EOF), and exits 1 when the server dies', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('one\ntwo\n');
    await wait();
    expect(c.turns).toBe(1);
    expect(t.text()).toContain('draft kept');
    t.input.end();
    expect(await t.done).toBe(0);

    const c2 = new FakeClient();
    const t2 = setup(c2);
    for (const h of c2.closers) h(new Error('dead'));
    expect(await t2.done).toBe(1);
    expect(t2.text()).toContain('App Server exited');
  });
  it('redraws the input area on terminal resize when idle and detaches the listener on exit', async () => {
    const c = new FakeClient();
    const t = setup(c, undefined, true);
    t.input.write('draft');
    const before = t.text().split('›').length;
    (t.output as unknown as EventEmitter).emit('resize');
    expect(t.text().split('›').length).toBeGreaterThan(before);
    t.input.write('\x15exit\r');
    await t.done;
    expect((t.output as unknown as EventEmitter).listenerCount('resize')).toBe(0);
  });
});

describe('Phase 3: routing, slash commands, resume', () => {
  const setup = (client: FakeClient, resume?: string) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    const done = runTui(client, '/w', { input, output }, { router, resume });
    return { input, done, text: () => text, router };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  /** Waits until `n` requests have finished (non-TTY prints one completion line per request). */
  const settled = async (t: { text(): string }, n: number) => { const t0 = Date.now(); while ((t.text().match(/Completed in/g) ?? []).length < n && Date.now() - t0 < 5000) await wait(20); await wait(30); };
  const turnParams = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params);

  it('routes each turn independently on one thread (context preserved) and shows the selection', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('update the button text\n'); await settled(t, 1);
    t.input.write('Fix payment webhook signature verification\n'); await settled(t, 2);
    const [a, b] = turnParams(c);
    expect([a.model, a.effort, a.threadId]).toEqual(['gpt-6-luna', 'low', 't1']);
    expect([b.model, b.effort, b.threadId]).toEqual(['gpt-6-sol', 'high', 't1']);
    expect(c.requests.filter((r) => r.method === 'thread/start')).toHaveLength(1);
    expect(t.text()).toContain('[critical · gpt-6-sol/high]');
    t.input.write('/exit\n');
    expect(await t.done).toBe(0);
  });
  it('vague follow-ups keep the previous selection; /model and /reasoning override and validate', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('Fix payment webhook signature verification\n'); await settled(t, 1);
    t.input.write('ok do it\n'); await settled(t, 2);
    expect(turnParams(c)[1]).toMatchObject({ model: 'gpt-6-sol', effort: 'high' });
    t.input.write('/model gpt-6-luna\n'); await wait();
    t.input.write('/reasoning low\n'); await wait();
    t.input.write('Refactor authentication middleware\n'); await settled(t, 3);
    expect(turnParams(c)[2]).toMatchObject({ model: 'gpt-6-luna', effort: 'low' });
    t.input.write('/model nope\n'); await wait();
    expect(t.text()).toMatch(/Unsupported model/);
    t.input.write('/reasoning auto\n'); await wait();
    t.input.write('/model auto\n'); await wait();
    expect(t.router.model).toBeUndefined();
    expect(t.router.reasoning).toBeUndefined();
    t.input.write('/bogus\n'); await wait();
    expect(t.text()).toMatch(/unknown command \/bogus/);
    t.input.end(); await t.done;
  });
  it('/new starts a fresh thread; /resume lists, resumes by number, and sends on the resumed thread', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('hello\n'); await settled(t, 1);
    t.input.write('/new\n'); await wait();
    t.input.write('hello again\n'); await settled(t, 2);
    expect(c.requests.filter((r) => r.method === 'thread/start')).toHaveLength(2);
    t.input.write('/resume\n'); await wait();
    expect(t.text()).toContain('1. earlier chat');
    t.input.write('/resume 2\n'); await wait();
    t.input.write('continue the work\n'); await settled(t, 3);
    expect(c.requests.find((r) => r.method === 'thread/resume')?.params).toMatchObject({ threadId: 'zzzz9999-0000', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(turnParams(c).at(-1)).toMatchObject({ threadId: 'zzzz9999-0000' });
    t.input.write('/resume 9\n'); await wait();
    expect(t.text()).toContain('pick a listed number');
    t.input.end(); await t.done;
  });
  it('--resume attaches to the latest saved thread at startup', async () => {
    const c = new FakeClient();
    const t = setup(c, 'last');
    await wait();
    expect(c.requests.find((r) => r.method === 'thread/resume')?.params.threadId).toBe('abcdef12-0000');
    t.input.write('/exit\n'); await t.done;
  });
});

describe('Phase 4: approvals, cancellation, recovery, CLI', () => {
  const setup = (client: FakeClient, extra: Record<string, unknown> = {}, tty = false) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    const done = runTui(client, '/w', { input, output }, { router, ...extra });
    return { input, done, text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  /** Polls instead of sleeping: robust when the machine is busy. */
  const until = async (f: () => boolean, ms = 5000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await wait(20); };
  const approvalTurn = (c: FakeClient, decisions: unknown[], request = { command: 'rm -rf build', cwd: '/w' }) => {
    c.onTurn = async (threadId) => {
      decisions.push(await c.serverHandler!('item/commandExecution/requestApproval', { threadId, ...request }));
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
  };

  it.each([['y', 'accept'], ['a', 'acceptForSession'], ['n', 'decline'], ['', 'decline'], ['c', 'cancel']])('approval answer %j -> %s', async (answer, decision) => {
    const c = new FakeClient();
    const decisions: unknown[] = [];
    approvalTurn(c, decisions);
    const t = setup(c);
    t.input.write('delete the build dir\n'); await until(() => t.text().includes('[y] Approve'));
    expect(t.text()).toContain('Approval Required');
    expect(t.text()).toContain('rm -rf build');
    expect(t.text()).toContain('[y] Approve');
    t.input.write('maybe\n'); await wait(20); // invalid answer re-asks, does not decide
    expect(decisions).toHaveLength(0);
    t.input.write(`${answer}\n`); await until(() => decisions.length > 0);
    expect(decisions).toEqual([{ decision }]);
    t.input.write('/exit\n'); expect(await t.done).toBe(0);
  });
  it('declines approvals for other threads, unsupported requests, and when no UI is attached', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('hi\n'); await wait();
    await expect(c.serverHandler!('item/commandExecution/requestApproval', { threadId: 'other', command: 'x' })).rejects.toThrow(/unknown conversation/);
    await expect(c.serverHandler!('item/tool/call', { threadId: 't1' })).rejects.toThrow(/Unsupported/);
    t.input.end(); await t.done;
    const bare = new FakeClient();
    const chat = new Chat(bare, { cwd: '/w', onDelta: () => undefined });
    await chat.send('x');
    expect(await bare.serverHandler!('item/fileChange/requestApproval', { threadId: 't1' })).toEqual({ decision: 'decline' });
  });
  it('--read-only policy is sent on thread start', async () => {
    const c = new FakeClient();
    await new Chat(c, { cwd: '/w', onDelta: () => undefined, policy: { approvalPolicy: 'never', sandbox: 'read-only' } }).send('x');
    expect(c.requests[0].params).toMatchObject({ approvalPolicy: 'never', sandbox: 'read-only' });
  });
  it('Ctrl-C interrupts the running turn (and cancels a pending approval); idle Ctrl-C quits with 130', async () => {
    const c = new FakeClient();
    const decisions: unknown[] = [];
    c.onTurn = async (threadId) => { decisions.push(await c.serverHandler!('item/commandExecution/requestApproval', { threadId, command: 'sleep 99' })); };
    const t = setup(c, {}, true);
    t.input.write('run it\r'); await until(() => t.text().includes('Approval Required'));
    expect(t.text()).toContain('Approval Required');
    t.input.write('\x03'); await until(() => t.text().includes('Cancelled after'));
    expect(c.interrupted).toEqual([{ threadId: 't1', turnId: 'u1' }]);
    expect(decisions).toEqual([{ decision: 'cancel' }]);
    expect(t.text().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).toContain('! Cancelled after');
    t.input.write('\x03');
    expect(await t.done).toBe(130);
  });
  it('recovers from an unexpected server exit by reconnecting and resuming the thread', async () => {
    const c1 = new FakeClient();
    const c2 = new FakeClient();
    const t = setup(c1, { reconnect: async () => c2 });
    t.input.write('hello\n'); await wait();
    for (const h of [...c1.closers]) h(new Error('crashed'));
    await wait();
    expect(c2.requests.find((r) => r.method === 'thread/resume')?.params.threadId).toBe('t1');
    t.input.write('again\n'); await wait();
    expect(c2.turns).toBe(1);
    expect(t.text()).toContain('reconnected');
    t.input.write('/exit\n'); expect(await t.done).toBe(0);
    expect(c2.closed).toBe(true);
  });
  it('gives up with a resume hint when reconnecting fails', async () => {
    const c1 = new FakeClient();
    const t = setup(c1, { reconnect: async () => { throw new Error('no codex'); } });
    for (const h of [...c1.closers]) h(new Error('crashed'));
    expect(await t.done).toBe(1);
    expect(t.text()).toContain('reconnect failed: no codex');
  });
  it('CLI: --help, --version, bad flags', async () => {
    const out: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((m: string) => { out.push(String(m)); });
    const err = vi.spyOn(console, 'error').mockImplementation((m: string) => { out.push(String(m)); });
    try {
      expect(await main(['--help'])).toBe(0);
      expect(await main(['--version'])).toBe(0);
      expect(await main(['--bogus'])).toBe(2);
    } finally { log.mockRestore(); err.mockRestore(); }
    expect(out.join('\n')).toMatch(/Ctrl-C interrupts[\s\S]*lumina \d+\.\d+\.\d+[\s\S]*Unknown option/);
  });
  it('shows real activity from App Server events and exactly one completion line (plain mode)', async () => {
    const c = new FakeClient();
    c.onTurn = async (threadId) => {
      c.emit('turn/started', { threadId, turn: { id: 'u1' } });
      const it = { type: 'commandExecution', id: 'c1', commandActions: [{ type: 'read' }], status: 'completed', exitCode: 0 };
      c.emit('item/started', { threadId, item: it });
      c.emit('item/completed', { threadId, item: it });
      c.emit('item/agentMessage/delta', { threadId, delta: 'all good\n' });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c);
    t.input.write('look around\n'); await wait();
    const txt = t.text();
    expect(txt).toContain('✓ Read 1 file');
    expect(txt).toContain('all good');
    expect(txt.match(/Completed in/g)).toHaveLength(1);
    expect(txt).not.toContain('\x1b[2K'); // non-TTY: no redraw escapes
    t.input.write('/exit\n'); await t.done;
  });

  // ---- multi-line composer integration (TTY key mode) ----
  const plain = (s: string) => s.replace(/\x1b\[[0-9;?<>]*[A-Za-z]/g, '').replace(/\r/g, '');
  const submits = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text);

  it('submits multi-line prompts intact (Shift+Enter, paste), shows them in history, never double-submits', async () => {
    const c = new FakeClient();
    const t = setup(c, {}, true);
    t.input.write('Create auth module');
    t.input.write('\x1b[13;2u'); // Shift+Enter (kitty protocol)
    t.input.write('  Include JWT');
    t.input.write('\x1b\r'); // Option+Enter
    t.input.write('\x1b[200~Add RBAC\n    nested indent\nAdd tests\x1b[201~'); // bracketed paste
    await wait(20);
    expect(submits(c)).toEqual([]); // nothing submitted yet
    t.input.write('\r'); await wait();
    expect(submits(c)).toEqual(['Create auth module\n  Include JWT\nAdd RBAC\n    nested indent\nAdd tests']);
    expect(plain(t.text())).toContain('› Create auth module\n    Include JWT');
    t.input.write('\r'); await wait(20); // empty Enter: nothing sent
    t.input.write('   '); t.input.write('\r'); await wait(20);
    expect(c.turns).toBe(1);
    t.input.write('\x04'); expect(await t.done).toBe(0); // Ctrl-D on empty input exits
  });
  it('paste without bracketed-paste support is one insertion, not several submissions', async () => {
    const c = new FakeClient();
    const t = setup(c, {}, true);
    t.input.write('line one\rline two\rline three\r'); await wait();
    expect(c.turns).toBe(0);
    t.input.write('\r'); await wait();
    expect(submits(c)).toEqual(['line one\nline two\nline three\n'.trim()]);
    t.input.write('\x04'); await t.done;
  });
  it('Ctrl+Enter submits; typed text then Enter in one chunk submits', async () => {
    const c = new FakeClient();
    const t = setup(c, {}, true);
    t.input.write('a'); t.input.write('\x1b[13;5u'); await wait();
    t.input.write('b\r'); await wait();
    expect(submits(c)).toEqual(['a', 'b']);
    t.input.write('\x04'); await t.done;
  });
  it('keeps the draft typed during streaming, and Enter while busy does not submit or lose it', async () => {
    const c = new FakeClient();
    let release!: () => void;
    c.onTurn = async (threadId) => {
      c.emit('item/agentMessage/delta', { threadId, delta: 'streaming part one\n' });
      await new Promise<void>((r) => { release = r; });
      c.emit('item/agentMessage/delta', { threadId, delta: 'part two\n' });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c, {}, true);
    t.input.write('first\r'); await wait();
    t.input.write('next prompt draft'); t.input.write('\r'); await wait(20);
    expect(c.turns).toBe(1);
    expect(plain(t.text())).toContain('draft kept');
    release(); await wait();
    const tail = plain(t.text()).split('Completed in')[1];
    expect(tail).toContain('› next prompt draft'); // restored when idle
    expect(plain(t.text()).split('part two')[0]).not.toContain('› next prompt draft\n'.repeat(2));
    t.input.write('\r'); await wait();
    expect(submits(c)).toEqual(['first', 'next prompt draft']);
    t.input.write('\x03\x03'); // Ctrl-C twice: first interrupts the running turn... then quits
    await wait(); t.input.end(); await t.done;
  });
  it('keeps the draft across an approval prompt and restores it afterwards', async () => {
    const c = new FakeClient();
    const decisions: unknown[] = [];
    c.onTurn = async (threadId) => {
      await wait(30);
      decisions.push(await c.serverHandler!('item/commandExecution/requestApproval', { threadId, command: 'npm install' }));
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c, {}, true);
    t.input.write('go\r'); t.input.write('my draft'); await until(() => plain(t.text()).includes('Approval Required'));
    expect(plain(t.text())).toContain('Approval Required');
    t.input.write('y\r'); await until(() => decisions.length > 0 && plain(t.text()).includes('Completed in')); await wait(50);
    expect(decisions).toEqual([{ decision: 'accept' }]);
    expect(plain(t.text()).split('Completed in').pop()).toContain('› my draft');
    t.input.write('\x04'); await wait(); t.input.write('\x15'); t.input.write('\x04'); await t.done;
  });

  // ---- approval modes ----
  const reqCmd = (c: FakeClient, threadId: string, command: string, extra: Record<string, unknown> = {}) =>
    c.serverHandler!('item/commandExecution/requestApproval', { threadId, itemId: `i${Math.random()}`, command: `/bin/zsh -lc '${command}'`, cwd: '/w', ...extra });
  const runTurn = async (c: FakeClient, t: { input: PassThrough }, fn: (threadId: string) => Promise<unknown>, prompt = 'go\n') => {
    let out: unknown;
    c.onTurn = async (threadId) => { out = await fn(threadId); c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } }); };
    t.input.write(prompt); await wait(120);
    return out;
  };

  it('defaults to manual, switches modes mid-session, and affects only subsequent requests', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/approval status\n'); await wait();
    expect(t.text()).toContain('approval mode: manual');
    t.input.write('/approval\n'); await wait();
    expect(t.text()).toMatch(/1\. Manual[\s\S]*2\. Smart[\s\S]*3\. Auto/);
    // manual: even `git status` prompts the user
    const p = runTurn(c, t, (id) => reqCmd(c, id, 'git status'));
    await wait(100);
    expect(t.text()).toContain('Approval Required');
    t.input.write('n\n'); expect(await p).toEqual({ decision: 'decline' });
    t.input.write('/approval smart\n'); await wait();
    const before = t.text().length;
    expect(await runTurn(c, t, (id) => reqCmd(c, id, 'go test ./...'))).toEqual({ decision: 'accept' });
    expect(t.text().slice(before)).toContain('Auto-approved: go test ./...');
    expect(t.text().slice(before)).not.toContain('Approval Required');
    t.input.write('/approval 3\n'); await wait();
    expect(await runTurn(c, t, (id) => reqCmd(c, id, 'git add .'))).toEqual({ decision: 'accept' });
    t.input.write('/approval bogus\n'); await wait();
    expect(t.text()).toContain('usage: /approval');
    t.input.end(); await t.done;
  });
  it('smart: unknown commands prompt (cancel works), dangerous ones are auto-rejected with a hint', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/approval smart\n'); await wait();
    const p = runTurn(c, t, (id) => reqCmd(c, id, 'mystery-tool --x'));
    await wait(100);
    expect(t.text()).toContain('Approval Required');
    t.input.write('c\n'); expect(await p).toEqual({ decision: 'cancel' });
    expect(await runTurn(c, t, (id) => reqCmd(c, id, 'git push --force'))).toEqual({ decision: 'decline' });
    expect(t.text()).toMatch(/Auto-rejected: git push --force \(git force push[^)]*\/approval manual/);
    t.input.end(); await t.done;
  });
  it('network, other cwd, file changes and unsupported requests are never auto-approved', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/approval auto\n'); await wait();
    const p1 = runTurn(c, t, (id) => reqCmd(c, id, 'git status', { networkApprovalContext: { host: 'x' } }));
    await wait(100); expect(t.text()).toContain('Approval Required');
    t.input.write('n\n'); expect(await p1).toEqual({ decision: 'decline' });
    const p2 = runTurn(c, t, (id) => c.serverHandler!('item/fileChange/requestApproval', { threadId: id, itemId: 'f1', grantRoot: '/w' }));
    await wait(100); expect(t.text()).toContain('Changes:');
    t.input.write('y\n'); expect(await p2).toEqual({ decision: 'accept' });
    const err = await runTurn(c, t, (id) => c.serverHandler!('item/permissions/requestApproval', { threadId: id }).catch((e: Error) => e.message));
    expect(err).toMatch(/Unsupported request/);
    t.input.end(); await t.done;
  });
  it('a repeated request for the same item is answered once (no duplicate prompt or response)', async () => {
    const c = new FakeClient();
    const t = setup(c);
    const results: unknown[] = [];
    const p = runTurn(c, t, async (id) => {
      const a = reqCmd(c, id, 'mystery', { itemId: 'dup' });
      const b = reqCmd(c, id, 'mystery', { itemId: 'dup' });
      results.push(...await Promise.all([a, b]));
    });
    await wait(100);
    expect(t.text().match(/Approval Required/g)).toHaveLength(1);
    t.input.write('y\n'); await p;
    expect(results).toEqual([{ decision: 'accept' }, { decision: 'accept' }]);
    t.input.end(); await t.done;
  });
  it('/new and /resume reset the approval mode to manual', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/approval auto\n'); await wait();
    t.input.write('/new\n'); await wait();
    expect(t.text()).toContain('approval mode reset to manual');
    t.input.write('/approval status\n'); await wait();
    expect(t.text().split('approval mode: ').pop()).toMatch(/^manual/);
    t.input.write('/approval smart\n'); await wait();
    t.input.write('/resume abcdef12\n'); await wait();
    expect(t.text().split('reset to manual').length).toBe(3);
    t.input.end(); await t.done;
  });
  it('--approval starts in the given mode; invalid values are rejected', async () => {
    const c = new FakeClient();
    const t = setup(c, undefined);
    t.input.end(); await t.done;
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try { expect(await main(['--approval', 'yolo'])).toBe(2); } finally { err.mockRestore(); }
  });
});

describe('Phase 5: layout, welcome, status bar', () => {
  const setup = (client: FakeClient, extra: Record<string, unknown> = {}, tty = true, columns = 60) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    const done = runTui(client, '/w', { input, output }, { router, version: '9.9.9', ...extra });
    return { input, output, done, text: () => text, screen: () => emulate(text), cols: (n: number) => { (output as unknown as { columns: number }).columns = n; output.emit('resize'); } };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const RULE = (n: number) => '─'.repeat(n - 1);
  const quit = async (t: ReturnType<typeof setup>) => { t.input.write('\x04'); await t.done; };

  it('welcome screen: real version, routing mode, directory; connection only when known', async () => {
    const t = setup(new FakeClient(), { connection: 'Codex 0.162.0 connected' });
    await wait();
    const rows = t.screen();
    expect(rows[0]).toBe('◆ Lumina CLI v9.9.9');
    expect(rows[1]).toBe('  Adaptive AI Coding Assistant');
    expect(rows).toContain('  GPT-6 Luna ⇄ GPT-6 Sol · Auto Routing');
    expect(rows).toContain('  /w  ·  Codex 0.162.0 connected');
    await quit(t);
    const t2 = setup(new FakeClient());
    await wait();
    expect(t2.screen().join('\n')).not.toContain('connected');
    await quit(t2);
  });
  it('persistent composer: separators, placeholder prompt and the status bar (no command hint line) sit at the bottom', async () => {
    const t = setup(new FakeClient());
    await wait();
    expect(t.screen().slice(-4)).toEqual([RULE(60), '› Ask Lumina anything...', RULE(60), '  ◉ Auto Routing · GPT-6 Luna ⇄ GPT-6 Sol']);
    t.input.write('Create auth');
    t.input.write('\x1b[13;2u');
    t.input.write('Add tests');
    await wait();
    expect(t.screen().slice(-5, -1)).toEqual([RULE(60), '› Create auth', '  Add tests', RULE(60)]);
    t.input.write('\x03'); // Ctrl-C clears the draft when idle
    await quit(t);
  });
  it('status bar follows the actual routing: model, effort, manual overrides and approval mode', async () => {
    const c = new FakeClient();
    const t = setup(c, {}, true, 80);
    const bar = () => t.screen().at(-1);
    t.input.write('update the button text\r'); await wait();
    expect(bar()).toBe('  ◉ Auto Routing · GPT-6 Luna · Low');
    t.input.write('Fix payment webhook signature verification\r'); await wait();
    expect(bar()).toBe('  ◉ Auto Routing · GPT-6 Sol · High');
    t.input.write('/model gpt-6-luna\r'); await wait();
    expect(bar()).toBe('  ◉ Manual model · GPT-6 Luna · High');
    t.input.write('/reasoning low\r'); await wait();
    expect(bar()).toBe('  ◉ Manual model · GPT-6 Luna · Low (manual)');
    t.input.write('/approval smart\r'); await wait();
    expect(bar()).toBe('  ◉ Manual model · GPT-6 Luna · Low (manual) · Approval: Smart');
    t.input.write('/reasoning auto\r'); await wait(); t.input.write('/model auto\r'); await wait(); t.input.write('/approval manual\r'); await wait();
    expect(bar()).toBe('  ◉ Auto Routing · GPT-6 Sol · High');
    await quit(t);
  });
  it('conversation: user prompt, Lumina label, indented activity and completion above a fixed composer; spinner while running', async () => {
    const c = new FakeClient();
    let release!: () => void;
    c.onTurn = async (threadId) => {
      c.emit('turn/started', { threadId, turn: { id: 'u1' } });
      const it = { type: 'commandExecution', id: 'c1', commandActions: [{ type: 'read' }], status: 'completed', exitCode: 0 };
      c.emit('item/started', { threadId, item: it });
      await new Promise<void>((r) => { release = r; });
      c.emit('item/completed', { threadId, item: it });
      c.emit('item/agentMessage/delta', { threadId, delta: 'Authentication module implemented.\n' });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c);
    t.input.write('Create authentication module\r'); await wait(150);
    let rows = t.screen();
    expect(rows).toContain('› Create authentication module');
    expect(rows).toContain('◆ Lumina');
    expect(rows.find((r) => /^ {2}[◐◓◑◒] Reading files\.\.\. \ds$/.test(r))).toBeTruthy();
    expect(rows.slice(-4, -2)).toEqual([RULE(60), '› Ask Lumina anything...']); // composer still anchored during the turn
    release(); await wait(80);
    rows = t.screen();
    const i = rows.indexOf('◆ Lumina');
    expect(rows.slice(i, i + 7)).toEqual(['◆ Lumina', '  ✓ Read 1 file', '', '  Authentication module implemented.', '', expect.stringMatching(/^ {2}✓ Completed in \ds$/), '']);
    expect(rows.join('\n')).not.toMatch(/[◐◓◑◒] Reading/);
    await quit(t);
  });
  it('immediate feedback: Preparing while skills load, then Thinking with the routed model, then the running test command', async () => {
    const c = new FakeClient();
    let skillsReady!: () => void;
    const gate = new Promise<void>((r) => { skillsReady = r; });
    const orig = c.request;
    c.request = (async (m: string, p: Record<string, any>) => { if (m === 'skills/list') await gate; return orig(m, p); }) as AppClient['request'];
    let release!: () => void;
    c.onTurn = async (threadId) => {
      c.emit('turn/started', { threadId, turn: { id: 'u1' } });
      c.emit('item/started', { threadId, item: { type: 'reasoning', id: 'r' } });
      await new Promise<void>((r) => { release = r; });
      c.emit('item/completed', { threadId, item: { type: 'reasoning', id: 'r' } });
      c.emit('item/started', { threadId, item: { type: 'commandExecution', id: 'c', command: "/bin/zsh -lc 'npm test'", commandActions: [{ type: 'unknown' }] } });
      await new Promise<void>((r) => { release = r; });
      c.emit('item/completed', { threadId, item: { type: 'commandExecution', id: 'c', command: 'npm test', status: 'completed', exitCode: 0, commandActions: [{ type: 'unknown' }] } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c);
    t.input.write('use $caveman to fix it\r'); await wait(30);
    expect(t.screen().join('\n')).toMatch(/[◐◓◑◒] Preparing\.\.\. 0s/);
    skillsReady(); await wait(80);
    expect(t.screen().join('\n')).toMatch(/[◐◓◑◒] Reasoning\.\.\. \ds\n {4}Model: GPT-6 Luna · Reasoning: \w+/);
    release(); await wait(40);
    expect(t.screen().join('\n')).toMatch(/[◐◓◑◒] Running tests\.\.\. \ds\n {4}npm test/);
    release(); await wait(80);
    const all = t.screen().join('\n');
    expect(all).toContain('✓ Ran tests');
    expect(all).not.toMatch(/[◐◓◑◒●]|Model: GPT|Preparing/); // every status row is gone after completion
    await quit(t);
  });
  it('streaming keeps the composer (and a draft typed meanwhile) at the bottom; text never overwrites it', async () => {
    const c = new FakeClient();
    let step!: () => void;
    const gate = () => new Promise<void>((r) => { step = r; });
    c.onTurn = async (threadId) => {
      c.emit('item/agentMessage/delta', { threadId, delta: 'first line\nsecond ha' });
      await gate();
      c.emit('item/agentMessage/delta', { threadId, delta: 'lf\nthird\n' });
      await gate();
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c);
    t.input.write('go\r'); await wait(80);
    t.input.write('my next question'); await wait(40);
    let rows = t.screen();
    expect(rows.slice(-4)).toEqual([RULE(60), '› my next question', RULE(60), expect.stringContaining('◉ Auto Routing')]);
    expect(rows).toContain('  first line');
    expect(rows.some((r) => r.includes('second ha'))).toBe(true); // the open line is visible above the composer
    step(); await wait(40);
    rows = t.screen();
    expect(rows).toContain('  second half');
    expect(rows).toContain('  third');
    expect(rows.indexOf('  third')).toBeLessThan(rows.indexOf('› my next question'));
    step(); await wait(60);
    expect(t.screen().join('\n')).toContain('› my next question'); // draft preserved after the turn
    t.input.write('\x15'); await quit(t);
  });
  it('approval prompt is shown cleanly (spinner hidden, placeholder explains answers) and activity resumes after', async () => {
    const c = new FakeClient();
    const decisions: unknown[] = [];
    c.onTurn = async (threadId) => {
      decisions.push(await c.serverHandler!('item/commandExecution/requestApproval', { threadId, command: 'git push', cwd: '/w' }));
      await wait(30);
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c, {}, true, 100);
    t.input.write('push it\r'); await wait(120);
    const rows = t.screen();
    expect(rows).toContain('⚠ Approval Required'.replace(/^/, '  '));
    expect(rows).toContain('  Command:');
    expect(rows).toContain('    git push');
    expect(rows.join('\n')).toContain('[y] Approve once   [a] Always this session   [n] Reject   [c] Cancel');
    expect(rows.join('\n')).not.toMatch(/[◐◓◑◒] (Connecting|Thinking)/); // spinner paused
    expect(rows).toContain('› y approve · a for session · n reject · c cancel');
    t.input.write('y\r'); await wait(120);
    expect(decisions).toEqual([{ decision: 'accept' }]);
    expect(t.screen().join('\n')).toContain('✓ Completed in');
    await quit(t);
  });
  it('terminal resize: the region re-fits the new width and the draft is kept', async () => {
    const t = setup(new FakeClient());
    t.input.write('a fairly long draft line that must be re-wrapped'); await wait();
    t.cols(30); await wait();
    const rows = t.screen();
    expect(rows.slice(-5).every((r) => r.length <= 30)).toBe(true);
    expect(rows.join('\n')).toContain('› a fairly long draft');
    t.cols(120); await wait();
    expect(t.screen().join('\n')).toContain('› a fairly long draft line that must be re-wrapped');
    t.input.write('\x15'); await quit(t);
  });
  it('NO_COLOR removes every color/dim attribute; cursor control sequences remain', async () => {
    process.env.NO_COLOR = '1';
    try {
      const t = setup(new FakeClient());
      t.input.write('hello\r'); await wait(80);
      expect(t.text()).not.toMatch(/\x1b\[(\d+;)*\d+m/);
      await quit(t);
    } finally { delete process.env.NO_COLOR; }
  });
  it('colors are used by default on a TTY', async () => {
    const t = setup(new FakeClient());
    await wait();
    expect(t.text()).toMatch(/\x1b\[36m◆/);
    await quit(t);
  });
  it('non-TTY: plain output, no separators, no status bar, no escape sequences; route shown as a line', async () => {
    const c = new FakeClient();
    const t = setup(c, {}, false);
    t.input.write('update the button text\n'); await wait(80);
    const txt = t.text();
    expect(txt).not.toContain('\x1b');
    expect(txt).not.toContain('────');
    expect(txt).not.toContain('◉');
    expect(txt).toContain('◆ Lumina CLI v9.9.9');
    expect(txt).toContain('[fast · gpt-6-luna/low]');
    expect(txt).toContain('✓ Completed in');
    t.input.end(); await t.done;
  });
  it('cancellation removes the spinner and shows the cancelled line once', async () => {
    const c = new FakeClient();
    c.onTurn = async () => { await new Promise(() => undefined); };
    const t = setup(c);
    t.input.write('long task\r'); await wait(100);
    expect(t.screen().join('\n')).toMatch(/[◐◓◑◒] Connecting/);
    t.input.write('\x03'); await wait(100);
    const txt = t.screen().join('\n');
    expect(txt.match(/Cancelled after/g)).toHaveLength(1);
    expect(txt).not.toMatch(/[◐◓◑◒] (Connecting|Cancelling)/);
    t.input.write('\x03'); expect(await t.done).toBe(130);
  });
});

describe('Phase 6: Skills', () => {
  const setup = (client: FakeClient, tty = true) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    const done = runTui(client, '/w', { input, output }, { router });
    return { input, done, text: () => text, screen: () => emulate(text) };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const turns = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input as { type: string; text?: string; name?: string; path?: string }[]);
  const quit = async (t: ReturnType<typeof setup>) => { t.input.write('\x03'); t.input.write('\x04'); await t.done; };

  it('/skills shows project skills first, then global, then system; disabled ones are hidden; metadata only', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/skills\r'); await wait();
    const rows = t.screen();
    const i = rows.findIndex((r) => r.startsWith('  Skills 3/3'));
    expect(i).toBeGreaterThan(-1);
    expect(rows.slice(i + 1, i + 4).map((r) => r.replace(/\s+/g, ' '))).toEqual([
      '▸ zebra-greeting project Use when asked to greet the zebra', ' caveman global Ultra-compressed communication mode', ' skill-creator system Create skills']);
    expect(rows.join('\n')).not.toContain('disabled-one');
    expect(rows.slice(-4)[1]).toBe('› Ask Lumina anything...'); // the composer is still there under the menu
    expect(c.requests.filter((r) => r.method === 'skills/list')).toHaveLength(1);
    expect(c.requests.find((r) => r.method === 'skills/list')!.params.cwds).toEqual(['/w']);
    t.input.write('\x1b'); await wait();
    expect(t.screen().join('\n')).not.toContain('Skills 3/3');
    await quit(t);
  });
  it('keyboard: arrows move, typing filters, Enter inserts the reference into the draft without sending', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('please use'); await wait(20);
    t.input.write('/skills\r'); await wait(); // draft is kept? no: a slash command replaces the draft only when submitted
    await quit(t);
    const c2 = new FakeClient();
    const t2 = setup(c2);
    t2.input.write('/skills\r'); await wait();
    t2.input.write('\x1b[B'); await wait(20); // down → caveman
    expect(t2.screen().join('\n')).toMatch(/▸ caveman/);
    t2.input.write('\r'); await wait();
    expect(t2.screen().join('\n')).toContain('› $caveman');
    expect(t2.screen().join('\n')).not.toContain('Skills 3/3'); // closed
    expect(turns(c2)).toEqual([]); // nothing was executed
    t2.input.write('\x03'); // clear draft
    t2.input.write('/skills\r'); await wait();
    t2.input.write('zeb'); await wait(20);
    const rows = t2.screen();
    expect(rows.find((r) => r.startsWith('  Skills'))).toContain('1/3 · filter: zeb');
    expect(rows.join('\n')).not.toContain('caveman');
    t2.input.write('\t'); await wait(); // Tab also selects
    expect(t2.screen().join('\n')).toContain('› $zebra-greeting');
    await quit(t2);
  });
  it('selection is appended to an existing draft with a separating space', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/skills zeb\r'); await wait();
    t.input.write('\r'); await wait();
    t.input.write('\x1b[13;2u'); // newline; then type more and run /skills again is not needed
    t.input.write('now greet'); await wait();
    expect(t.screen().join('\n')).toContain('› $zebra-greeting');
    expect(t.screen().join('\n')).toContain('  now greet');
    await quit(t);
  });
  it('Ctrl-C closes the menu instead of cancelling or quitting', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/skills\r'); await wait();
    t.input.write('\x03'); await wait();
    expect(t.screen().join('\n')).not.toContain('Skills 3/3');
    t.input.write('\x03'); expect(await t.done).toBe(130); // idle + empty: quits as before
  });
  it('explicit $skill invocation sends a native skill item next to the text; unknown $names do not', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('$zebra-greeting say hi, and $unknown $5\r'); await wait(80);
    expect(turns(c)[0]).toEqual([
      { type: 'text', text: '$zebra-greeting say hi, and $unknown $5', text_elements: [] },
      { type: 'skill', name: 'zebra-greeting', path: '/w/.agents/skills/zebra-greeting/SKILL.md' },
    ]);
    expect(t.screen().join('\n')).toContain('skills: $zebra-greeting');
    t.input.write('plain prompt without mentions\r'); await wait(80);
    expect(turns(c)[1]).toHaveLength(1);
    expect(c.requests.filter((r) => r.method === 'skills/list')).toHaveLength(1); // no lookup when there is no $
    t.input.write('$caveman again $caveman.\r'); await wait(80);
    expect(turns(c)[2].filter((i) => i.type === 'skill')).toEqual([{ type: 'skill', name: 'caveman', path: '/home/.agents/skills/caveman/SKILL.md' }]);
    expect(c.requests.filter((r) => r.method === 'skills/list')).toHaveLength(1); // cached across turns
    await quit(t);
  });
  it('skills/changed invalidates the cache; invocation survives /new (same thread cwd) and busy guard prevents double sends', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('$caveman a\r'); await wait(80);
    c.emit('skills/changed', {});
    t.input.write('/new\r'); await wait();
    t.input.write('$caveman b\r'); await wait(80);
    expect(c.requests.filter((r) => r.method === 'skills/list')).toHaveLength(2);
    expect(turns(c)).toHaveLength(2);
    expect(turns(c)[1].some((i) => i.type === 'skill')).toBe(true);
    await quit(t);
  });
  it('non-TTY /skills prints a plain list (no interactive menu)', async () => {
    const c = new FakeClient();
    const t = setup(c, false);
    t.input.write('/skills zeb\n'); await wait();
    expect(t.text()).toContain('$zebra-greeting [project] Use when asked to greet the zebra');
    expect(t.text()).not.toContain('caveman');
    expect(t.text()).not.toContain('\x1b');
    t.input.end(); await t.done;
  });
});

describe('MCP tool approvals', () => {
  const setup = (client: FakeClient) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 90, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, done: runTui(client, '/w', { input, output }, { router }), text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const elicit = (c: FakeClient, threadId: string, extra: Record<string, unknown> = {}) => c.serverHandler!('mcpServer/elicitation/request', {
    threadId, serverName: 'lumina-mcp', mode: 'form', requestedSchema: { type: 'object', properties: {} },
    message: 'Allow the lumina-mcp MCP server to run tool "get_my_openproject_work_packages"?',
    _meta: { codex_approval_kind: 'mcp_tool_call', persist: ['session', 'always'], tool_params_display: [{ name: 'status', value: 'open', display_name: 'status' }] }, ...extra,
  });
  const turn = async (c: FakeClient, t: { input: PassThrough }, fn: (id: string) => Promise<unknown>) => {
    let out: unknown;
    c.onTurn = async (threadId) => { out = await fn(threadId); c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } }); };
    t.input.write('list my tickets\n'); await wait(100);
    return () => out;
  };

  it.each([
    ['y', { action: 'accept', content: null, _meta: null }],
    ['a', { action: 'accept', content: null, _meta: { persist: 'session' } }],
    ['n', { action: 'decline', content: null, _meta: null }],
    ['c', { action: 'cancel', content: null, _meta: null }],
  ])('prompts the user for an MCP tool call and answers %s correctly', async (answer, expected) => {
    const c = new FakeClient();
    const t = setup(c);
    const result = await turn(c, t, (id) => elicit(c, id));
    expect(t.text()).toContain('Approval Required');
    expect(t.text()).toContain('MCP tool:');
    expect(t.text()).toContain('lumina-mcp › get_my_openproject_work_packages');
    expect(t.text()).toContain('status=open');
    t.input.write(`${answer}\n`); await wait(100);
    expect(result()).toEqual(expected);
    t.input.end(); await t.done;
  });
  it('auto mode approves read-only lumina-mcp tools once; writes, unknown tools, other servers and smart/manual still ask', async () => {
    const msg = (tool: string) => `Allow the lumina-mcp MCP server to run tool "${tool}"?`;
    const run = async (mode: string, tool: string, server = 'lumina-mcp') => {
      const c = new FakeClient();
      const t = setup(c);
      if (mode !== 'manual') { t.input.write(`/approval ${mode}\n`); await wait(); }
      const result = await turn(c, t, (id) => elicit(c, id, { serverName: server, message: msg(tool) }));
      const prompted = t.text().includes('Approval Required');
      const auto = t.text().includes(`Auto-approved: ${server} › ${tool}`);
      if (prompted) { t.input.write('n\n'); await wait(80); }
      t.input.end(); await t.done;
      return { prompted, auto, result: result() };
    };
    for (const tool of ['get_my_openproject_work_packages', 'list_clickup_tasks', 'search_code', 'find_symbol', 'inspect_mysql_table', 'read_range']) {
      expect(await run('auto', tool), tool).toEqual({ prompted: false, auto: true, result: { action: 'accept', content: null, _meta: null } }); // no persist: asked again next time
    }
    for (const tool of ['create_jira_ticket', 'add_openproject_time_entry', 'update_clickup_comment', 'delete_clickup_comment', 'reply_to_pr_comment', 'generate_commit_and_push', 'execute_mysql_query', 'brand_new_tool', 'get_']) {
      expect((await run('auto', tool)).prompted, tool).toBe(true);
    }
    expect((await run('auto', 'get_jira_ticket', 'other-mcp')).prompted).toBe(true);
    expect((await run('smart', 'get_jira_ticket')).prompted).toBe(true);
    expect((await run('manual', 'get_jira_ticket')).prompted).toBe(true);
    }, 20000);
  it('other elicitations (forms, URLs, unknown threads) are still unsupported', async () => {
    const c = new FakeClient();
    const t = setup(c);
    const result = await turn(c, t, (id) => elicit(c, id, { _meta: null }).catch((e: Error) => e.message));
    expect(result()).toMatch(/Unsupported MCP elicitation/);
    await expect(elicit(c, 'other-thread')).rejects.toThrow(/unknown conversation/);
    t.input.end(); await t.done;
  });
});

describe('/usage', () => {
  const setup = (client: FakeClient) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 90, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, done: runTui(client, '/w', { input, output }, { router }), text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it('shows Codex account limits, account tokens and this session\'s tokens as reported by the App Server', async () => {
    const c = new FakeClient();
    c.onTurn = async (threadId) => {
      c.emit('thread/tokenUsage/updated', { threadId, turnId: 'u1', tokenUsage: { total: { totalTokens: 12345, inputTokens: 10000, cachedInputTokens: 6000, outputTokens: 2345 }, last: { totalTokens: 4000 }, modelContextWindow: 100000 } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c);
    t.input.write('hi\n'); await wait(80);
    t.input.write('/usage\n'); await wait(80);
    const out = t.text();
    expect(out).toContain('Codex usage · team plan');
    expect(out).toMatch(/5h window\s+█░{9}\s+5% used\s+resets in (3h 0m|2h 5\dm)/);
    expect(out).toMatch(/Weekly\s+███░{7}\s+25% used\s+resets in (3d 0h|2d 23h)/);
    expect(out).toContain('Rate-limit resets available: 3');
    expect(out).toContain('Account tokens: last 7 days 1.5M · peak day 328.5M · lifetime 8.99B · streak 32d');
    expect(out).toContain('This session: 12,345 tokens (input 10.0k, cached 6.0k, output 2.3k) · context 4% of 100.0k');
    t.input.end(); await t.done;
  });
  it('says so when no session usage exists yet, and degrades gracefully when limits are unavailable', async () => {
    const c = new FakeClient();
    c.usageFail = true;
    const t = setup(c);
    t.input.write('/usage\n'); await wait(80);
    expect(t.text()).toContain('This session: no token usage reported yet');
    expect(t.text()).toContain('unavailable - limits: not available for API-key auth');
    expect(t.text()).toContain('Account tokens:');
    t.input.end(); await t.done;
  });
  it('/new clears the session counter', async () => {
    const c = new FakeClient();
    c.onTurn = async (threadId) => {
      c.emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: 5, inputTokens: 3, cachedInputTokens: 0, outputTokens: 2 }, last: { totalTokens: 5 }, modelContextWindow: null } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c);
    t.input.write('hi\n'); await wait(80);
    t.input.write('/new\n'); await wait();
    t.input.write('/usage\n'); await wait(80);
    expect(t.text().split('This session:').pop()).toContain('no token usage reported yet');
    t.input.end(); await t.done;
  });
});

describe('resume loads chat history', () => {
  const setup = (client: FakeClient, resume?: string) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 90, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, done: runTui(client, '/w', { input, output }, { router, resume }), text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

  it('/resume N replays the previous conversation (prompts, tool steps, answers) and continues on the same thread', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/resume\n'); await wait();
    t.input.write('/resume 2\n'); await wait();
    const out = t.text().split('resumed zzzz9999')[1];
    expect(out).toContain('› Create auth module\n    with JWT');
    expect(out).toContain('◆ Lumina\n  ✓ Read 2 files\n  Done.\n  Auth module added.');
    expect(out).toContain('› run tests\n');
    expect(out).toContain('✗ Command failed (exit 1)');
    expect(out).toContain('Tests failed.');
    expect(out).not.toContain('secret thoughts'); // hidden reasoning is never shown
    expect(out).toContain('end of previous conversation');
    expect(c.requests.find((r) => r.method === 'thread/read')?.params).toEqual({ threadId: 'zzzz9999-0000', includeTurns: true });
    t.input.write('continue\n'); await wait();
    expect(c.requests.filter((r) => r.method === 'turn/start').at(-1)?.params.threadId).toBe('zzzz9999-0000');
    t.input.end(); await t.done;
  });
  it('--resume loads the latest conversation and its history at startup', async () => {
    const c = new FakeClient();
    const t = setup(c, 'last');
    await wait();
    expect(t.text()).toContain('resumed abcdef12');
    expect(t.text()).toContain('› Create auth module');
    expect(t.text().indexOf('› Create auth module')).toBeLessThan(t.text().indexOf('end of previous conversation'));
    t.input.write('/exit\n'); await t.done;
  });
  it('a history read failure or an empty thread does not break the resume', async () => {
    const c = new FakeClient();
    c.readFail = true;
    const t = setup(c);
    t.input.write('/resume abcdef12\n'); await wait();
    expect(t.text()).toContain('resumed abcdef12');
    expect(t.text()).toContain('could not load history: boom');
    c.readFail = false; c.history = [];
    t.input.write('/resume zzzz9999\n'); await wait();
    expect(t.text().split('resumed zzzz9999')[1]).not.toContain('end of previous conversation');
    t.input.end(); await t.done;
  });
});

describe('shutdown: signals and cleanup', () => {
  const setup = (client: FakeClient, tty = true) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, output, done: runTui(client, '/w', { input, output }, { router }), text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const listeners = () => ['SIGINT', 'SIGHUP', 'SIGTERM'].map((s) => process.listenerCount(s as NodeJS.Signals));

  it.each([['SIGTERM', 143], ['SIGHUP', 129], ['SIGINT', 130]] as const)('%s: restores the terminal, stops the App Server, exits %i, leaves no listeners', async (sig, code) => {
    const before = listeners();
    const c = new FakeClient();
    const t = setup(c);
    await wait();
    process.emit(sig, sig);
    expect(await t.done).toBe(code);
    expect(c.closed).toBe(true);
    expect(t.text()).toContain('\x1b[?2004l'); // bracketed paste / kitty keyboard modes switched off
    expect(t.text()).toContain('\x1b[?25h'); // cursor visible again
    expect((t.input as unknown as { isPaused(): boolean }).isPaused()).toBe(true); // stdin no longer keeps the process alive
    expect(listeners()).toEqual(before);
    expect(t.output.listenerCount('resize')).toBe(0);
  });
  it('signals during a running turn also shut down cleanly (turn is not left running)', async () => {
    const c = new FakeClient();
    c.onTurn = async () => { await new Promise(() => undefined); };
    const t = setup(c);
    t.input.write('long task\r'); await wait(100);
    process.emit('SIGTERM', 'SIGTERM');
    expect(await t.done).toBe(143);
    expect(c.closed).toBe(true);
  });
  it('Ctrl-C twice and Ctrl-D leave the same clean state (no stray listeners or modes)', async () => {
    const before = listeners();
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('\x03'); expect(await t.done).toBe(130);
    expect(c.closed).toBe(true);
    expect(listeners()).toEqual(before);
    expect(t.text()).toContain('\x1b[?2004l');
  });
});

describe('staged execution in the TUI (adaptive routing)', () => {
  const STAGED = ConfigSchema.parse({});
  const setup = (client: FakeClient, tty = false) => {
    const router = new TurnRouter(STAGED, '/nonexistent', [...CAT, { slug: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high'] }]);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 110, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, done: runTui(client, '/w', { input, output }, { router }), text: () => text, screen: () => emulate(text) };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const turns = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params);
  const complete = (c: FakeClient, threadId: string, items: unknown[] = [], usage?: Record<string, number>) => {
    for (const item of items) c.emit('item/completed', { threadId, item });
    if (usage) c.emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: usage, last: { totalTokens: usage.lastTotal ?? usage.totalTokens }, modelContextWindow: 250000 } });
    c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
  };
  const testRun = (exit: number) => ({ type: 'commandExecution', command: "/bin/zsh -lc 'npm test'", exitCode: exit, status: exit ? 'failed' : 'completed' });

  it('a simple prompt is one turn, verbatim, labelled Direct with its real model', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('Create math.js exporting add(a, b), add tests using node:test and run them, then do a short security review.\n'); await wait();
    expect(turns(c)).toHaveLength(1);
    expect(turns(c)[0]).toMatchObject({ model: 'gpt-6-luna', effort: 'medium', threadId: 't1' });
    expect(turns(c)[0].input[0].text).toBe('Create math.js exporting add(a, b), add tests using node:test and run them, then do a short security review.');
    expect(t.text()).toContain('Strategy: Direct · Model: GPT-6 Luna · Stages: 1');
    expect(t.text()).not.toContain('Switching model');
    t.input.end(); await t.done;
  });
  it('a security review is one stage on the stronger model, with analysis-level reasoning (risk → model, depth → reasoning)', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('Review this authentication middleware\n'); await wait();
    expect(turns(c).map((p) => `${p.model}/${p.effort}`)).toEqual(['gpt-6-sol/medium']);
    t.input.end(); await t.done;
  });
  it('failing tests escalate within the same request: real second turn on a stronger model, shown in the UI with token totals', async () => {
    const c = new FakeClient();
    let n = 0;
    c.onTurn = async (threadId) => {
      n++;
      complete(c, threadId, [testRun(n === 1 ? 1 : 0)], n === 1 ? { totalTokens: 20300, inputTokens: 20000, cachedInputTokens: 15000, outputTokens: 300 } : { totalTokens: 28420, inputTokens: 28000, cachedInputTokens: 22000, outputTokens: 420 });
    };
    const t = setup(c);
    t.input.write('Add CSV export with tests\n'); await wait(300);
    expect(turns(c).map((p) => `${p.model}/${p.effort}/${p.threadId}`)).toEqual(['gpt-6-luna/medium/t1', 'gpt-6-sol/high/t1']);
    const out = t.text();
    expect(out).toMatch(/↪ Switching model\n\s+GPT-6 Luna → GPT-6 Sol\n/);
    expect(out).toContain('Reason: tests still failing after previous stage');
    expect(out).toContain('Strategy: Adaptive · Stages: 2 · Models: GPT-6 Luna → GPT-6 Sol · Switches: 1 · Escalations: 1 · Tokens: in 28,000 (cached 22,000) out 420');
    expect(out.match(/Completed in/g)).toHaveLength(1);
    t.input.end(); await t.done;
  });
  it('a long main thread makes the extra stage run on a fresh ephemeral thread; its result is carried into the next user turn', async () => {
    const c = new FakeClient();
    let n = 0;
    c.onTurn = async (threadId) => {
      n++;
      complete(c, threadId, n === 1 ? [{ type: 'fileChange', changes: [{ path: 'csv.ts' }], status: 'completed' }, testRun(1)] : [testRun(0)], n === 1 ? { totalTokens: 90000, inputTokens: 89000, cachedInputTokens: 80000, outputTokens: 1000 } : undefined);
    };
    const t = setup(c);
    t.input.write('Add CSV export with tests\n'); await wait(300);
    const ts = turns(c);
    expect(ts.map((p) => p.threadId)).toEqual(['t1', 'iso-1']);
    expect(c.requests.find((r) => r.method === 'thread/start' && r.params.ephemeral)?.params).toMatchObject({ cwd: '/w', ephemeral: true, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    expect(ts[1].input[0].text).toContain('User request:\nAdd CSV export with tests');
    expect(t.text()).toContain('fresh thread');
    t.input.write('what changed?\n'); await wait();
    expect(turns(c)[2].threadId).toBe('t1');
    expect(turns(c)[2].input[0].text).toMatch(/^\[Lumina context: .*csv\.ts.*\]\n\nwhat changed\?$/s);
    t.input.end(); await t.done;
  });
  it('approvals keep working inside an isolated stage', async () => {
    const c = new FakeClient();
    let n = 0;
    const decisions: unknown[] = [];
    c.onTurn = async (threadId) => {
      n++;
      if (n === 2) decisions.push(await c.serverHandler!('item/commandExecution/requestApproval', { threadId, command: 'npm install', cwd: '/w' }));
      complete(c, threadId, [testRun(n === 1 ? 1 : 0)], n === 1 ? { totalTokens: 90000, inputTokens: 90000, cachedInputTokens: 0, outputTokens: 0 } : undefined);
    };
    const t = setup(c);
    t.input.write('Add CSV export with tests\n'); await wait(250);
    expect(t.text()).toContain('Approval Required');
    t.input.write('y\n'); await wait(200);
    expect(decisions).toEqual([{ decision: 'accept' }]);
    expect(turns(c)[1].threadId).toBe('iso-1');
    t.input.end(); await t.done;
  });
  it('simple prompts never add stages; a pinned /model uses plain single turns', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('update the button text\n'); await wait();
    t.input.write('/model gpt-6-sol\n'); await wait(60);
    t.input.write('Add CSV export with tests\n'); await wait();
    expect(turns(c).map((p) => p.model)).toEqual(['gpt-6-luna', 'gpt-6-sol']);
    t.input.end(); await t.done;
  });
  it('the status bar shows the model of the running stage (TTY); Ctrl-C cancels without starting more stages', async () => {
    const c = new FakeClient();
    let n = 0;
    c.onTurn = async (threadId) => { n++; if (n === 2) await new Promise(() => undefined); complete(c, threadId, [testRun(1)]); };
    const t = setup(c, true);
    t.input.write('Add CSV export with tests\r'); await wait(300);
    expect(t.screen().at(-1)).toBe('  ◉ Auto Routing · GPT-6 Sol · High');
    expect(t.screen().join('\n')).toMatch(/[◐◓◑◒] 2\/2 GPT-6 Sol · /);
    t.input.write('\x03'); await wait(200);
    expect(turns(c)).toHaveLength(2);
    expect(c.interrupted).toHaveLength(1);
    expect(t.screen().join('\n')).toContain('! Cancelled after');
    t.input.write('\x03'); expect(await t.done).toBe(130);
  });
});

describe('slash-command palette (TTY)', () => {
  const setup = (client: FakeClient, columns = 90, rows = 30) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns, rows, isTTY: true }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, output, done: runTui(client, '/w', { input, output }, { router }), screen: () => emulate(text), text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const region = (t: { screen(): string[] }) => { const s = t.screen(); const i = s.lastIndexOf('  Commands'); return i < 0 ? [] : s.slice(i); };
  const inputRow = (t: { screen(): string[] }) => t.screen().filter((r) => r.startsWith('› ')).at(-1);
  const quit = async (t: { input: PassThrough; done: Promise<number> }) => { t.input.write('\x03'); t.input.write('\x04'); await t.done; };

  it('typing "/" opens the palette above the input with all commands; the input stays visible', async () => {
    const t = setup(new FakeClient());
    t.input.write('/'); await wait();
    const s = t.screen();
    expect(s).toContain('  Commands');
    expect(s.find((r) => r.startsWith('  ❯ /resume'))).toBeTruthy();
    expect(s.some((r) => r.trimStart().startsWith('/model'))).toBe(true);
    expect(s).toContain('  ↑↓ Navigate · Tab/Enter Select · Esc Close');
    expect(s.indexOf('  Commands')).toBeLessThan(s.lastIndexOf('› /'));
    expect(inputRow(t)).toBe('› /');
    await quit(t);
  });
  it('/res filters; Enter fills "/resume " without executing; a second Enter executes', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/res'); await wait();
    expect(t.screen().filter((r) => /^ {2}[❯ ] \//.test(r)).map((r) => /\/\w+/.exec(r)![0])).toEqual(['/resume']);
    t.input.write('\r'); await wait();
    expect(inputRow(t)).toBe('› /resume');
    expect(c.requests.some((r) => r.method === 'thread/list')).toBe(false); // not executed
    expect(t.screen()).not.toContain('  Commands');
    t.input.write('\r'); await wait();
    expect(c.requests.some((r) => r.method === 'thread/list')).toBe(true); // executed
    expect(t.screen().join('\n')).toContain('Resume a conversation'); // the interactive picker opened
    expect(t.screen().join('\n')).toContain('earlier chat');
    t.input.write('\x1b'); await wait();
    await quit(t);
  });
  it('arrows navigate (with wrap), Tab completes, and arguments can be typed after completion', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/'); await wait();
    t.input.write('\x1b[B'); await wait();
    expect(t.screen().find((r) => r.includes('❯'))).toMatch(/\/model/);
    t.input.write('\x1b[A'); t.input.write('\x1b[A'); await wait();
    expect(t.screen().find((r) => r.includes('❯'))).toMatch(/\/exit/); // wrapped to the last command
    t.input.write('\x15/rea'); await wait();
    t.input.write('\t'); await wait();
    expect(inputRow(t)).toBe('› /reasoning');
    t.input.write('low'); await wait();
    t.input.write('\r'); await wait();
    expect(t.screen().join('\n')).toContain('reasoning: low');
    await quit(t);
  });
  it('Escape closes and keeps the text; Backspace/typing update the matches; no matches is explicit', async () => {
    const t = setup(new FakeClient());
    t.input.write('/mo'); await wait();
    t.input.write('\x1b'); await wait();
    expect(t.screen()).not.toContain('  Commands');
    expect(inputRow(t)).toBe('› /mo');
    t.input.write('\x7f'); await wait(); // "/m" → reopens with updated matches
    expect(t.screen()).toContain('  Commands');
    expect(t.screen().find((r) => r.includes('❯'))).toMatch(/\/model/);
    t.input.write('zzz'); await wait();
    expect(t.screen()).toContain('  No matching commands');
    t.input.write('\r'); await wait(); // unknown command executes the normal "unknown" path
    expect(t.screen().join('\n')).toContain('unknown command /mzzz');
    await quit(t);
  });
  it('/help lists the registry; existing commands still execute when typed fully', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('/help\r'); await wait();
    expect(t.screen().join('\n')).toMatch(/\/usage\s+View token usage and plan limits/);
    t.input.write('/approval smart\r'); await wait();
    expect(t.screen().join('\n')).toContain('approval mode: smart');
    t.input.write('/usage\r'); await wait(80);
    expect(t.screen().join('\n')).toContain('Codex usage');
    await quit(t);
  });
  it('arrow keys keep their normal meaning when the palette is closed (multi-line cursor movement)', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('first line'); t.input.write('\x1b[13;2u'); t.input.write('second'); await wait();
    t.input.write('\x1b[A'); t.input.write('X'); await wait(); // up moves into line 1
    expect(t.screen().join('\n')).toContain('› first Xline');
    expect(t.screen()).not.toContain('  Commands');
    await quit(t);
  });
  it('"/" inside prompt text, multi-line drafts or pasted text does not open the palette; prompts still submit', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('look at src/app.ts and /api'); await wait();
    expect(t.screen()).not.toContain('  Commands');
    t.input.write('\r'); await wait(80);
    expect(c.turns).toBe(1);
    t.input.write('\x1b[200~/model\nexplain this\x1b[201~'); await wait();
    expect(t.screen()).not.toContain('  Commands'); // multi-line paste: not a command
    t.input.write('\x03');
    t.input.write('/mod'); await wait(); // typed in one chunk (rapid typing)
    expect(t.screen().find((r) => r.includes('❯'))).toMatch(/\/model/);
    await quit(t);
  });
  it('narrow and short terminals: rows fit, fewer suggestions shown, selection stays visible; resize repaints', async () => {
    const t = setup(new FakeClient(), 30, 15);
    t.input.write('/'); await wait();
    let s = region(t);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((r) => r.length <= 30)).toBe(true);
    expect(s.filter((r) => /^ {2}[❯ ] \//.test(r)).length).toBeLessThanOrEqual(3);
    for (let i = 0; i < 6; i++) t.input.write('\x1b[B');
    await wait();
    expect(t.screen().find((r) => r.includes('❯'))).toMatch(new RegExp(COMMANDS[6].name));
    (t.output as unknown as { columns: number; rows: number }).columns = 80;
    (t.output as unknown as { rows: number }).rows = 40;
    t.output.emit('resize'); await wait();
    s = t.screen();
    expect(s.filter((r) => /^ {2}[❯ ] \//.test(r)).length).toBe(Math.min(8, COMMANDS.length)); // taller terminal: up to 8
    await quit(t);
  });
});

describe('readability: markdown, wrapping, spacing, approval block (TTY)', () => {
  const setup = (client: FakeClient, columns = 60) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns, rows: 40, isTTY: true }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, done: runTui(client, '/w', { input, output }, { router }), screen: () => emulate(text), text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const quit = async (t: { input: PassThrough; done: Promise<number> }) => { t.input.write('\x03'); t.input.write('\x04'); await t.done; };

  it('assistant markdown is rendered and long lines wrap inside the indent (no text at column 0)', async () => {
    const c = new FakeClient();
    c.reply = () => ['Implementasi selesai.\n\n- **Privasi:** log tidak merekam body, kredensial, token, cookie, atau error upstream mentah. Lihat [logging.md](/Users/x/docs/logging.md).\n'];
    const t = setup(c);
    t.input.write('go\r'); await wait();
    const rows = t.screen();
    const i = rows.findIndex((r) => r.includes('Privasi'));
    expect(rows[i]).toMatch(/^ {2}• Privasi: log tidak merekam/);
    expect(rows[i + 1].startsWith('    ')).toBe(true); // hanging indent under the bullet text
    expect(rows.join('\n')).not.toContain('**');
    expect(rows.join('\n')).toContain('Lihat logging.md');
    expect(rows.every((r) => r.length <= 60)).toBe(true);
    expect(t.text()).toContain('\x1b[1mPrivasi:\x1b[22m');
    await quit(t);
  });
  it('approval block: reason, unwrapped command, ~ path, blank lines around, then the answer text as its own paragraph', async () => {
    const c = new FakeClient();
    c.onTurn = async (threadId) => {
      await c.serverHandler!('item/commandExecution/requestApproval', { threadId, command: "/bin/zsh -lc 'gofmt -w test/sso/handler/logging_test.go && go test ./test/sso/handler ./test/config'", cwd: `${os.homedir()}/Documents/project/enhart/backend`, reason: 'Boleh jalankan tes SSO/config setelah menyesuaikan ekspektasi respons handler?' });
      c.emit('item/agentMessage/delta', { threadId, delta: 'Saya lanjut dari implementasi yang sudah ada.\n' });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const t = setup(c, 100);
    t.input.write('go\r'); await wait(150);
    let rows = t.screen();
    const a = rows.findIndex((r) => r.includes('Approval Required'));
    expect(['', '◆ Lumina']).toContain(rows[a - 1]); // a blank line before it, unless it opens the reply
    expect(rows[a + 1]).toBe('  Boleh jalankan tes SSO/config setelah menyesuaikan ekspektasi respons handler?');
    expect(rows.slice(a + 2, a + 6)).toEqual(['', '  Command:', '    gofmt -w test/sso/handler/logging_test.go && go test ./test/sso/handler ./test/config', '    in ~/Documents/project/enhart/backend']);
    expect(rows.join('\n')).not.toContain('/bin/zsh -lc');
    t.input.write('y\r'); await wait(150);
    rows = t.screen();
    const o = rows.findIndex((r) => r.includes('[y] Approve once'));
    expect(rows[o + 1]).toBe(''); // the answer starts a new paragraph
    expect(rows[o + 2]).toBe('  Saya lanjut dari implementasi yang sudah ada.');
    await quit(t);
  });
});

describe('code blocks: copyable output and /copy', () => {
  const setup = (client: FakeClient, copied: string[], tty = true) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 50, rows: 40, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    const clipboard = async (x: string) => { copied.push(x); return 'clipboard'; };
    return { input, done: runTui(client, '/w', { input, output }, { router, clipboard }), screen: () => emulate(text), text: () => text };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const LONG = `git commit -m "${'x'.repeat(80)}"`;
  const reply = ['Pakai pesan ini:\n\n```text\nfix(logging): redact startup config values\n```\n\nAtau:\n\n```bash\n', `${LONG}\n`, '  indented line\n```\n'];

  it('code lines are printed flush-left, exactly as written (no indent, no hard wrap), with a /copy header', async () => {
    const c = new FakeClient();
    c.reply = () => reply;
    const t = setup(c, []);
    t.input.write('give me a commit message\r'); await wait();
    const rows = t.screen();
    expect(rows).toContain('  text · /copy 1');
    expect(rows).toContain('fix(logging): redact startup config values'); // column 0: selecting it copies nothing extra
    expect(rows).toContain(LONG); // longer than the terminal, still one line (the terminal wraps it, copy stays intact)
    expect(rows).toContain('  indented line');
    expect(rows.join('\n')).not.toContain('```');
    expect(rows).toContain('  bash · /copy 2');
    t.input.write('\x03'); t.input.write('\x04'); await t.done;
  });
  it('/copy copies the last block, /copy N a specific one, /copy all the whole answer; errors are explained', async () => {
    const c = new FakeClient();
    c.reply = () => reply;
    const copied: string[] = [];
    const t = setup(c, copied);
    t.input.write('/copy\r'); await wait();
    expect(t.screen().join('\n')).toContain('no code blocks yet');
    t.input.write('give me a commit message\r'); await wait();
    t.input.write('/copy\r'); await wait();
    t.input.write('/copy 1\r'); await wait();
    t.input.write('/copy all\r'); await wait();
    t.input.write('/copy 9\r'); await wait();
    expect(copied).toEqual([`${LONG}\n  indented line`, 'fix(logging): redact startup config values', reply.join('').trim()]);
    const out = t.screen().join('\n');
    expect(out).toContain('✓ copied code block 2 (2 lines) to the clipboard');
    expect(out).toContain('✓ copied code block 1 (1 line) to the clipboard');
    expect(out).toContain('no code block 9; there are 2');
    t.input.write('\x03'); t.input.write('\x04'); await t.done;
  });
  it('/copy all works without a TTY (plain output keeps raw Markdown)', async () => {
    const c = new FakeClient();
    c.reply = () => reply;
    const copied: string[] = [];
    const t = setup(c, copied, false);
    t.input.write('hi\n'); await wait();
    t.input.write('/copy all\n'); await wait();
    expect(copied).toEqual([reply.join('').trim()]);
    expect(t.text()).toContain('```text');
    t.input.end(); await t.done;
  });
  it('real Codex delta stream (fence split across deltas, no trailing newline) yields exactly one block', async () => {
    const c = new FakeClient();
    c.reply = () => ['```', 'text', '\n', 'fix', ':', ' redact', ' startup', ' config', ' values', '\n', '```'];
    const copied: string[] = [];
    const t = setup(c, copied);
    t.input.write('msg\r'); await wait();
    const out = t.screen().join('\n');
    expect(out).toContain('text · /copy 1');
    expect(out).not.toContain('/copy 2');
    t.input.write('/copy\r'); await wait();
    expect(copied).toEqual(['fix: redact startup config values']);
    t.input.write('\x03'); t.input.write('\x04'); await t.done;
  });
});

describe('Tab queue and image paste (TTY)', () => {
  const setup = (client: FakeClient, extra: Record<string, unknown> = {}) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 90, rows: 40, isTTY: true }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, done: runTui(client, '/w', { input, output }, { router, ...extra }), screen: () => emulate(text) };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const turns = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input as { type: string; text?: string; path?: string }[]);
  const gated = (c: FakeClient) => {
    const releases: (() => void)[] = [];
    c.onTurn = async (threadId) => { await new Promise<void>((r) => releases.push(r)); c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } }); };
    return () => releases.shift()?.();
  };
  const quit = async (t: { input: PassThrough; done: Promise<number> }) => { t.input.write('\x03'); t.input.write('\x04'); await t.done; };

  it('Tab while a turn runs queues the prompt; queued prompts run in order when the turn ends', async () => {
    const c = new FakeClient();
    const release = gated(c);
    const t = setup(c);
    t.input.write('first\r'); await wait();
    t.input.write('second'); t.input.write('\t'); await wait();
    t.input.write('third\nline'); await wait(); t.input.write('\t'); await wait();
    let s = t.screen();
    expect(s).toContain('  Queued (2) · runs after the current turn · Ctrl-C clears');
    expect(s).toContain('  1. second');
    expect(s).toContain('  2. third …'); // multi-line prompt: first line + …
    expect(s.join('\n')).toContain('› Ask Lumina anything...'); // the input is free again
    expect(turns(c)).toHaveLength(1);
    release(); await wait(100);
    expect(turns(c).map((x) => x[0].text)).toEqual(['first', 'second']);
    expect(t.screen()).toContain('  Queued (1) · runs after the current turn · Ctrl-C clears');
    release(); await wait(100);
    expect(turns(c).map((x) => x[0].text)).toEqual(['first', 'second', 'third\nline']); // multi-line kept intact
    release(); await wait(100);
    s = t.screen();
    expect(s.join('\n')).not.toContain('Queued');
    expect(s.filter((r) => r.startsWith('› second'))).toHaveLength(1); // echoed once, like a typed prompt
    await quit(t);
  });
  it('Tab when idle simply sends; Tab on an empty input does nothing; queued slash commands run too', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('\t'); await wait();
    expect(turns(c)).toHaveLength(0);
    t.input.write('hello'); t.input.write('\t'); await wait(100);
    expect(turns(c).map((x) => x[0].text)).toEqual(['hello']);
    const release = gated(c);
    t.input.write('again\r'); await wait();
    t.input.write('/approval status'); t.input.write('\x1b'); t.input.write('\t'); await wait(); // Esc closes the palette, Tab queues
    release(); await wait(150);
    expect(t.screen().join('\n')).toContain('approval mode: manual');
    await quit(t);
  });
  it('Ctrl-C cancels the running turn and clears the queue', async () => {
    const c = new FakeClient();
    gated(c);
    const t = setup(c);
    t.input.write('long\r'); await wait();
    t.input.write('queued one'); t.input.write('\t'); await wait();
    t.input.write('\x03'); await wait(100);
    expect(t.screen().join('\n')).toContain('queue cleared (1)');
    expect(t.screen().join('\n')).not.toContain('Queued (');
    t.input.write('\x03'); expect(await t.done).toBe(130);
  });
  it('Ctrl+V pastes a clipboard image as an [Image #n] token; it is sent as a native localImage item', async () => {
    const c = new FakeClient();
    let n = 0;
    const t = setup(c, { readImage: async () => `/tmp/lumina-images/shot-${++n}.png` });
    t.input.write('what is in'); t.input.write('\x16'); await wait();
    expect(t.screen().join('\n')).toContain('› what is in [Image #1]');
    t.input.write('and'); t.input.write('\x16'); await wait();
    t.input.write('?\r'); await wait(100);
    expect(turns(c)[0]).toEqual([
      { type: 'text', text: 'what is in [Image #1] and [Image #2] ?', text_elements: [] },
      { type: 'localImage', path: '/tmp/lumina-images/shot-1.png' },
      { type: 'localImage', path: '/tmp/lumina-images/shot-2.png' },
    ]);
    expect(t.screen().join('\n')).toContain('images: 2 attached');
    await quit(t);
  });
  it('deleting the token drops the image; no image in the clipboard is explained; pasted image paths attach', async () => {
    const c = new FakeClient();
    const img = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-')), 'diagram.png');
    fs.writeFileSync(img, Buffer.from('89504e47', 'hex'));
    let has = true;
    const t = setup(c, { readImage: async () => (has ? '/tmp/x.png' : undefined) });
    t.input.write('\x16'); await wait();
    t.input.write('\x15'); t.input.write('no picture\r'); await wait(100); // Ctrl-U removed the token
    expect(turns(c)[0]).toHaveLength(1);
    has = false;
    t.input.write('\x16'); await wait();
    expect(t.screen().join('\n')).toContain('no image in the clipboard');
    t.input.write(`\x1b[200~${img}\x1b[201~`); await wait(); // dragging a file into the terminal pastes its path
    expect(t.screen().join('\n')).toMatch(/› \[Image #2\]/);
    t.input.write('explain\r'); await wait(100);
    expect(turns(c)[1].filter((x) => x.type === 'localImage')).toEqual([{ type: 'localImage', path: img }]);
    t.input.write('\x1b[200~/etc/hosts\x1b[201~'); await wait(); // not an image: ordinary text
    expect(t.screen().join('\n')).toContain('› /etc/hosts');
    await quit(t);
  });
});

describe('ticket workflow: understand → clarify → implement', () => {
  const STAGED = ConfigSchema.parse({});
  const setup = (client: FakeClient, tty = false) => {
    const router = new TurnRouter(STAGED, '/nonexistent', [...CAT, { slug: 'gpt-6-astra', name: 'GPT-6 Astra', efforts: ['low', 'medium', 'high'] }]);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, done: runTui(client, '/w', { input, output }, { router }), text: () => text, screen: () => emulate(text) };
  };
  const wait = (ms = 120) => new Promise((r) => setTimeout(r, ms));
  const turns = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params);
  const answerWith = (c: FakeClient, answers: { text: string; tool?: string; edit?: boolean }[]) => {
    let n = 0;
    c.onTurn = async (threadId) => {
      const a = answers[Math.min(n++, answers.length - 1)];
      if (a.tool) c.emit('item/completed', { threadId, item: { type: 'mcpToolCall', tool: a.tool, status: 'completed' } });
      if (a.edit) c.emit('item/completed', { threadId, item: { type: 'fileChange', changes: [{ path: 'src/hu.ts' }], status: 'completed' } });
      c.emit('item/agentMessage/delta', { threadId, delta: `${a.text}\n` });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
  };

  it('OpenProject: explain (read-only, light model, fetch once) → correction (read-only, kept) → "okay, implement it" (re-routed, writable, clarifications applied)', async () => {
    const c = new FakeClient();
    answerWith(c, [
      { text: 'OP-559 asks to move a handling unit (HU) between bays. Ambiguous: what happens on cancel?', tool: 'get_openproject_work_package' },
      { text: 'Updated: on cancel the HU returns to its previous bay.' },
      { text: 'Implemented.', edit: true },
    ]);
    const t = setup(c);
    t.input.write('Check OP-559 and explain what you understand.\n'); await wait();
    let ts = turns(c);
    expect(ts[0]).toMatchObject({ model: 'gpt-6-luna', effort: 'medium', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    expect(ts[0].input[0].text).toContain('Fetch OpenProject work package 559 once with the lumina-mcp tool get_openproject_work_package');
    expect(ts[0].input[0].text).toContain('Do not modify any files');
    expect(t.text()).toContain('Ticket: OP-559 · Mode: Understanding · Model: GPT-6 Luna · Reasoning: Medium · read-only');
    expect(c.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1); // no extra stages

    t.input.write('Correct, but the HU must return to its previous bay.\n'); await wait();
    ts = turns(c);
    expect(ts[1].sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    expect(ts[1].input[0].text).toContain('already in this conversation; do not fetch it again'); // fetched once
    expect(ts[1].input[0].text).toContain('Do not start implementing');
    expect(t.text()).toContain('Ticket: OP-559 · Mode: Ready for implementation · Requirements: updated (1 clarification)');
    expect(t.text().split('\n').find((l) => l.includes('Ready for implementation'))!.startsWith('Ticket: OP-559')).toBe(true); // own line, after the answer
    expect(t.text().indexOf('Ready for implementation')).toBeGreaterThan(t.text().indexOf('Updated: on cancel'));

    t.input.write('Okay, implement it.\n'); await wait(200);
    ts = turns(c);
    expect(ts).toHaveLength(3);
    expect(ts[2].sandboxPolicy).toEqual({ type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }); // writable again
    expect(ts[2].input[0].text).toContain('implement OP-559 now using the confirmed requirements');
    expect(ts[2].input[0].text).toContain('1. Correct, but the HU must return to its previous bay.');
    expect(t.text()).toMatch(/Ticket: OP-559 · Mode: Implementing · Model: GPT-6 \w+ · Reasoning: \w+ · 1 clarification\(s\) applied/);
    t.input.end(); await t.done;
  });

  it('a pasted ticket: understanding uses the cheap model at low effort when short, never writes', async () => {
    const c = new FakeClient();
    answerWith(c, [{ text: 'The ticket asks to swap the order list endpoint.' }]);
    const t = setup(c, true);
    const ticketText = `Jelaskan tiket ini dulu ya\n\nTiket: ORD-482 Migrate order list to v2\nDescription:\nThe order list page calls GET /api/v1/orders and must call /api/v2/orders with cursor pagination.\nAuthentication now needs a Bearer JWT; refunds require admin role; database migration later.\n${'More background about payments and security. '.repeat(8)}`;
    t.input.write(`\x1b[200~${ticketText}\x1b[201~`); t.input.write('\r'); await wait();
    const ts = turns(c);
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ model: 'gpt-6-luna', effort: 'low', sandboxPolicy: { type: 'readOnly', networkAccess: false } });
    expect(ts[0].input[0].text).toContain('The ticket text is the one I pasted');
    t.input.write('\x03'); t.input.write('\x04'); await t.done;
  });

  it('an explicit implementation request goes straight to work (no confirmation step, not read-only)', async () => {
    const c = new FakeClient();
    answerWith(c, [{ text: 'Done.', edit: true }]);
    const t = setup(c);
    t.input.write('Kerjakan OP-560 sekarang\n'); await wait();
    const ts = turns(c);
    expect(ts).toHaveLength(1);
    expect(ts[0].sandboxPolicy).toBeUndefined();
    expect(ts[0].input[0].text).toBe('Kerjakan OP-560 sekarang');
    expect(t.text()).toContain('Ticket: OP-560 · Mode: Implementing');
    t.input.end(); await t.done;
  });

  it('questions during the discussion stay read-only; /new ends the ticket context; normal prompts are unaffected', async () => {
    const c = new FakeClient();
    answerWith(c, [{ text: 'Explanation.', tool: 'get_openproject_work_package' }, { text: 'Files: src/hu.ts' }, { text: 'ok' }]);
    const t = setup(c);
    t.input.write('Jelaskan OP-559\n'); await wait();
    t.input.write('file apa saja yang terdampak?\n'); await wait();
    expect(turns(c)[1].sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    t.input.write('/new\n'); await wait(60);
    t.input.write('update the button text\n'); await wait();
    expect(turns(c)[2].sandboxPolicy).toBeUndefined();
    expect(turns(c)[2].input[0].text).toBe('update the button text');
    t.input.end(); await t.done;
  });

  it('the status bar shows the ticket state (TTY)', async () => {
    const c = new FakeClient();
    answerWith(c, [{ text: 'Explanation.', tool: 'get_openproject_work_package' }, { text: 'Updated.' }]);
    const t = setup(c, true);
    t.input.write('Check OP-559 and explain what you understand.\r'); await wait();
    expect(t.screen().at(-1)).toMatch(/· OP-559: Understanding$/);
    t.input.write('Yes, but also log the move.\r'); await wait();
    expect(t.screen().at(-1)).toMatch(/· OP-559: Ready$/);
    t.input.write('\x03'); t.input.write('\x04'); await t.done;
  });
});

describe('/resume picker (TTY)', () => {
  const NOW = Math.floor(Date.now() / 1000);
  const setup = (client: FakeClient, rows = 30) => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 90, rows, isTTY: true }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (d) => { text += d.toString(); });
    return { input, done: runTui(client, '/w', { input, output }, { router }), screen: () => emulate(text) };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const quit = async (t: { input: PassThrough; done: Promise<number> }) => { t.input.write('\x03'); t.input.write('\x04'); await t.done; };
  const threads = [
    { id: 'aaaaaaaa-1', name: null, preview: 'Fix login button\nmore text', updatedAt: NOW - 3 * 3600 },
    { id: 'bbbbbbbb-2', name: 'Order list v2 endpoint', preview: 'ganti endpoint', updatedAt: NOW - 120 },
    { id: 'cccccccc-3', name: null, preview: '', updatedAt: NOW - 3 * 86400 },
  ];
  const opened = (t: { screen(): string[] }) => t.screen().filter((r) => /^ {2}[❯ ] /.test(r));

  it('lists real Codex threads newest first with title and last activity; ids only when needed; metadata-only request', async () => {
    const c = new FakeClient();
    c.listPage = () => ({ data: threads, nextCursor: null });
    const t = setup(c);
    t.input.write('/resume\r'); await wait();
    const rows = opened(t);
    expect(rows[0]).toMatch(/^ {2}❯ Order list v2 endpoint\s+2m ago$/);
    expect(rows[1]).toMatch(/^ {4}Fix login button\s+3h ago$/);
    expect(rows[2]).toMatch(/^ {4}\(untitled conversation\)\s+3d ago$/);
    expect(t.screen().join('\n')).not.toContain('aaaaaaaa');
    const req = c.requests.find((r) => r.method === 'thread/list')!.params;
    expect(req).toMatchObject({ cwd: '/w', sortKey: 'updated_at', limit: 50 });
    expect(c.requests.some((r) => r.method === 'thread/read')).toBe(false); // no histories loaded for the picker
    await quit(t);
  });
  it('↑↓ + Enter resumes the chosen conversation and shows it; typing filters by title', async () => {
    const c = new FakeClient();
    c.listPage = () => ({ data: threads, nextCursor: null });
    const t = setup(c);
    t.input.write('/resume\r'); await wait();
    t.input.write('\x1b[B'); await wait(20);
    expect(opened(t).find((r) => r.includes('❯'))).toContain('Fix login button');
    t.input.write('order'); await wait(20);
    expect(opened(t)).toHaveLength(1);
    expect(t.screen().join('\n')).toContain('filter: order');
    t.input.write('\r'); await wait(100);
    expect(c.requests.find((r) => r.method === 'thread/resume')!.params.threadId).toBe('bbbbbbbb-2');
    const s = t.screen().join('\n');
    expect(s).toContain('resumed bbbbbbbb');
    expect(s).toContain('end of previous conversation'); // history displayed
    expect(s).not.toContain('Resume a conversation');
    t.input.write('continue\r'); await wait(100);
    expect(c.requests.filter((r) => r.method === 'turn/start').at(-1)!.params.threadId).toBe('bbbbbbbb-2'); // context preserved
    await quit(t);
  });
  it('Esc cancels without changing the conversation; empty list has a helpful message', async () => {
    const c = new FakeClient();
    c.listPage = () => ({ data: [], nextCursor: null });
    const t = setup(c);
    t.input.write('/resume\r'); await wait();
    expect(t.screen().join('\n')).toContain('No saved conversations in this directory yet');
    t.input.write('\x1b'); await wait();
    expect(t.screen().join('\n')).toContain('resume cancelled');
    expect(c.requests.some((r) => r.method === 'thread/resume')).toBe(false);
    expect(t.screen().join('\n')).not.toContain('Resume a conversation');
    await quit(t);
  });
  it('a deleted/unavailable conversation is reported and the current one stays active', async () => {
    const c = new FakeClient();
    c.listPage = () => ({ data: threads, nextCursor: null });
    c.missing = ['bbbbbbbb-2'];
    const t = setup(c);
    t.input.write('hello\r'); await wait(100);
    t.input.write('/resume\r'); await wait();
    t.input.write('\r'); await wait(100);
    expect(t.screen().join('\n')).toMatch(/could not resume bbbbbbbb: thread not found[\s\S]*current conversation is unchanged/);
    t.input.write('next\r'); await wait(100);
    expect(c.requests.filter((r) => r.method === 'turn/start').at(-1)!.params.threadId).toBe('t1');
    await quit(t);
  });
  it('large lists load page by page as you scroll, and a filter keeps paging until something matches', async () => {
    const c = new FakeClient();
    const all = Array.from({ length: 130 }, (_, i) => ({ id: `id${String(i).padStart(4, '0')}-x`, name: `conversation ${i}${i === 120 ? ' needle' : ''}`, preview: '', updatedAt: NOW - i * 60 }));
    c.listPage = (p) => { const from = Number(p.cursor ?? 0); return { data: all.slice(from, from + 50), nextCursor: from + 50 < all.length ? String(from + 50) : null }; };
    const t = setup(c, 20);
    t.input.write('/resume\r'); await wait();
    expect(c.requests.filter((r) => r.method === 'thread/list')).toHaveLength(1);
    expect(t.screen().join('\n')).toContain('1/50+');
    for (let i = 0; i < 48; i++) t.input.write('\x1b[B');
    await wait(100);
    expect(c.requests.filter((r) => r.method === 'thread/list').map((r) => r.params.cursor ?? null)).toEqual([null, '50']);
    t.input.write('needle'); await wait(150);
    expect(c.requests.filter((r) => r.method === 'thread/list').map((r) => r.params.cursor ?? null)).toEqual([null, '50', '100']);
    expect(opened(t)).toHaveLength(1);
    expect(opened(t)[0]).toContain('conversation 120 needle');
    expect(t.screen().every((r) => r.length <= 90)).toBe(true);
    await quit(t);
  });
});

describe('/diff viewer (TTY)', () => {
  it('lists changes, opens a file diff, scrolls, goes back and closes — without touching the repo', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tdiff-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(d, 'app.ts'), Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'));
    g('add', '-A'); g('commit', '-qm', 'init');
    fs.writeFileSync(path.join(d, 'app.ts'), Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? `changed ${i}` : `line ${i}`)).join('\n'));
    fs.writeFileSync(path.join(d, 'new.md'), 'hi\n');
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' });
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: true }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const done = runTui(new FakeClient(), d, { input, output }, { router });
    const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
    const screen = () => emulate(text).join('\n');
    input.write('/diff\r'); await wait(200);
    expect(screen()).toContain('Changes · 2 files · +13 −12 · read-only');
    expect(screen()).toMatch(/❯ M app\.ts\s+\+12 −12/);
    expect(screen()).toMatch(/\? new\.md\s+\+1/);
    input.write('\r'); await wait(200);
    expect(screen()).toMatch(/M app\.ts · unstaged · \+12 −12 · 1–15\/\d+/);
    expect(text).toContain('\x1b[31m-line 0\x1b[39m');
    expect(text).toContain('\x1b[32m+changed 0\x1b[39m');
    input.write('\x1b[6~'); await wait();
    expect(screen()).toMatch(/· 15–29\/\d+/);
    input.write('\x1b'); await wait();
    expect(screen()).toContain('Changes · 2 files');
    input.write('\x1b'); await wait();
    expect(emulate(text).slice(-4)[1]).toBe('› Ask Lumina anything...');
    expect(emulate(text).join('\n')).not.toMatch(/Changes · 2 files[\s\S]*› Ask Lumina anything/);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' })).toBe(before); // read-only
    input.write('\x03'); input.write('\x04'); await done;
  });
  it('outside a git repository /diff explains the problem', async () => {
    const router = new TurnRouter(LEGACY, '/nonexistent', CAT);
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 80, rows: 24, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const done = runTui(new FakeClient(), fs.mkdtempSync(path.join(os.tmpdir(), 'lum-nogit-')), { input, output }, { router });
    input.write('/diff\n'); await new Promise((r) => setTimeout(r, 150));
    expect(text).toMatch(/\/diff: not a git repository/);
    input.end(); await done;
  });
});

describe('checkpoints and /rollback', () => {
  const repo = () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tcp-')));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'pipe' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(d, 'app.ts'), 'v1\n');
    g('add', '-A'); g('commit', '-qm', 'init');
    fs.writeFileSync(path.join(d, 'notes.md'), 'my own work\n'); // pre-existing user change
    return d;
  };
  const run = (d: string, tty: boolean, opts: Record<string, unknown> = {}) => {
    // the "agent" edits a file and creates one during its turn
    const c = new FakeClient((t) => { if (!t.startsWith('explain')) { fs.writeFileSync(path.join(d, 'app.ts'), 'v2\n'); fs.writeFileSync(path.join(d, 'gen.ts'), 'x\n'); } return ['done']; });
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: tty }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const done = runTui(c, d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT), ...opts });
    return { input, done, text: () => text, screen: () => emulate(text).join('\n') };
  };
  const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  const read = (d: string, f: string) => (fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), 'utf8') : null);

  it('a turn records a checkpoint; /checkpoints lists it; /rollback shows the plan, n cancels, y restores only Lumina changes', async () => {
    const d = repo();
    const t = run(d, false);
    t.input.write('add a feature\n'); await wait(400);
    const id = /checkpoint ([a-z0-9]{12}) · 2 files changed · \/rollback to undo/.exec(t.text())?.[1];
    expect(id).toBeTruthy();
    t.input.write('/checkpoints\n'); await wait();
    expect(t.text()).toMatch(new RegExp(`${id}  .*active\\s+2 files  add a feature`));
    t.input.write(`/rollback ${id!.slice(0, 6)}\n`); await wait();
    expect(t.text()).toMatch(/restore\s+app\.ts[\s\S]*delete\s+gen\.ts[\s\S]*\[y\] Roll back {3}\[n\] Cancel/);
    expect(t.text()).not.toMatch(/notes\.md/);
    t.input.write('n\n'); await wait();
    expect(t.text()).toContain('rollback cancelled; nothing was changed');
    expect(read(d, 'app.ts')).toBe('v2\n');
    t.input.write(`/rollback ${id}\n`); await wait();
    t.input.write('y\n'); await wait();
    expect(t.text()).toContain(`✓ rolled back checkpoint ${id}: 2 files restored`);
    expect([read(d, 'app.ts'), read(d, 'gen.ts'), read(d, 'notes.md')]).toEqual(['v1\n', null, 'my own work\n']);
    t.input.write('/checkpoints\n'); await wait();
    expect(t.text()).toMatch(/rolled-back/);
    t.input.end(); await t.done;
  });
  it('a manual edit after the turn blocks the rollback (nothing written); answering anything but y/n re-asks', async () => {
    const d = repo();
    const t = run(d, false);
    t.input.write('add a feature\n'); await wait(400);
    const id = /checkpoint ([a-z0-9]{12})/.exec(t.text())![1];
    fs.writeFileSync(path.join(d, 'app.ts'), 'edited by hand\n');
    t.input.write(`/rollback ${id}\n`); await wait();
    expect(t.text()).toMatch(/✗ restore\s+app\.ts\s+\(changed after Lumina edited it[\s\S]*Rollback not possible/);
    expect([read(d, 'app.ts'), read(d, 'gen.ts')]).toEqual(['edited by hand\n', 'x\n']);
    fs.writeFileSync(path.join(d, 'app.ts'), 'v2\n'); // user puts it back: rollback is possible again
    t.input.write(`/rollback ${id}\n`); await wait();
    t.input.write('maybe\n'); await wait();
    expect(t.text()).toContain('Please answer y or n');
    fs.writeFileSync(path.join(d, 'app.ts'), 'edited during the prompt\n'); // changed between preview and confirm
    t.input.write('y\n'); await wait();
    expect(t.text()).toMatch(/✗ .*changed since/);
    expect(read(d, 'app.ts')).toBe('edited during the prompt\n');
    t.input.end(); await t.done;
  });
  it('TTY: /rollback opens a picker; Enter reviews the selected checkpoint; Esc cancels', async () => {
    const d = repo();
    const t = run(d, true);
    t.input.write('add a feature\r'); await wait(400);
    t.input.write('/rollback\r'); await wait();
    expect(t.screen()).toMatch(/Roll back a checkpoint · 1 · type to filter · ↑↓ · Enter review · Esc cancel/);
    expect(t.screen()).toMatch(/❯ add a feature · 2 files/);
    t.input.write('\r'); await wait();
    expect(t.screen()).toMatch(/Rollback checkpoint [a-z0-9]{12}[\s\S]*restore\s+app\.ts/);
    t.input.write('y\r'); await wait();
    expect(read(d, 'app.ts')).toBe('v1\n');
    t.input.write('/rollback\r'); await wait();
    expect(t.screen()).toContain('No checkpoints to roll back.');
    t.input.write('\x1b'); await wait();
    expect(t.screen()).toContain('rollback cancelled');
    t.input.write('\x03'); t.input.write('\x04'); await t.done;
  });
  it('read-only sessions record no checkpoint; outside git a turn still runs and /checkpoints explains why', async () => {
    const d = repo();
    const t = run(d, false, { policy: { approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user' } });
    t.input.write('explain this\n'); await wait(300);
    t.input.write('/checkpoints\n'); await wait();
    expect(t.text()).toContain('No checkpoints yet');
    t.input.end(); await t.done;
    const n = run(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-nogit-')), false);
    n.input.write('explain this\n'); await wait(300);
    expect(n.text()).toContain('done');
    n.input.write('/checkpoints\n'); await wait();
    expect(n.text()).toMatch(/checkpoints unavailable: not a git repository/);
    n.input.end(); await n.done;
  });
});

describe('/repo', () => {
  it('maps the repository in the background at startup and shows it; refresh re-indexes; turns are not delayed', async () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-trepo-')));
    execFileSync('git', ['init', '-q'], { cwd: d });
    fs.writeFileSync(path.join(d, 'go.mod'), 'module example.com/svc\nrequire github.com/gin-gonic/gin v1\n');
    fs.mkdirSync(path.join(d, 'cmd', 'api'), { recursive: true });
    fs.writeFileSync(path.join(d, 'cmd', 'api', 'main.go'), 'package main');
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 100, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const c = new FakeClient();
    const done = runTui(c, d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) });
    const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
    input.write('hello\n'); await wait();
    expect(text).toContain('echo:hello');
    input.write('/repo\n'); await wait();
    expect(text).toMatch(/Project: svc\nRoot: .*\nStack: Go \/ Gin\nPackage managers: Go modules\n[\s\S]*Entry Points:\n- cmd\/api\/main\.go[\s\S]*Indexed: just now · /);
    input.write('/repo refresh\n'); await wait();
    expect(text.match(/Indexed: just now · /g)).toHaveLength(2); // the startup index is reused, refresh builds anew (never "(cached)")
    input.write('/repo nope\n'); await wait(80);
    expect(text).toContain('usage: /repo [refresh]');
    input.end(); await done;
  });
});

describe('smart context in turns', () => {
  it('hints are prepended to the turn once (paths + symbols only), skipped for trivial prompts, and given again after /new', async () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tctx-')));
    execFileSync('git', ['init', '-q'], { cwd: d });
    fs.mkdirSync(path.join(d, 'src', 'services'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'services', 'orders.ts'), 'export function listOrders() {}\n');
    fs.writeFileSync(path.join(d, 'src', 'services', 'users.ts'), 'export function listUsers() {}\n');
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 100, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const c = new FakeClient();
    const done = runTui(c, d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) });
    const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
    const sent = () => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text as string);
    input.write('fix the orders sorting\n'); await wait();
    expect(sent()[0]).toMatch(/^\[Lumina context hints: [^\n]*\]\n- src\/services\/orders\.ts — listOrders \(L1\)\n\nfix the orders sorting$/);
    expect(sent()[0]).not.toContain('users');
    expect(text).toContain('context hints: 1 file');
    input.write('also fix orders paging\n'); await wait();
    expect(sent()[1]).toBe('also fix orders paging'); // nothing new to say
    input.write('thanks\n'); await wait();
    expect(sent()[2]).toBe('thanks');
    input.write('/new\n'); await wait(80);
    input.write('fix orders again\n'); await wait();
    expect(sent()[3]).toContain('- src/services/orders.ts');
    input.end(); await done;
  });
});

describe('automatic skill selection in turns', () => {
  const setup = () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 120, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const c = new FakeClient();
    const done = runTui(c, '/w', { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) });
    return { c, input, done, text: () => text };
  };
  const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));
  const items = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input.slice(1));

  it('a matching skill is attached as a native Codex skill item (Codex loads SKILL.md); /why explains; unrelated prompts attach nothing', async () => {
    const t = setup();
    t.input.write('please greet the zebra\n'); await wait();
    expect(items(t.c)[0]).toEqual([{ type: 'skill', name: 'zebra-greeting', path: '/w/.agents/skills/zebra-greeting/SKILL.md' }]);
    expect(t.text()).toContain('skills: $zebra-greeting (selected automatically · /why)');
    t.input.write('/why\n'); await wait(80);
    expect(t.text()).toMatch(/Skill: zebra-greeting \[project\]\nWhy: its name matches "zebra", "greet"\nAbout: Use when asked to greet the zebra\nRequest: "please greet the zebra"/);
    t.input.write('fix the login form validation\n'); await wait();
    expect(items(t.c)[1]).toEqual([]);
    t.input.write('/why\n'); await wait(80);
    expect(t.text()).toContain('No skill was selected for the last request');
    expect(t.c.requests.filter((r) => r.method === 'skills/list')).toHaveLength(1); // metadata cached; no model calls to choose
    t.input.end(); await t.done;
  });
  it('explicit $skill wins over automatic selection; skills/list failure falls back to no skills', async () => {
    const t = setup();
    t.input.write('$caveman greet the zebra\n'); await wait();
    expect(items(t.c)[0]).toEqual([{ type: 'skill', name: 'caveman', path: '/home/.agents/skills/caveman/SKILL.md' }]);
    t.input.write('/why\n'); await wait(80);
    expect(t.text()).toMatch(/Skills: \$caveman \[global\]\nWhy: you invoked it explicitly/);
    const orig = t.c.request;
    t.c.request = (async (m: string, p: Record<string, any>) => { if (m === 'skills/list') throw new Error('down'); return orig(m, p); }) as AppClient['request'];
    t.c.emit('skills/changed', {});
    t.input.write('please greet the zebra\n'); await wait();
    expect(items(t.c)[1]).toEqual([]);
    expect(t.text()).toContain('echo:please greet the zebra'); // the turn still ran
    t.input.end(); await t.done;
  });
});

describe('/context metrics', () => {
  const run = (d: string, cfg: Record<string, unknown> = {}) => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 120, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const c = new FakeClient();
    c.onTurn = async (threadId) => {
      c.emit('item/completed', { threadId, item: { type: 'commandExecution', command: 'sed -n 1,40p src/services/orders.ts', status: 'completed', exitCode: 0, commandActions: [{ type: 'read', command: 'sed', name: 'orders.ts', path: path.join(d, 'src/services/orders.ts') }] } });
      c.emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: 83700, inputTokens: 82500, cachedInputTokens: 70000, outputTokens: 1200 }, last: { totalTokens: 83700 }, modelContextWindow: 250000 } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const router = new TurnRouter(ConfigSchema.parse({ stages: { enabled: false }, ...cfg }), '/nonexistent', CAT);
    return { c, input, text: () => text, done: runTui(c, d, { input, output }, { router }) };
  };
  const repo = () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tmet-')));
    execFileSync('git', ['init', '-q'], { cwd: d });
    fs.mkdirSync(path.join(d, 'src', 'services'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'services', 'orders.ts'), 'export function listOrders() { /* SECRET_CODE_BODY */ }\n');
    return d;
  };
  const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

  it('collects retrieval, files read and provider-reported tokens per request; logs numbers only; /new resets', async () => {
    const d = repo();
    const log = path.join(process.env.SMART_CODEX_HOME!, 'routing.jsonl');
    const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
    const t = run(d);
    t.input.write('/context\n'); await wait(80);
    expect(t.text()).toContain('No request has finished in this session yet.');
    t.input.write('fix the orders sorting\n'); await wait();
    t.input.write('/context\n'); await wait(80);
    const out = t.text();
    expect(out).toMatch(/Indexed files: 1 · map \d+s old/);
    expect(out).toContain('Candidate files: 1 · Selected: 1');
    expect(out).toContain('Files read by Codex: 1 (1 of them hinted)');
    expect(out).toContain("Cache: file list miss · symbols 1 hit / 1 miss"); // read once, reused for the import scan
    expect(out).toContain('Input: 82,500 tokens · Cached: 70,000 · Output: 1,200');
    expect(out).not.toMatch(/^context: /m); // per-request summary is off by default
    const entries = fs.readFileSync(log, 'utf8').slice(before).trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.event === 'context_metrics');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ files_read: 1, selected_files: 1, input_tokens: 82500, usage_reported: true });
    expect(JSON.stringify(entries[0])).not.toMatch(/orders|SECRET_CODE_BODY|fix the/);
    t.input.write('/new\n'); await wait(80);
    t.input.write('/context\n'); await wait(80);
    expect(t.text().split('No request has finished').length).toBe(3);
    t.input.end(); await t.done;
  });
  it('summary line when enabled; nothing collected or logged when disabled', async () => {
    const d = repo();
    const s = run(d, { metrics: { summary: true } });
    s.input.write('fix the orders sorting\n'); await wait();
    expect(s.text()).toMatch(/context: 1 hinted · 1 read · in 82,500 \(cached 70,000\) out 1,200 · retrieval \d+ms/);
    s.input.end(); await s.done;
    const log = path.join(process.env.SMART_CODEX_HOME!, 'routing.jsonl');
    const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').length : 0;
    const t = run(repo(), { metrics: { enabled: false } });
    t.input.write('fix the orders sorting\n'); await wait();
    t.input.write('/context\n'); await wait(80);
    expect(t.text()).toContain('Context metrics are disabled');
    expect((fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(before) : '')).not.toContain('context_metrics');
    t.input.end(); await t.done;
  });
});

describe('smart verification after a turn', () => {
  const repo = () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tver-')));
    const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
    w('package.json', JSON.stringify({ type: 'module', scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' } }));
    w('src/math.js', 'export const add = (a, b) => a + b;\n');
    w('test/math.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: d });
    return d;
  };
  const run = (d: string, body: string, extra: Record<string, unknown> = {}) => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 120, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const c = new FakeClient();
    let n = 0;
    c.onTurn = async (threadId) => {
      fs.writeFileSync(path.join(d, 'src/math.js'), `${body}// turn ${++n}\n`);
      c.emit('item/completed', { threadId, item: { type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: path.join(d, 'src/math.js') }] } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    return { c, input, text: () => text, done: runTui(c, d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT), ...extra }) };
  };
  const wait = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

  it('manual mode asks once, runs the related test, reports; a failure goes into the next request', async () => {
    const d = repo();
    const t = run(d, 'export const add = (a, b) => a - b;\n', { router: new TurnRouter(ConfigSchema.parse({ stages: { enabled: false }, self_healing: { enabled: false } }), '/nonexistent', CAT) });
    t.input.write('make add faster\n'); await wait(700);
    expect(t.text()).toMatch(/Run verification\?\n {2}npm test -- test\/math\.test\.js\n\n\[y\] Run {3}\[n\] Skip/);
    t.input.write('y\n'); await wait();
    const out = t.text();
    expect(out).toMatch(/✗ 1 relevant test file \(npm test -- test\/math\.test\.js\) \d+(ms|s) — test failure/);
    expect(out).toMatch(/Verification: Quick · 1 file in src\/math\.js/);
    expect(out).toMatch(/Skipped:\n {4}Lint \(not required for this change\)\n {4}Full test suite \(not required for this change\)/);
    t.input.write('fix it\n'); await wait(700);
    const sent = t.c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text as string);
    expect(sent[1]).toMatch(/^\[Lumina verification after your last change: `npm test -- test\/math\.test\.js` failed \(test failure, exit 1\)/);
    t.input.end(); await t.done;
  }, 20000);
  it('auto approval mode runs without asking; "skip the tests" is respected; /verify full verifies the working tree', async () => {
    const d = repo();
    const t = run(d, 'export const add = (a, b) => a + b; // faster\n', { approvalMode: 'auto' });
    t.input.write('make add faster\n'); await wait();
    expect(t.text()).not.toContain('Run verification?');
    expect(t.text()).toMatch(/✓ 1 relevant test file \(npm test -- test\/math\.test\.js\)/);
    t.input.write('tweak add again but skip the tests\n'); await wait(700);
    expect(t.text()).toContain('Verification: off (you asked to skip verification)');
    t.input.write('/verify full\n'); await wait(2500);
    expect(t.text()).toMatch(/Verification: Full · verification\.mode = full|Verification: Full/);
    expect(t.text()).toMatch(/✓ Lint \(npm run lint\)/);
    expect(t.text()).toMatch(/✓ Full test suite \(npm test\)/);
    t.input.write('/verify full\n'); await wait(1500);
    expect(t.text()).toMatch(/✓ Full test suite · unchanged since it last passed/);
    t.input.end(); await t.done;
  }, 30000);
});

describe('self-healing after verification', () => {
  const repo = (testScript = 'node --test') => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-theal-')));
    const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
    w('package.json', JSON.stringify({ type: 'module', scripts: { test: testScript } }));
    w('src/math.js', 'export const add = (a, b) => a + b;\n');
    w('test/math.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: d });
    return d;
  };
  /** Turn n writes bodies[n-1] to src/math.js; `approve` makes the repair turn ask for a command approval first. */
  const run = (d: string, bodies: string[], extra: Record<string, unknown> = {}, approve = false) => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const c = new FakeClient();
    const decisions: unknown[] = [];
    let n = 0;
    c.onTurn = async (threadId) => {
      const i = n++;
      if (approve && i === 1) decisions.push(await c.serverHandler!('item/commandExecution/requestApproval', { threadId, command: 'node scripts/fixer.js', cwd: d }));
      fs.writeFileSync(path.join(d, 'src/math.js'), bodies[Math.min(i, bodies.length - 1)]);
      c.emit('item/completed', { threadId, item: { type: 'fileChange', id: `f${i}`, status: 'completed', changes: [{ path: path.join(d, 'src/math.js') }] } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const router = new TurnRouter(ConfigSchema.parse({ stages: { enabled: false, tiers: { fast: 'gpt-6-luna', balanced: 'gpt-6-sol', advanced: 'gpt-6-sol' } } }), '/nonexistent', CAT);
    return { c, input, decisions, text: () => text, done: runTui(c, d, { input, output }, { router, approvalMode: 'auto', ...extra }) };
  };
  const until = async (f: () => boolean, ms = 15000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 50)); };
  const turns = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start');

  it('a broken change is repaired in one focused fix turn and re-verified; both changes are checkpointed', async () => {
    const d = repo();
    const t = run(d, ['export const add = (a, b) => a - b;\n', 'export const add = (a, b) => a + b; // fixed\n']);
    t.input.write('make add faster\n');
    await until(() => /Repair successful/.test(t.text()));
    const out = t.text();
    expect(out).toMatch(/✗ 1 relevant test file .* — test failure/);
    expect(out).toMatch(/Self-Healing: Attempt 1\/2 · GPT-6 Luna · medium · same model and reasoning that made the change/);
    expect(out).toMatch(/✓ 1 relevant test file \(npm test -- test\/math\.test\.js\)/);
    expect(out).toContain('✓ Repair successful\n✓ Verification passed');
    const repair = turns(t.c)[1].params;
    expect(repair.input[0].text).toMatch(/^\[Lumina stage 1: Fix failing checks\][\s\S]*npm test -- test\/math\.test\.js[\s\S]*do not restart the original task/);
    expect(repair.input).toHaveLength(1); // no skills/images re-sent
    t.input.write('/checkpoints\n'); await until(() => /self-heal attempt 1/.test(t.text()));
    expect(t.text()).toMatch(/active\s+1 file\s+self-heal attempt 1: make add faster/);
    t.input.write('fix more\n'); await until(() => turns(t.c).length === 3);
    expect(turns(t.c)[2].params.input[0].text).toBe('fix more'); // a successful repair leaves no failure context behind
    t.input.end(); await t.done;
  }, 40000);
  it('repeated failure: exhausted after the attempt limit, manual intervention reported, failure handed to the next request', async () => {
    const d = repo();
    const t = run(d, ['export const add = (a, b) => a - b;\n', 'export const add = (a, b) => a * b;\n', 'export const add = (a, b) => b - a;\n']);
    t.input.write('make add faster\n');
    await until(() => /Automatic repair/.test(t.text()), 30000);
    const out = t.text();
    expect(out).toMatch(/✗ Automatic repair (exhausted|stopped)/);
    expect(out).toMatch(/Attempts: [12]/);
    expect(out).toMatch(/Last error: test failure in `npm test -- test\/math\.test\.js`/);
    expect(out).toContain('Manual intervention required.');
    expect(turns(t.c).length).toBeLessThanOrEqual(3);
    t.input.end(); await t.done;
  }, 60000);
  it('environment failure (test runner missing) never triggers a code change', async () => {
    const d = repo('vitest-does-not-exist run');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'lumina-missing-runner' } }));
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'runner'], { cwd: d });
    const t = run(d, ['export const add = (a, b) => a + b; // v2\n']);
    t.input.write('make add faster\n');
    await until(() => /Self-Healing: not applied/.test(t.text()));
    expect(t.text()).toMatch(/— missing dependency/);
    expect(t.text()).toMatch(/Full test suite: ENVIRONMENT_FAILURE \(missing dependency\)/);
    expect(turns(t.c)).toHaveLength(1);
    t.input.end(); await t.done;
  }, 30000);
  it('repairs go through the normal approval flow (manual answer required) and Ctrl-C cancels the loop', async () => {
    const d = repo();
    const t = run(d, ['export const add = (a, b) => a - b;\n', 'export const add = (a, b) => a + b; // fixed\n'], {}, true);
    t.input.write('make add faster\n');
    await until(() => /Approval Required/.test(t.text()));
    expect(t.text()).toContain('node scripts/fixer.js'); // not auto-approved: unknown command, even in auto mode
    t.input.write('n\n');
    await until(() => /Repair successful/.test(t.text()));
    expect(t.decisions).toEqual([{ decision: 'decline' }]);
    t.input.end(); await t.done;
    const d2 = repo();
    const u = run(d2, ['export const add = (a, b) => a - b;\n', 'export const add = (a, b) => a * b;\n'], {}, true);
    u.input.write('make add faster\n');
    await until(() => /Approval Required/.test(u.text()));
    u.input.write('\x03');
    await until(() => /self-healing cancelled|Cancelled/.test(u.text()));
    expect(turns(u.c)).toHaveLength(2);
    expect(u.text()).not.toMatch(/Attempt 2\/2/);
    u.input.end(); await u.done;
  }, 60000);
});

describe('/memory and project memory in turns', () => {
  const repo = () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tmem-')));
    fs.mkdirSync(path.join(d, 'src', 'base'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'base', 'baseCategory.ts'), 'export class BaseCategory {}\n');
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', `init ${d}`], { cwd: d });
    return d;
  };
  const session = (d: string) => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const c = new FakeClient();
    return { c, input, text: () => text, done: runTui(c, d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) }) };
  };
  const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  const sent = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text as string);

  it('a stated decision is remembered and sent in a later session only when relevant; /memory list, inspect, forget (confirmed)', async () => {
    const d = repo();
    const a = session(d);
    a.input.write('Remember that HEMS and regular Base use the shared BaseCategory model.\n'); await wait();
    const id = /remembered decision (mem_[0-9a-f]{8})/.exec(a.text())?.[1];
    expect(id).toBeTruthy();
    a.input.end(); await a.done;

    const b = session(d); // new session (restart)
    b.input.write('Update the HEMS Base endpoint.\n'); await wait();
    expect(sent(b.c)[0]).toMatch(/\[Lumina project memory: [^\n]*\]\n- \(decision\) HEMS and regular Base use the shared BaseCategory model/);
    expect(b.text()).toContain('project memory: 1 note');
    b.input.write('fix the login button colour\n'); await wait();
    expect(sent(b.c)[1]).not.toContain('Lumina project memory');
    b.input.write('/memory\n'); await wait(150);
    expect(b.text()).toMatch(/Project memory · \d+ entr(y|ies) · git-[0-9a-f]{16}/);
    b.input.write('/memory list\n'); await wait(150);
    expect(b.text()).toContain(`${id}  decision     verified   HEMS and regular Base`);
    b.input.write(`/memory inspect ${id}\n`); await wait(150);
    expect(b.text()).toMatch(new RegExp(`${id} · decision · verified · source: user`));
    b.input.write(`/memory forget ${id}\n`); await wait(150);
    expect(b.text()).toContain('Forget this memory?');
    b.input.write('n\n'); await wait(150);
    expect(b.text()).toContain('memory kept');
    b.input.write(`/memory forget ${id}\n`); await wait(150);
    b.input.write('y\n'); await wait(150);
    expect(b.text()).toContain(`forgot ${id}`);
    b.input.write('/memory refresh\n'); await wait(500);
    expect(b.text()).toMatch(/memory refreshed: repository notes re-derived/);
    b.input.write('/memory add the password is hunter2hunter2\n'); await wait(150);
    expect(b.text()).toContain('not stored: it looks like it contains a secret');
    b.input.end(); await b.done;
  }, 20000);
});

describe('/why and /diagnostics', () => {
  const session = (d: string, c = new FakeClient()) => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    return { c, input, text: () => text, done: runTui(c, d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) }) };
  };
  const repo = () => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tdiag-'))); execFileSync('git', ['init', '-q'], { cwd: d }); return d; };
  const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));

  it('explains the recorded routing, shows execution diagnostics with provider tokens, and survives a restart', async () => {
    const d = repo();
    const c = new FakeClient();
    c.onTurn = async (threadId) => {
      c.emit('item/completed', { threadId, item: { type: 'commandExecution', command: 'rg -n auth src', exitCode: 1, status: 'failed', commandActions: [{ type: 'search' }] } });
      c.emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: 126200, inputTokens: 125000, cachedInputTokens: 110000, outputTokens: 1200 }, last: { totalTokens: 126200 }, modelContextWindow: 250000 } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const a = session(d, c);
    a.input.write('/why\n'); await wait(100);
    expect(a.text()).toContain('No request has been routed in this session yet.');
    a.input.write('Update the authentication middleware to check token expiry\n'); await wait();
    a.input.write('/why\n'); await wait(100);
    expect(a.text()).toMatch(/Routing Decision\n\nTask: critical task \(high risk\)\nClassification: critical/);
    expect(a.text()).toMatch(/Model: GPT-6 \w+\nReasoning: \w+ — security-sensitive implementation\nSelected by: automatic routing\n\nReasons:\n- modifies security\/payment\/data-integrity logic/);
    a.input.write('/diagnostics\n'); await wait(100);
    const out = a.text();
    expect(out).toMatch(/Execution Diagnostics\n\nRequest: critical task \(high risk\) · req_\w+\nStatus: Completed\nDuration: \d+(ms|s)/);
    expect(out).toContain('Input tokens: 125,000 · Cached: 110,000 · Output: 1,200 (provider-reported)');
    expect(out).toContain('Commands: 1 (1 non-zero exit)'); // rg exit 1 is recorded, not a failure of the request
    expect(out).not.toContain('Failure:');
    const stored = fs.readdirSync(path.join(process.env.SMART_CODEX_HOME!, 'diagnostics')).map((f) => fs.readFileSync(path.join(process.env.SMART_CODEX_HOME!, 'diagnostics', f), 'utf8')).join('');
    expect(stored).toContain('critical task (high risk)');
    expect(stored).not.toMatch(/token expiry|authentication middleware/); // prompts are not stored (analytics.store_prompts is off)
    a.input.end(); await a.done;

    const b = session(d); // restart
    b.input.write('/diagnostics\n'); await wait(150);
    expect(b.text()).toContain('Input tokens: 125,000 · Cached: 110,000');
    b.input.write('/diagnostics history\n'); await wait(150);
    expect(b.text()).toMatch(/1\. req_\w+ .* completed +GPT-6 \w+ {2}critical task \(high risk\)/);
    b.input.write('/diagnostics 1\n'); await wait(150);
    expect(b.text()).toMatch(/Trace \(\d+ events\):[\s\S]*request_received[\s\S]*task_classified[\s\S]*model_selected[\s\S]*tool_executed tool=rg[\s\S]*execution_completed/);
    b.input.end(); await b.done;
  }, 20000);
  it('a failed request prints an actionable diagnosis', async () => {
    const d = repo();
    const c = new FakeClient();
    c.onTurn = async (threadId) => { c.emit('turn/completed', { threadId, turn: { status: 'failed', error: { message: 'The model gpt-6-luna is not supported when using Codex with a ChatGPT account' } } }); };
    const a = session(d, c);
    a.input.write('rename the helper\n'); await wait();
    expect(a.text()).toMatch(/Diagnostics: model unavailable failure in Execute request\n {2}→ Pick another model with \/model/);
    a.input.write('/diagnostics\n'); await wait(100);
    expect(a.text()).toMatch(/Failure:\n {2}Category: model unavailable\n {2}Failed operation: Execute request\n {2}Error: The model gpt-6-luna is not supported/);
    a.input.end(); await a.done;
  }, 20000);
});

describe('/graph', () => {
  it('shows dependencies and dependents, updates incrementally after an edit', async () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tgraph-')));
    execFileSync('git', ['init', '-q'], { cwd: d });
    const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
    w('src/repo.ts', 'export class OrderRepository {}\n');
    w('src/service.ts', "import { OrderRepository } from './repo';\nexport class OrderService { r = new OrderRepository(); }\n");
    w('src/handler.ts', "import { OrderService } from './service';\nexport function OrderHandler() { return new OrderService(); }\n");
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const done = runTui(new FakeClient(), d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) });
    const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
    input.write('/graph\n'); await wait(100);
    expect(text).toContain('usage: /graph <file-or-symbol>');
    input.write('/graph OrderService\n'); await wait();
    expect(text).toContain('OrderService  (class, exported · src/service.ts:2)\n├── Depends on\n│   └── OrderRepository  src/repo.ts  (L2)\n└── Used by\n    └── OrderHandler  src/handler.ts:2  (imports OrderService (L1))');
    expect(text).toMatch(/3 source files · 3 parsed, 0 unchanged/);
    w('src/controller.ts', "import { OrderService } from './service';\nexport class OrderController { s = new OrderService(); }\n");
    input.write('/graph src/service.ts\n'); await wait();
    expect(text).toMatch(/Used by\n│ {3}├── src\/controller\.ts {2}\(static, L1\)\n│ {3}└── src\/handler\.ts {2}\(static, L1\)/);
    expect(text).toMatch(/4 source files · 1 parsed, 3 unchanged/);
    input.end(); await done;
  }, 20000);
});

describe('/impact', () => {
  it('predicts for a symbol, analyses actual uncommitted changes without arguments, and never modifies files', async () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-timp-')));
    const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
    w('src/service.ts', 'export function total(a: number): number { return a; }\n');
    w('src/handler.ts', "import { total } from './service';\nexport function Handler() { return total(1); }\n");
    execFileSync('git', ['init', '-q'], { cwd: d });
    execFileSync('git', ['add', '-A'], { cwd: d });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: d });
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const done = runTui(new FakeClient(), d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) });
    const wait = (ms = 400) => new Promise((r) => setTimeout(r, ms));
    input.write('/impact\n'); await wait();
    expect(text).toContain('No uncommitted changes.');
    input.write('/impact total\n'); await wait();
    expect(text).toMatch(/Target: total {2}\(src\/service\.ts\)\n\nRisk: Low[\s\S]*Confirmed dependents \(graph edges\): 1\n {2}- Handler · src\/handler\.ts — imports total \(L1\) at src\/handler\.ts:2/);
    w('src/service.ts', 'export function total(a: number, b: number): number { return a + b; }\n');
    const before = fs.readFileSync(path.join(d, 'src/service.ts'), 'utf8');
    input.write('/impact\n'); await wait();
    expect(text).toMatch(/Target: src\/service\.ts[\s\S]*Risk: High\n {2}- 1 possibly breaking change to symbols still used elsewhere \(total: signature changed\)/);
    expect(fs.readFileSync(path.join(d, 'src/service.ts'), 'utf8')).toBe(before);
    input.end(); await done;
  }, 20000);
});

describe('/api-check', () => {
  it('runs a scoped static contract check and never changes files', async () => {
    const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tapi-')));
    execFileSync('git', ['init', '-q'], { cwd: d });
    const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
    w('openapi.json', JSON.stringify({ openapi: '3.0.0', paths: { '/api/v1/orders': { get: { responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', required: ['order_uuid'], properties: { order_uuid: { type: 'string' } } } } } } } } } }, '/api/v1/users': { get: { responses: { 200: { description: 'x' } } } } } }));
    w('src/orders.ts', "interface Order { order_id: number }\nexport async function orders(): Promise<Order[]> { const r = await fetch('/api/v1/orders'); return r.json(); }\n");
    const before = fs.readFileSync(path.join(d, 'src/orders.ts'), 'utf8');
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const done = runTui(new FakeClient(), d, { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) });
    input.write('/api-check orders\n'); await new Promise((r) => setTimeout(r, 600));
    expect(text).toMatch(/API Contract Check · scope: orders · 1 endpoint \(openapi 1\) · 1 frontend call/);
    expect(text).toContain('Endpoint: GET /api/v1/orders\n  Backend:  order_uuid: string\n  Frontend: order_id: number\n  Status: ? Potential contract mismatch');
    expect(fs.readFileSync(path.join(d, 'src/orders.ts'), 'utf8')).toBe(before);
    input.end(); await done;
  });
});

describe('/workspace', () => {
  it('shows linked repositories, cross-repo impact, and sends only relevant cross-repo facts with a turn', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tws-')));
    const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(base, f)), { recursive: true }); fs.writeFileSync(path.join(base, f), c); };
    for (const r of ['backend', 'frontend']) { fs.mkdirSync(path.join(base, r)); execFileSync('git', ['init', '-q'], { cwd: path.join(base, r) }); }
    w('backend/openapi.json', JSON.stringify({ openapi: '3.0.0', paths: { '/api/v1/orders': { get: { responses: { 200: { description: 'ok' } } } } } }));
    w('frontend/src/orders.ts', "export const list = () => fetch('/api/v1/orders');\n");
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const c = new FakeClient();
    const router = new TurnRouter(ConfigSchema.parse({ stages: { enabled: false }, workspace: { repositories: ['../frontend'] } }), '/nonexistent', CAT);
    const done = runTui(c, path.join(base, 'backend'), { input, output }, { router });
    const wait = (ms = 500) => new Promise((r) => setTimeout(r, ms));
    input.write('/workspace\n'); await wait();
    expect(text).toMatch(/Workspace\n\nRepositories:\n {2}● backend \(current\)[\s\S]*● frontend[\s\S]*· read-only/);
    expect(text).toContain('Verified relationships: 1\n  - frontend → backend (api): 1 API call to backend');
    input.write('/workspace impact GET /api/v1/orders\n'); await wait();
    expect(text).toContain('Consumers:\n  - frontend/src/orders.ts:1');
    input.write('speed up the orders endpoint\n'); await wait();
    const sent = c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text as string);
    expect(sent[0]).toMatch(/\[Lumina workspace: [^\n]*read-only[^\n]*\]\n- GET \/api\/v1\/orders \(served here, openapi\.json\) is called by frontend\/src\/orders\.ts:1/);
    input.write('rename a variable\n'); await wait();
    const sent2 = c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text as string);
    expect(sent2[1]).not.toContain('Lumina workspace');
    input.end(); await done;
  });
});

describe('/feedback', () => {
  it('records each request (no prompt text), shows per-category outcomes, toggles influence and resets after confirmation', async () => {
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tfb-'));
    const prev = process.env.SMART_CODEX_HOME;
    process.env.SMART_CODEX_HOME = home;
    try {
      const done = runTui(new FakeClient(), '/w', { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) });
      const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
      input.write('add a CRUD endpoint for products with validation\n'); await wait();
      input.write('/feedback\n'); await wait(120);
      expect(text).toMatch(/Routing feedback · 1 outcomes · influence on[\s\S]*normal · standard implementation\n {2}gpt-6-luna\/medium: 0 verified success, 0 failed, 1 unverified/);
      expect(fs.readFileSync(path.join(home, 'feedback.jsonl'), 'utf8')).not.toContain('products');
      input.write('/feedback off\n'); await wait(80);
      expect(text).toContain('routing feedback influence: off for this session');
      input.write('/feedback reset\n'); await wait(80);
      input.write('y\n'); await wait(80);
      expect(text).toContain('routing feedback reset (1 outcomes deleted)');
      input.end(); await done;
    } finally { process.env.SMART_CODEX_HOME = prev; }
  });
});

describe('/models stats', () => {
  it('reports from the local history, filters, and explains usage', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-tms-'));
    const prev = process.env.SMART_CODEX_HOME;
    process.env.SMART_CODEX_HOME = home;
    try {
      const line = (o: Record<string, unknown>) => JSON.stringify({ at: 1, category: 'normal · standard implementation', tier: 'normal', complexity: 5, risk: 'low', model: 'gpt-6-luna', effort: 'medium', source: 'automatic routing', ms: 28000, input: 1000, cached: 800, output: 50, outcome: 'verified-success', repairs: 0, escalations: 0, switches: 0, ...o });
      fs.writeFileSync(path.join(home, 'feedback.jsonl'), `${Array.from({ length: 6 }, () => line({})).join('\n')}\n${line({ model: 'gpt-6-sol', ms: 45000 })}\n`);
      const input = new PassThrough();
      const output = Object.assign(new PassThrough(), { columns: 140, isTTY: false }) as unknown as NodeJS.WriteStream;
      let text = '';
      output.on('data', (x) => { text += x.toString(); });
      const done = runTui(new FakeClient(), '/w', { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT) });
      const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));
      input.write('/models stats\n'); await wait();
      expect(text).toMatch(/Model Performance · 7 executions \(local history\)\n\nGPT-6 Luna:\n {2}Executions: 6 \(6 verified success, 0 failed, 0 unknown — not verified\)\n {2}Verified success: 100%\n {2}Median duration: 28s/);
      expect(text).toMatch(/GPT-6 Sol:\n {2}Executions: 1[\s\S]*Verified success: insufficient samples/);
      input.write('/models stats high\n'); await wait();
      expect(text).toContain('No recorded executions match this filter.');
      input.write('/models\n'); await wait();
      expect(text).toContain('usage: /models stats');
      input.end(); await done;
    } finally { process.env.SMART_CODEX_HOME = prev; }
  });
});

describe('context compaction at turn boundaries', () => {
  it('long conversation: compacts once before a turn (never during one), restates critical context, shows it in /context; short ones never compact', async () => {
    const c = new FakeClient();
    let n = 0;
    c.onTurn = async (threadId) => {
      n++;
      const used = n <= 3 ? 20_000 : 200_000; // grows large after a few turns
      c.emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: n * 1000, inputTokens: n * 900, cachedInputTokens: 0, outputTokens: n * 100 }, last: { totalTokens: used }, modelContextWindow: 250_000 } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 160, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const done = runTui(c, '/w', { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT), approvalMode: 'smart' });
    const settle = async (k: number) => { for (let i = 0; i < 250 && (text.match(/Completed in/g) ?? []).length < k; i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 40)); };
    const order = () => c.requests.filter((r) => r.method === 'turn/start' || r.method === 'thread/compact/start').map((r) => r.method === 'turn/start' ? 'turn' : 'compact');
    for (let i = 1; i <= 6; i++) { input.write(`explain module ${i}\n`); await settle(i); }
    expect(order()).toEqual(['turn', 'turn', 'turn', 'turn', 'turn', 'turn']); // fewer than 6 finished turns, then small context: no compaction
    input.write('explain module 7\n'); await settle(7);
    expect(order()).toEqual(['turn', 'turn', 'turn', 'turn', 'turn', 'turn', 'compact', 'turn']); // compacted at the boundary, then the turn ran
    const sent = c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text as string);
    expect(sent[6]).toMatch(/^\[Lumina preserved context after compaction — restated so it does not depend on the summary:\n- Approvals: smart mode\]\n\nexplain module 7$/);
    expect(text).toMatch(/conversation compacted \(context 80% of the window after 6 turns; \d+ms\) · critical context restated/);
    input.write('explain module 8\n'); await settle(8);
    expect(order().filter((x) => x === 'compact')).toHaveLength(1); // no repeated compaction right after one
    input.write('/context\n'); await new Promise((r) => setTimeout(r, 120));
    expect(text).toMatch(/Compaction: 1 done · 2 turns since the last one\n {2}✓ turn boundary · 200,000 tokens \(80%\) → 200,000 at the next turn \(includes its new input\) · \d+ms · compaction cost: not reported by Codex/);
    expect(text).toContain('next turn: short conversation (2 turns since the last reset/compaction)');
    input.end(); await done;
  }, 30000);
});

describe('budget-aware execution', () => {
  it('stops at a boundary when the token threshold is reached, keeps progress, explains; /budget shows usage; /continue resumes through the normal approval flow', async () => {
    const c = new FakeClient();
    let n = 0;
    const decisions: unknown[] = [];
    c.onTurn = async (threadId) => {
      n++;
      if (n === 2) decisions.push(await c.serverHandler!('item/commandExecution/requestApproval', { threadId, command: 'npm install left-pad', cwd: '/w' }));
      c.emit('item/completed', { threadId, item: { type: 'commandExecution', command: 'npm test', exitCode: n === 1 ? 1 : 0, status: n === 1 ? 'failed' : 'completed' } });
      c.emit('thread/tokenUsage/updated', { threadId, tokenUsage: { total: { totalTokens: n * 5100, inputTokens: n * 5000, cachedInputTokens: n * 1000, outputTokens: n * 100 }, last: { totalTokens: 5100 }, modelContextWindow: 250000 } });
      c.emit('turn/completed', { threadId, turn: { status: 'completed', error: null } });
    };
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 160, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const router = new TurnRouter(ConfigSchema.parse({ budget: { max_input_tokens: 4000 }, feedback: { influence: false } }), '/nonexistent', CAT);
    const done = runTui(c, '/w', { input, output }, { router });
    const until = async (f: () => boolean) => { for (let i = 0; i < 250 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };
    input.write('add a CRUD endpoint for products with validation\n');
    await until(() => text.includes('Stopped at an execution boundary'));
    expect(c.requests.filter((r) => r.method === 'turn/start')).toHaveLength(1); // no fix stage over budget
    expect(text).toMatch(/⏸ Stopped at an execution boundary: budget exhausted \(input token threshold: 5,000 of 4,000 \(provider-reported\)\)\.\n {2}Not finished: fix the failing tests\n {2}Progress so far is kept/);
    expect(text).not.toMatch(/✓ Completed in/); // not presented as complete
    expect(text).toContain('Diagnostics: budget failure in');
    input.write('/budget\n'); await until(() => text.includes('Last request:'));
    await new Promise((r) => setTimeout(r, 50)); // let the command finish
    expect(text).toMatch(/Budget limits \(per request\):[\s\S]*Input tokens: 4,000[\s\S]*Last request:\n {2}Stages: 1 of 3[\s\S]*Tokens \(provider-reported\): input 5,000 of 4,000 \(cached 1,000\) · output 100/);
    input.write('/continue\n');
    await until(() => text.includes('[y] Approve'));
    const sent = c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params.input[0].text as string);
    expect(sent[1]).toMatch(/Continue the previous request: "add a CRUD endpoint for products with validation"\. It was stopped at an execution boundary \(input token threshold[^)]*\)\)\. Still to do: fix the failing tests\./);
    input.write('n\n'); await until(() => decisions.length > 0);
    expect(decisions).toEqual([{ decision: 'decline' }]); // approvals still apply to continued work
    input.write('/continue\n'); await until(() => text.includes('Nothing to continue'));
    input.end(); await done;
  }, 30000);
});

describe('/benchmark', () => {
  it('defaults to mock (no model calls); real needs explicit confirmation and never touches this session', async () => {
    const c = new FakeClient();
    let sessions = 0;
    const input = new PassThrough();
    const output = Object.assign(new PassThrough(), { columns: 160, isTTY: false }) as unknown as NodeJS.WriteStream;
    let text = '';
    output.on('data', (x) => { text += x.toString(); });
    const done = runTui(c, '/w', { input, output }, { router: new TurnRouter(LEGACY, '/nonexistent', CAT), benchSession: async () => { sessions++; throw new Error('not in this test'); } });
    const until = async (f: () => boolean) => { for (let i = 0; i < 250 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); await new Promise((r) => setTimeout(r, 30)); };
    input.write('/benchmark\n'); await until(() => text.includes('Expectations:'));
    expect(text).toMatch(/Routing Benchmark · MOCK \(no model calls; deterministic expectations\) · 13 scenarios/);
    expect(c.requests.filter((r) => r.method === 'turn/start')).toHaveLength(0);
    input.write('/benchmark mock nope\n'); await until(() => text.includes('unknown scenario nope'));
    input.write('/benchmark real 2 rename\n'); await until(() => text.includes('Run REAL benchmarks?'));
    expect(text).toContain('Simple rename · 2 samples each = 2 Codex executions in temporary repositories.');
    input.write('n\n'); await until(() => text.includes('real benchmark cancelled'));
    expect(sessions).toBe(0);
    input.end(); await done;
  });
});
