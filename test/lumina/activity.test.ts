/* eslint-disable no-control-regex */
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Activity } from '../../src/lumina/tui/activity.js';
import { Screen } from '../../src/lumina/tui/screen.js';
import { emulate } from './term.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
let out: PassThrough & { columns?: number };
let text: string;
let screen: Screen;
const mk = (o: { live?: boolean; color?: boolean } = {}) => {
  const live = o.live ?? true;
  screen = new Screen(out, { live, color: o.color ?? false });
  return new Activity(screen, { animate: live, color: o.color ?? false });
};
const snap = () => { screen.flush(); return emulate(text).join('\n'); };
const cmd = (id: string, actions: string[] = ['unknown'], extra = {}) => ({ item: { type: 'commandExecution', id, commandActions: actions.map((type) => ({ type })), ...extra } });
const started = (a: Activity, it: object) => a.event('item/started', it);
const done = (a: Activity, it: { item: object }) => a.event('item/completed', { item: { status: 'completed', ...it.item } });

beforeEach(() => {
  vi.useFakeTimers();
  out = Object.assign(new PassThrough(), { columns: 60 });
  text = '';
  out.on('data', (d) => { text += d.toString(); });
});
afterEach(() => { vi.useRealTimers(); });

describe('spinner', () => {
  it('starts immediately, animates with elapsed time, and stops on success with one completion line', () => {
    const a = mk();
    a.begin('Thinking...');
    expect(snap()).toContain('◐ Thinking... 0s');
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) { vi.advanceTimersByTime(100); seen.add(snap().match(/[◐◓◑◒] Thinking/g)?.at(-1)?.[0] ?? ''); }
    for (const f of ['◐', '◓', '◑', '◒']) expect(seen).toContain(f);
    expect(snap()).toContain('Thinking... 2s');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1600);
    a.end('completed');
    a.end('completed');
    screen.flush();
    expect(vi.getTimerCount()).toBe(0);
    expect(a.hasTimer).toBe(false);
    expect(strip(text).match(/Completed in/g)).toHaveLength(1);
    expect(strip(text)).toContain('✓ Completed in 4s');
    const len = text.length;
    vi.advanceTimersByTime(1000);
    screen.flush();
    expect(text.length).toBe(len); // nothing is drawn after stop
  });
  it.each([['failed', '✗ Failed after 3s'], ['cancelled', '! Cancelled after 3s']] as const)('stops on %s', (status, line) => {
    const a = mk();
    a.begin('Thinking...');
    vi.advanceTimersByTime(3000);
    a.end(status, 'boom happened');
    expect(snap()).toContain(line);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never duplicates timers when begin is called again, and dispose cleans up', () => {
    const a = mk();
    a.begin('x'); a.begin('y');
    expect(vi.getTimerCount()).toBe(1);
    a.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('pauses for approval (status row hidden, nothing redrawn) and resumes', () => {
    const a = mk();
    a.begin('Running command...');
    expect(snap()).toContain('Running command...');
    a.pause();
    expect(snap()).not.toContain('Running command...');
    const len = text.length;
    vi.advanceTimersByTime(1000);
    screen.flush();
    expect(text.length).toBe(len);
    a.resume();
    expect(snap()).toContain('Running command...');
  });
  it('the status row never exceeds the terminal width', () => {
    out.columns = 24;
    const a = mk();
    a.begin('Thinking about something rather long...');
    const row = snap().split('\n').find((l) => l.includes('Thinking'))!;
    expect(row.length).toBeLessThanOrEqual(23);
    expect(row.endsWith('…')).toBe(true);
  });
});

describe('streaming', () => {
  it('streamed text is committed above the live region; the spinner row stays below it', () => {
    const a = mk();
    a.begin('Thinking...');
    a.text('partial answer');
    const mid = snap();
    expect(mid).toContain('  partial answer'); // visible in the live region while the line is open
    a.text(' done\n');
    const t = snap();
    const lines = t.split('\n');
    expect(lines).toContain('  partial answer done');
    expect(lines.indexOf('  partial answer done')).toBeLessThan(lines.lastIndexOf('  ◐ Thinking... 0s'));
    a.end('completed');
  });
  it('a new activity after mid-line text starts on its own row', () => {
    const a = mk({ live: false });
    a.begin('Thinking...');
    a.text('let me check');
    started(a, cmd('1', ['read'])); done(a, cmd('1', ['read']));
    a.end('completed');
    expect(strip(text)).toContain('  let me check\n\n  ✓ Read 1 file\n'); // status lines after prose start a new paragraph
  });
});

