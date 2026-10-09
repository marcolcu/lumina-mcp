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
    expect(snap()).toContain('◐ Thinking... (0s)');
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) { vi.advanceTimersByTime(100); seen.add(snap().match(/[◐◓◑◒] Thinking/g)?.at(-1)?.[0] ?? ''); }
    for (const f of ['◐', '◓', '◑', '◒']) expect(seen).toContain(f);
    expect(snap()).toContain('(2s)');
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
    expect(lines.indexOf('  partial answer done')).toBeLessThan(lines.lastIndexOf('  ◐ Thinking... (0s)'));
    a.end('completed');
  });
  it('a new activity after mid-line text starts on its own row', () => {
    const a = mk({ live: false });
    a.begin('Thinking...');
    a.text('let me check');
    started(a, cmd('1', ['read'])); done(a, cmd('1', ['read']));
    a.end('completed');
    expect(strip(text)).toContain('  let me check\n  ✓ Read 1 file\n');
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
    expect(text).toBe('◆ Lumina\n  hello\n  ✓ Read 1 file\n  ✓ Completed in 0s\n\n');
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
    const spin = lines.findIndex((l) => /Running command\.\.\. \(0s\)/.test(l));
    expect(spin).toBeGreaterThan(lines.indexOf('  ✓ Auto-approved: go test ./...'));
    a.end('completed');
  });
});
