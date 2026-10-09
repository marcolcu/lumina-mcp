import { describe, expect, it } from 'vitest';
import { COMMANDS, CommandPalette, helpText } from '../../src/lumina/tui/commands.js';
import { KeyParser } from '../../src/lumina/tui/keys.js';

const k = (s: string) => new KeyParser().feed(s)[0];
const UP = k('\x1b[A');
const DOWN = k('\x1b[B');
const ENTER = k('\r');
const TAB = k('\t');
const ESC = k('\x1b');
const plain = { accent: (s: string) => s, dim: (s: string) => s };
const names = (p: CommandPalette) => p.matches.map((c) => c.name);
const at = (text: string) => { const p = new CommandPalette(); p.update(text); return p; };

describe('CommandPalette matching', () => {
  it('"/" lists every registered command in registry order', () => {
    const p = at('/');
    expect(p.open).toBe(true);
    expect(names(p)).toEqual(COMMANDS.map((c) => c.name));
  });
  it('prefix, case-insensitive, exact before prefix before substring/description/fuzzy', () => {
    expect(names(at('/res'))).toEqual(['/resume']);
    expect(names(at('/MOD'))[0]).toBe('/model');
    expect(names(at('/re'))).toEqual(['/resume', '/reasoning']); // several prefix matches, registry order
    expect(names(at('/res'))).toEqual(['/resume']); // fuzzy "r-e-s" in /reasoning is dropped once a prefix matches
    expect(names(at('/new'))[0]).toBe('/new'); // exact first
    expect(names(at('/aprv'))).toEqual(['/approval']); // fuzzy subsequence
    expect(names(at('/token'))).toEqual(['/usage']); // description match
  });
  it('no matches for unknown input; only opens for a command token at the start of a single line', () => {
    expect(names(at('/zzz'))).toEqual([]);
    expect(at('/zzz').open).toBe(true);
    for (const t of ['', 'hello /model', ' /model', '/model gpt', 'fix the /api route', '/model\nmore', 'path/to/x', '/src/app.ts']) expect(at(t).open, JSON.stringify(t)).toBe(false);
  });
});

describe('CommandPalette keys', () => {
  it('arrows wrap around; Enter/Tab fill the input without executing; args get a trailing space', () => {
    const p = at('/');
    p.handle(UP);
    expect(p.selected?.name).toBe(COMMANDS.at(-1)!.name); // wrapped to last
    p.handle(DOWN);
    expect(p.selected?.name).toBe(COMMANDS[0].name); // wrapped to first
    p.handle(DOWN);
    expect(p.handle(ENTER)).toBe('/model ');
    expect(p.open).toBe(false); // closed after accepting
    const q = at('/us');
    expect(q.handle(TAB)).toBe('/usage');
    q.update('/usage');
    expect(q.open).toBe(false); // stays closed for the accepted text…
    expect(q.handle(ENTER)).toBe(false); // …so the second Enter reaches the input and executes
  });
  it('Enter on an already complete command lets it run; Enter with no match falls through', () => {
    expect(at('/usage').handle(ENTER)).toBe(false);
    expect(at('/zzz').handle(ENTER)).toBe(false);
    expect(at('/zzz').handle(TAB)).toBe(true);
  });
  it('Escape closes but keeps the text; typing again reopens; other keys are left to the input', () => {
    const p = at('/mo');
    expect(p.handle(ESC)).toBe(true);
    expect(p.open).toBe(false);
    p.update('/mod');
    expect(p.open).toBe(true);
    for (const key of [k('x'), k('\x7f'), k('\x1b[13;2u'), k('\x03'), k('\x1b[D')]) expect(p.handle(key)).toBe(false);
  });
  it('closed palette consumes nothing (arrow keys keep their normal meaning)', () => {
    const p = at('hello');
    expect(p.handle(UP)).toBe(false);
    expect(p.handle(DOWN)).toBe(false);
    expect(p.handle(ENTER)).toBe(false);
  });
});

describe('CommandPalette rendering', () => {
  it('shows name, description, args and the selected marker; footer hint', () => {
    const rows = at('/').rows(100, 8, plain);
    expect(rows[0]).toBe('  Commands');
    expect(rows[1]).toMatch(/^ {2}❯ \/resume\s+Resume a previous conversation {2}\[n\|id\]$/);
    expect(rows[2]).toMatch(/^ {4}\/model\s+Select or change the active AI model/);
    expect(rows.at(-1)).toBe('  ↑↓ Navigate · Tab/Enter Select · Esc Close');
  });
  it('narrow terminals: every row fits, the list scrolls and keeps the selection visible', () => {
    const p = at('/');
    for (let i = 0; i < 7; i++) p.handle(DOWN);
    const rows = p.rows(24, 3, plain);
    expect(rows.every((r) => r.length <= 24)).toBe(true);
    expect(rows.filter((r) => /^ {2}[❯ ] \//.test(r))).toHaveLength(3);
    expect(rows.find((r) => r.includes('❯'))).toContain(COMMANDS[7].name);
    expect(rows).toContain(`  8/${COMMANDS.length}`);
  });
  it('no matches → explicit message', () => {
    expect(at('/zzz').rows(80, 8, plain)).toContain('  No matching commands');
  });
  it('/help text comes from the same registry', () => {
    for (const c of COMMANDS) expect(helpText()).toContain(c.description);
  });
});