describe('statuses and timeline', () => {
  it('labels follow events only; default stays Thinking', () => {
    const a = mk();
    a.begin('Connecting...');
    expect(snap()).toContain('Connecting...');
    a.event('turn/started', {});
    expect(snap()).toContain('Thinking...');
    a.event('item/started', { item: { type: 'reasoning', id: 'r' } });
    expect(snap()).toContain('Reasoning...');
    started(a, cmd('1', ['search'])); expect(snap()).toContain('Searching files...');
    done(a, cmd('1', ['search']));
    started(a, cmd('2')); expect(snap()).toContain('Running command...');
    done(a, cmd('2'));
    started(a, { item: { type: 'fileChange', id: '3', changes: [{}, {}] } }); expect(snap()).toContain('Editing files...');
    done(a, { item: { type: 'fileChange', id: '3', changes: [{}, {}] } });
    a.event('item/completed', { item: { type: 'agentMessage', id: 'm' } });
    expect(snap()).toContain('Finalizing...');
    a.end('completed');
    expect(snap()).toContain('✓ Searched 1 time');
    expect(snap()).toContain('✓ Ran 1 command');
    expect(snap()).toContain('✓ Edited 2 files');
  });
  it('suppresses duplicates, collapses repeated ops, and keeps failures', () => {
    const a = mk({ live: false });
    a.begin('Thinking...');
    for (const id of ['1', '2', '3']) { started(a, cmd(id, ['read'])); started(a, cmd(id, ['read'])); done(a, cmd(id, ['read'])); done(a, cmd(id, ['read'])); }
    started(a, cmd('4')); done(a, cmd('4', ['unknown'], { status: 'failed', exitCode: 2 }));
    a.end('failed', 'tests failed');
    const t = strip(text);
    expect(t.match(/Read 3 files/g)).toHaveLength(1);
    expect(t).toContain('✗ Command failed (exit 2)');
    expect(t).not.toContain('npm');
    expect(t).toContain('✗ Failed after');
  });
  it('folds timeline lines beyond the cap', () => {
    const a = mk({ live: false });
    a.begin('x');
    for (let i = 0; i < 30; i++) { const it = cmd(`i${i}`, [i % 2 ? 'read' : 'search']); started(a, it); done(a, it); }
    a.end('completed');
    expect(strip(text).split('\n').filter((l) => l.startsWith('  ✓ ')).length).toBeLessThanOrEqual(13);
    expect(strip(text)).toMatch(/… \d+ more steps/);
  });
});

