/* eslint-disable no-control-regex */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Composer, Editor, MAX_ROWS, layout, locate } from '../../src/lumina/tui/composer.js';
import { Key, KeyParser } from '../../src/lumina/tui/keys.js';

const names = (ks: Key[]) => ks.map((k) => (k.t === 'key' ? k.name : `${k.t}:${k.s}`));
const parse = (...chunks: string[]) => { const p = new KeyParser(); return chunks.flatMap((c) => p.feed(c)); };

describe('KeyParser', () => {
  it('Enter submits; Shift/Option/Ctrl+Enter variants; Ctrl+J newline', () => {
    expect(names(parse('\r'))).toEqual(['submit']);
    expect(names(parse('\x1b[13;2u'))).toEqual(['newline']); // Shift+Enter (kitty)
    expect(names(parse('\x1b[27;2;13~'))).toEqual(['newline']); // Shift+Enter (modifyOtherKeys)
    expect(names(parse('\x1b[13;3u'))).toEqual(['newline']); // Alt+Enter (kitty)
    expect(names(parse('\x1b\r'))).toEqual(['newline']); // Option+Enter as ESC CR
    expect(names(parse('\x1b[13;5u'))).toEqual(['submit']); // Ctrl+Enter
    expect(names(parse('\n'))).toEqual(['newline']); // Ctrl+J
  });
  it('Ctrl keys, including their CSI-u encodings', () => {
    expect(names(parse('\x03', '\x04'))).toEqual(['interrupt', 'eof']);
    expect(names(parse('\x1b[99;5u', '\x1b[100;5u'))).toEqual(['interrupt', 'eof']);
    expect(names(parse('\x01\x05\x0b\x15\x17'))).toEqual(['home', 'end', 'kill-line-end', 'kill-line-start', 'kill-word']);
  });
  it('arrows, home/end, delete, backspace, word moves', () => {
    expect(names(parse('\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F\x1b[3~\x7f\x1b[1;5C\x1bb\x1bf'))).toEqual(
      ['up', 'down', 'right', 'left', 'home', 'end', 'delete', 'backspace', 'word-right', 'word-left', 'word-right']);
    expect(names(parse('\x1bOH\x1bOF\x1b[1~\x1b[4~'))).toEqual(['home', 'end', 'home', 'end']);
  });
  it('bracketed paste is one event with newlines and indentation preserved, even split across chunks', () => {
    expect(names(parse('\x1b[200~a\r\n  b\n\tc\x1b[201~'))).toEqual(['paste:a\n  b\n  c']);
    expect(names(parse('\x1b[200~one\ntw', 'o\x1b[2', '01~'))).toEqual(['paste:one\ntwo']);
  });
  it('unmarked multi-line paste is a paste; a typed line + Enter is a submit', () => {
    expect(names(parse('x\ry\r'))).toEqual(['paste:x\ny\n']);
    expect(names(parse('hi\r'))).toEqual(['text:hi', 'submit']);
  });
  it('splits escape sequences arriving in pieces and ignores lone Escape / unknown sequences', () => {
    expect(names(parse('\x1b[', 'A'))).toEqual(['up']);
    expect(names(parse('\x1b'))).toEqual(['escape']); // lone Escape key
    expect(names(parse('\x1b[5~'))).toEqual([]);
  });
  it('line mode (non-TTY): every line submits, no escape handling', () => {
    const p = new KeyParser(true);
    expect(names(p.feed('one\ntwo\r\n'))).toEqual(['text:one', 'submit', 'text:two', 'submit', 'submit']);
  });
});

describe('Editor + layout', () => {
  it('edits across lines: backspace joins, delete, vertical moves keep column', () => {
    const e = new Editor();
    e.insert('hello\nworld!\nx');
    const rows = () => layout(e.value, 40);
    e.vertical(rows(), -1); // from col 1 on "x" to line "world!"
    expect(locate(rows(), e.cursor)).toEqual({ row: 1, col: 1 });
    e.cursor = 6 + 5; e.move(0); // end of "world"; reset the remembered column
    e.vertical(rows(), -1); // "hello" is 5 long → col 5 (end)
    expect(locate(rows(), e.cursor)).toEqual({ row: 0, col: 5 });
    e.vertical(rows(), 1);
    expect(locate(rows(), e.cursor)).toEqual({ row: 1, col: 5 }); // preferred column remembered
    e.cursor = 6; e.backspace(); // at start of line 2 → joins with line 1
    expect(e.value).toBe('helloworld!\nx');
    e.del();
    expect(e.value).toBe('helloorld!\nx');
  });
  it('home/end, word moves and kills', () => {
    const e = new Editor();
    e.insert('foo bar baz');
    e.wordMove(-1); expect(e.cursor).toBe(8);
    e.killWord(); expect(e.value).toBe('foo baz');
    e.home(layout(e.value, 40)); expect(e.cursor).toBe(0);
    e.end(layout(e.value, 40)); expect(e.cursor).toBe(7);
    e.killLineStart(); expect(e.value).toBe('');
  });
  it('wraps long lines and keeps the cursor on the right visual row', () => {
    const rows = layout('abcdefghij', 4);
    expect(rows.map((r) => [r.start, r.end])).toEqual([[0, 4], [4, 8], [8, 10]]);
    expect(locate(rows, 4)).toEqual({ row: 1, col: 0 });
    expect(locate(rows, 10)).toEqual({ row: 2, col: 2 });
  });
});

