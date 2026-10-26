import { describe, expect, it } from 'vitest';
import { KeyParser } from '../../src/lumina/tui/keys.js';
import { SessionPicker, relativeTime } from '../../src/lumina/tui/sessions.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const S = NOW / 1000;
const k = (s: string) => new KeyParser().feed(s)[0];
const plain = { accent: (s: string) => s, dim: (s: string) => s };
const item = (id: string, title: string, agoSec: number) => ({ id, title, updatedAt: S - agoSec });

describe('relativeTime', () => {
  it.each([[10, 'just now'], [300, '5m ago'], [7200, '2h ago'], [100000, 'yesterday'], [4 * 86400, '4d ago'], [20 * 86400, '20 Sept']])('%is → %s', (ago, out) => {
    expect(relativeTime(S - ago, NOW)).toBe(out);
  });
});

describe('SessionPicker', () => {
  const base = () => new SessionPicker([item('a1', 'Older', 7200), item('b2', 'Newest', 60), item('c3', 'Middle', 3600)], 'next');
  it('sorts by last activity and keeps pages deduplicated and sorted', () => {
    const p = base();
    expect(p.matches.map((i) => i.title)).toEqual(['Newest', 'Middle', 'Older']);
    p.append([item('b2', 'Newest', 60), item('d4', 'Even newer', 5)], null);
    expect(p.matches.map((i) => i.id)).toEqual(['d4', 'b2', 'c3', 'a1']);
    expect(p.cursor).toBeNull();
  });
  it('navigates without wrapping, filters by title, selects and closes', () => {
    const p = base();
    p.handle(k('\x1b[A')); expect(p.index).toBe(0);
    p.handle(k('\x1b[B')); p.handle(k('\x1b[B')); p.handle(k('\x1b[B')); expect(p.selected?.title).toBe('Older');
    for (const ch of 'mid') p.handle({ t: 'text', s: ch });
    expect(p.matches.map((i) => i.title)).toEqual(['Middle']);
    expect(p.handle(k('\r'))).toBe('select');
    expect(p.handle(k('\x1b'))).toBe('close');
    p.handle({ t: 'text', s: 'zzz' });
    expect(p.handle(k('\r'))).toBe('consumed'); // nothing to resume
  });
  it('asks for more pages near the end or when a filter finds nothing; not while loading or when exhausted', () => {
    const p = base();
    expect(p.wantsMore).toBe(true); // 3 items: already near the end
    p.loading = true; expect(p.wantsMore).toBe(false);
    p.append([], null); expect(p.wantsMore).toBe(false);
  });
  it('rows: title + time, ids only for duplicate titles, empty and no-match states, width-safe', () => {
    const p = new SessionPicker([item('aaaaaaaa1', 'Same', 60), item('bbbbbbbb2', 'Same', 120), item('c', 'A very long conversation title that keeps going and going', 300)], null);
    const rows = p.rows(50, 8, plain, NOW);
    expect(rows[1]).toMatch(/^ {2}❯ Same \[aaaaaaaa\]\s+1m ago$/);
    expect(rows.every((r) => r.length <= 50)).toBe(true);
    expect(new SessionPicker([], null).rows(80, 8, plain, NOW)[1]).toContain('No saved conversations in this directory yet');
    const q = new SessionPicker([item('x', 'alpha', 1)], null); q.filter = 'zz';
    expect(q.rows(80, 8, plain, NOW)[1]).toContain('Nothing matches "zz"');
  });
});
