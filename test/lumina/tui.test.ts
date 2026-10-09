import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
/* eslint-disable no-control-regex */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
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
    if (method === 'thread/list') return { data: [{ id: 'abcdef12-0000', preview: 'earlier chat' }, { id: 'zzzz9999-0000', preview: 'older' }] };
    if (method === 'thread/resume') return { thread: { id: params.threadId }, model: 'gpt-6-sol' };
    if (method === 'thread/start') return params.ephemeral ? { thread: { id: `iso-${++this.iso}` }, model: 'gpt-6-luna' } : { thread: { id: 't1' }, model: 'gpt-6-luna' };
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
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

  it('multi-turn conversation with streamed output, then exit', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('hello\n');
    await wait();
    t.input.write('world\n');
    await wait();
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
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const turnParams = (c: FakeClient) => c.requests.filter((r) => r.method === 'turn/start').map((r) => r.params);

  it('routes each turn independently on one thread (context preserved) and shows the selection', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('update the button text\n'); await wait();
    t.input.write('Fix payment webhook signature verification\n'); await wait();
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
    t.input.write('Fix payment webhook signature verification\n'); await wait();
    t.input.write('ok do it\n'); await wait();
    expect(turnParams(c)[1]).toMatchObject({ model: 'gpt-6-sol', effort: 'high' });
    t.input.write('/model gpt-6-luna\n'); await wait();
    t.input.write('/reasoning low\n'); await wait();
    t.input.write('Refactor authentication middleware\n'); await wait();
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
    t.input.write('hello\n'); await wait();
    t.input.write('/new\n'); await wait();
    t.input.write('hello again\n'); await wait();
    expect(c.requests.filter((r) => r.method === 'thread/start')).toHaveLength(2);
    t.input.write('/resume\n'); await wait();
    expect(t.text()).toContain('1. earlier chat');
    t.input.write('/resume 2\n'); await wait();
    t.input.write('continue the work\n'); await wait();
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
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
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
    t.input.write('delete the build dir\n'); await wait();
    expect(t.text()).toContain('Approval Required');
    expect(t.text()).toContain('rm -rf build');
    expect(t.text()).toContain('[y] Approve');
    t.input.write('maybe\n'); await wait(20); // invalid answer re-asks, does not decide
    expect(decisions).toHaveLength(0);
    t.input.write(`${answer}\n`); await wait();
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
    t.input.write('run it\r'); await wait();
    expect(t.text()).toContain('Approval Required');
    t.input.write('\x03'); await wait();
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
    t.input.write('go\r'); t.input.write('my draft'); await wait(80);
    expect(plain(t.text())).toContain('Approval Required');
    t.input.write('y\r'); await wait(80);
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
  const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
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
  it('persistent composer: separators, placeholder prompt, status bar and hints sit at the bottom', async () => {
    const t = setup(new FakeClient());
    await wait();
    expect(t.screen().slice(-5)).toEqual([RULE(60), '› Ask Lumina anything...', RULE(60), '  ◉ Auto Routing · GPT-6 Luna ⇄ GPT-6 Sol', '  /model  /reasoning  /approval  /skills  /usage']);
    t.input.write('Create auth');
    t.input.write('\x1b[13;2u');
    t.input.write('Add tests');
    await wait();
    expect(t.screen().slice(-6, -2)).toEqual([RULE(60), '› Create auth', '  Add tests', RULE(60)]);
    t.input.write('\x03'); // Ctrl-C clears the draft when idle
    await quit(t);
  });
  it('status bar follows the actual routing: model, effort, manual overrides and approval mode', async () => {
    const c = new FakeClient();
    const t = setup(c, {}, true, 80);
    const bar = () => t.screen().at(-2);
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
    expect(rows.find((r) => /^ {2}[◐◓◑◒] Reading files\.\.\. \(\ds\)$/.test(r))).toBeTruthy();
    expect(rows.slice(-5, -3)).toEqual([RULE(60), '› Ask Lumina anything...']); // composer still anchored during the turn
    release(); await wait(80);
    rows = t.screen();
    const i = rows.indexOf('◆ Lumina');
    expect(rows.slice(i, i + 5)).toEqual(['◆ Lumina', '  ✓ Read 1 file', '  Authentication module implemented.', expect.stringMatching(/^ {2}✓ Completed in \ds$/), '']);
    expect(rows.join('\n')).not.toMatch(/[◐◓◑◒] Reading/);
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
    expect(rows.slice(-5, -1)).toEqual([RULE(60), '› my next question', RULE(60), expect.stringContaining('◉ Auto Routing')]);
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
    const t = setup(c);
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
    expect(rows.slice(-6, -1).every((r) => r.length <= 30)).toBe(true);
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
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
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
    expect(rows.slice(-5)[1]).toBe('› Ask Lumina anything...'); // the composer is still there under the menu
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
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));
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
  });
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
  const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

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
  const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

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
  const wait = (ms = 50) => new Promise((r) => setTimeout(r, ms));
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
  it('a security review is one stage on the stronger model (risk → model, not stages)', async () => {
    const c = new FakeClient();
    const t = setup(c);
    t.input.write('Review this authentication middleware\n'); await wait();
    expect(turns(c).map((p) => `${p.model}/${p.effort}`)).toEqual(['gpt-6-sol/high']);
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
    expect(out).toContain('↪ Switching model: GPT-6 Luna → GPT-6 Sol');
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
    expect(t.screen().at(-2)).toBe('  ◉ Auto Routing · GPT-6 Sol · High');
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
  const wait = (ms = 40) => new Promise((r) => setTimeout(r, ms));
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
    expect(t.screen().join('\n')).toContain('1. earlier chat');
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