describe('Composer view', () => {
  const mk = (columns = 20) => {
    const input = new PassThrough();
    const out = Object.assign(new PassThrough(), { columns, isTTY: true }) as unknown as NodeJS.WriteStream;
    let text = '';
    out.on('data', (d) => { text += d.toString(); });
    const submitted: string[] = [];
    let changes = 0;
    const c = new Composer(input, out, { onSubmit: (t) => { submitted.push(t); return true; }, onInterrupt: () => undefined, onEof: () => undefined, onChange: () => { changes++; } }, true);
    return { c, input, submitted, text: () => text, changes: () => changes, columns, out };
  };
  const type = (c: Composer, s: string) => c.handle(new KeyParser().feed(s));
  const nl = (c: Composer) => c.handle([{ t: 'key', name: 'newline' }]);

  it('submits the exact multi-line text; backslash+Enter inserts a newline', () => {
    const { c, submitted } = mk();
    type(c, 'a\\');
    c.handle([{ t: 'key', name: 'submit' }]);
    type(c, 'b');
    expect(c.text).toBe('a\nb');
    c.handle([{ t: 'key', name: 'submit' }]);
    expect(submitted).toEqual(['a\nb']);
    expect(c.isEmpty).toBe(true);
  });
  it('rejected submits keep the draft', () => {
    const input = new PassThrough();
    const out = Object.assign(new PassThrough(), { columns: 20, isTTY: true }) as unknown as NodeJS.WriteStream;
    const c = new Composer(input, out, { onSubmit: () => false, onInterrupt: () => undefined, onEof: () => undefined }, true);
    type(c, 'keep me');
    c.handle([{ t: 'key', name: 'submit' }]);
    expect(c.text).toBe('keep me');
  });
  it('paints nothing itself and reports changes for the Screen to repaint', () => {
    const { c, text, changes } = mk();
    const before = text().length;
    type(c, 'hello');
    expect(text().length).toBe(before);
    expect(changes()).toBeGreaterThan(0);
  });
  it('shows a placeholder only while empty', () => {
    const { c } = mk(40);
    c.setPlaceholder('Ask Lumina anything...');
    expect(c.view(40).rows).toEqual(['› Ask Lumina anything...']);
    expect(c.view(40).cursor).toEqual({ row: 0, col: 2 });
    type(c, 'x');
    expect(c.view(40).rows).toEqual(['› x']);
  });
  it('grows with content up to 8 rows, then scrolls internally keeping the cursor visible', () => {
    const { c } = mk(30);
    for (let i = 1; i <= 3; i++) { type(c, `line${i}`); nl(c); }
    expect(c.view(30).rows).toHaveLength(4);
    for (let i = 4; i <= 14; i++) { type(c, `line${i}`); nl(c); }
    type(c, 'end');
    let v = c.view(30);
    expect(v.rows).toHaveLength(MAX_ROWS);
    expect(v.rows.at(-1)).toBe('  end');
    expect(v.rows.join('\n')).not.toContain('line1\n');
    expect(v.cursor.row).toBe(MAX_ROWS - 1);
    for (let i = 0; i < 20; i++) c.handle([{ t: 'key', name: 'up' }]);
    v = c.view(30);
    expect(v.rows[0]).toBe('› line1');
    expect(v.rows).toHaveLength(MAX_ROWS);
    expect(v.total).toBe(15);
  });
  it('wraps at the terminal width without exceeding it, and re-wraps when the width changes (draft kept)', () => {
    const { c } = mk(12);
    type(c, 'abcdefghijklmnopqrstuvwxyz');
    let v = c.view(12);
    expect(v.rows.every((r) => r.length <= 12)).toBe(true);
    expect(v.rows).toHaveLength(Math.ceil(26 / 9));
    v = c.view(40);
    expect(v.rows).toEqual(['› abcdefghijklmnopqrstuvwxyz']);
    expect(c.text).toBe('abcdefghijklmnopqrstuvwxyz');
  });
  it('stash/restore keeps the draft across an approval answer', () => {
    const { c } = mk();
    type(c, 'draft');
    c.stash();
    expect(c.isEmpty).toBe(true);
    type(c, 'y');
    c.restore();
    expect(c.text).toBe('draft');
  });
  it('start/stop toggle terminal modes (bracketed paste, modified keys) and remove listeners', () => {
    const { c, input, text } = mk();
    c.start();
    expect(text()).toContain('\x1b[?2004h');
    expect(input.listenerCount('data')).toBe(1);
    c.stop();
    expect(text()).toContain('\x1b[?2004l');
    expect(input.listenerCount('data')).toBe(0);
  });
});