describe('terminal compatibility', () => {
  it('NO_COLOR: no color escapes in the conversation; color mode adds them', () => {
    const a = mk({ live: false, color: false });
    a.begin('Thinking...'); a.end('completed');
    expect(text).not.toContain('\x1b');
    const c = mk({ live: false, color: true });
    text = ''; c.begin('Thinking...'); c.end('completed');
    expect(text).toMatch(/\x1b\[3\dm/);
  });
  it('non-TTY: no timers, no escape sequences, plain readable lines', () => {
    const a = mk({ live: false });
    a.begin('Thinking...');
    expect(vi.getTimerCount()).toBe(0);
    a.text('hello\n');
    started(a, cmd('1', ['read'])); done(a, cmd('1', ['read']));
    a.pause(); a.resume();
    a.end('completed');
    expect(text).not.toContain('\x1b');
    expect(text).toBe('◆ Lumina\n  hello\n\n  ✓ Read 1 file\n\n  ✓ Completed in 0s\n\n');
  });
});

describe('notices (auto-approval feedback)', () => {
  it('prints on its own row above the region while the spinner keeps running', () => {
    const a = mk();
    a.begin('Running command...');
    a.text('partial');
    a.notice('✓ Auto-approved: go test ./...');
    vi.advanceTimersByTime(250);
    const lines = snap().split('\n');
    expect(lines).toContain('  partial');
    expect(lines).toContain('  ✓ Auto-approved: go test ./...');
    const spin = lines.findIndex((l) => /Running command\.\.\. 0s/.test(l));
    expect(spin).toBeGreaterThan(lines.indexOf('  ✓ Auto-approved: go test ./...'));
    a.end('completed');
  });
});

describe('execution states with details (from events only)', () => {
  const mkCwd = (animate = true) => {
    screen = new Screen(out, { live: true, color: false });
    return new Activity(screen, { animate, color: false, cwd: '/repo' });
  };
  it('model-side states show the routed model; tool states show the command / files / tool instead', () => {
    const a = mkCwd();
    a.model = 'Model: GPT-6 Luna · Reasoning: Medium';
    a.begin('Preparing...');
    expect(snap()).toMatch(/◐ Preparing\.\.\. 0s/);
    expect(snap()).not.toContain('Model:'); // not working on the model yet
    a.event('turn/started', {});
    expect(snap()).toMatch(/Thinking\.\.\. 0s\n {4}Model: GPT-6 Luna · Reasoning: Medium/);
    started(a, cmd('t', ['unknown'], { command: "/bin/zsh -lc 'npm test'" }));
    expect(snap()).toMatch(/Running tests\.\.\. 0s\n {4}npm test\n/);
    a.event('item/completed', { item: { type: 'commandExecution', id: 't', commandActions: [{ type: 'unknown' }], status: 'completed', exitCode: 1, command: 'npm test' } });
    expect(snap()).toMatch(/Thinking\.\.\. 0s\n {4}Model: GPT-6 Luna/);
    started(a, { item: { type: 'fileChange', id: 'f', changes: [{ path: '/repo/src/auth/service.ts' }, { path: '/repo/src/auth/x.ts' }] } });
    expect(snap()).toMatch(/Editing files\.\.\. 0s\n {4}src\/auth\/service\.ts \(\+1 more\)/);
    done(a, { item: { type: 'fileChange', id: 'f', changes: [{}, {}] } });
    started(a, { item: { type: 'mcpToolCall', id: 'm', server: 'lumina-mcp', tool: 'get_jira_ticket' } });
    expect(snap()).toMatch(/Calling tool\.\.\. 0s\n {4}lumina-mcp › get_jira_ticket/);
    done(a, { item: { type: 'mcpToolCall', id: 'm' } });
    a.end('completed');
    const t = strip(text);
    expect(t).toContain('✗ Tests failed (exit 1)');
    expect(t).toContain('✓ Edited 2 files');
    expect(snap()).not.toMatch(/Model:|npm test\n.*\n?─/); // status rows gone after the turn
  });
  it('approval stops the animation at once and shows a static waiting row; resume restarts it', () => {
    const a = mkCwd();
    a.begin('Running command...');
    a.pause();
    expect(vi.getTimerCount()).toBe(0);
    expect(snap()).toContain('! Waiting for approval · 0s');
    expect(snap()).not.toMatch(/[◐◓◑◒]/);
    a.resume();
    expect(vi.getTimerCount()).toBe(1);
    expect(snap()).toMatch(/[◐◓◑◒] Running command\.\.\./);
    a.pause();
    a.end('cancelled');
    expect(vi.getTimerCount()).toBe(0);
    expect(snap()).not.toContain('Waiting for approval');
  });
  it('reduced motion: static ●, repainted only when the clock changes (no idle redraws)', () => {
    const a = mkCwd(false);
    a.begin('Thinking...');
    expect(snap()).toContain('● Thinking... 0s');
    const len = text.length;
    vi.advanceTimersByTime(900);
    screen.flush();
    expect(text.length).toBe(len); // same content: nothing written
    vi.advanceTimersByTime(200);
    expect(snap()).toContain('● Thinking... 1s');
    a.setLabel('Thinking...'); // same state again: no repaint
    const len2 = text.length;
    screen.flush();
    expect(text.length).toBe(len2);
    a.end('failed', 'boom');
    expect(vi.getTimerCount()).toBe(0);
    expect(snap()).toContain('✗ Failed after 1s');
  });
  it('streamed chunks are written once, split anywhere (even mid-word and mid-line)', () => {
    const a = mkCwd();
    a.begin('Thinking...');
    for (const c of ['Hel', 'lo wo', 'rld\nsec', 'ond line', '\n']) a.text(c);
    a.end('completed');
    const t = snap();
    expect(t.match(/Hello world/g)).toHaveLength(1);
    expect(t.match(/second line/g)).toHaveLength(1);
  });
  it('resize re-fits both status rows to the new width', () => {
    const a = mkCwd();
    a.begin('Running tests...');
    started(a, cmd('t', ['unknown'], { command: `npm test -- ${'x'.repeat(80)}` }));
    out.columns = 30;
    a.refresh();
    const rows = snap().split('\n').filter((l) => /Running tests|npm test/.test(l)).slice(-2);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(29);
    a.end('completed');
  });
});
