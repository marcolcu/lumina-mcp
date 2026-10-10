/* eslint-disable no-control-regex */
import { describe, expect, it } from 'vitest';
import { MarkdownLines, wrapLine } from '../../src/lumina/tui/text.js';

const tag = { bold: (s: string) => `<b>${s}</b>`, code: (s: string) => `<c>${s}</c>`, link: (s: string) => `<u>${s}</u>`, dim: (s: string) => `<d>${s}</d>` };
const ansi = { bold: (s: string) => `\x1b[1m${s}\x1b[22m`, code: (s: string) => `\x1b[36m${s}\x1b[39m`, link: (s: string) => `\x1b[4m${s}\x1b[24m`, dim: (s: string) => `\x1b[2m${s}\x1b[22m` };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('MarkdownLines', () => {
  it('styles bold, code, links, headings, bullets and quotes; keeps indentation', () => {
    const md = new MarkdownLines(tag);
    expect(md.render('  - **Arsitektur:** Go memakai `log/slog` dan [logging.md](/Users/x/docs/logging.md).')).toBe('  • <b>Arsitektur:</b> Go memakai <c>log/slog</c> dan <u>logging.md</u>.');
    expect(md.render('## Hasil')).toBe('<b>Hasil</b>');
    expect(md.render('> catatan')).toBe('<d>│ catatan</d>');
    expect(md.render('1. first')).toBe('1. first');
  });
  it('code spans and fenced blocks are never re-styled', () => {
    const md = new MarkdownLines(tag);
    expect(md.render('use `**not bold**` here')).toBe('use <c>**not bold**</c> here');
    expect(md.render('```ts')).toBe('<d>```ts</d>');
    expect(md.render('const x = **y**;')).toBe('<d>const x = **y**;</d>');
    expect(md.render('```')).toBe('<d>```</d>');
    expect(md.render('**after**')).toBe('<b>after</b>');
    md.render('```'); md.reset();
    expect(md.render('**reset**')).toBe('<b>reset</b>');
  });
});

describe('code blocks are copyable', () => {
  it('fenced code is emitted verbatim (no indent, no styling); the fence becomes a /copy header; blocks are captured', () => {
    const md = new MarkdownLines(tag);
    expect(md.format('  ```text', 2)).toEqual({ text: '  <d>text · /copy 1</d>' });
    expect(md.format('  fix(logging): redact **startup** config values', 2)).toEqual({ text: 'fix(logging): redact **startup** config values', verbatim: true });
    expect(md.format('      indented code', 2)).toEqual({ text: '    indented code', verbatim: true }); // code indentation preserved exactly
    expect(md.format('', 0)).toEqual({ text: '', verbatim: true });
    expect(md.format('  ```', 2)).toBeNull();
    expect(md.blocks).toEqual([{ lang: 'text', text: 'fix(logging): redact **startup** config values\n    indented code\n' }]);
    expect(md.format('  ```', 2)).toEqual({ text: '  <d>code · /copy 2</d>' });
    md.format('  x', 2);
    md.reset(); // an unclosed block at the end of a turn is still captured
    expect(md.blocks[1]).toEqual({ lang: '', text: 'x' });
    expect(md.format('  **after**', 2)).toEqual({ text: '  <b>after</b>' });
  });
});

describe('wrapLine', () => {
  it('short lines are untouched', () => { expect(wrapLine('  hello', 20)).toEqual(['  hello']); });
  it('wraps at word boundaries with a hanging indent under the text (bullets, prefixes, prompts)', () => {
    const lines = wrapLine('  • Privasi: log tidak merekam body, kredensial, token, cookie, atau error upstream mentah.', 40);
    expect(lines[0]).toBe('  • Privasi: log tidak merekam body,');
    for (const l of lines.slice(1)) expect(l.startsWith('    ')).toBe(true);
    expect(lines.every((l) => l.length <= 40)).toBe(true);
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('• Privasi: log tidak merekam body, kredensial, token, cookie, atau error upstream mentah.'.replace(/^/, ' ').replace(/^ /, '  ').replace(/\s+/g, ' '));
    expect(wrapLine('› a very long prompt line that needs wrapping here', 24).slice(1).every((l) => l.startsWith('  '))).toBe(true);
  });
  it('hard-breaks words longer than the width', () => {
    const lines = wrapLine(`  ${'x'.repeat(50)}`, 20);
    expect(lines.every((l) => l.length <= 20)).toBe(true);
    expect(lines.join('').replace(/\s/g, '')).toBe('x'.repeat(50));
  });
  it('ANSI-aware: escape codes do not count toward width, styles are closed at breaks and reopened after', () => {
    const md = new MarkdownLines(ansi);
    const line = md.render('  - **a bold phrase that keeps going for quite a while** then plain');
    const lines = wrapLine(line, 30);
    expect(lines.every((l) => strip(l).length <= 30)).toBe(true);
    expect(lines[0].endsWith('\x1b[0m')).toBe(true); // bold closed before the break
    expect(lines[1]).toMatch(/^ {4}\x1b\[1m/); // indent first, then bold reopened (indent not underlined/bold)
    expect(strip(lines.join(' '))).toContain('a bold phrase');
  });
});
