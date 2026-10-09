/* eslint-disable no-control-regex */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Screen } from '../../src/lumina/tui/screen.js';
import { emulate } from './term.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
const mk = (columns = 40, live = true) => {
  const out = Object.assign(new PassThrough(), { columns }) as PassThrough & { columns: number };
  let text = '';
  out.on('data', (d) => { text += d.toString(); });
  const screen = new Screen(out, { live, color: false });
  return { screen, out, text: () => text, reset: () => { text = ''; } };
};
const view = (rows: string[], row = 0, col = 2) => ({ rows, cursor: { row, col } });

describe('Screen persistent region', () => {
  it('draws separator / input / separator / footer, and the cursor ends inside the input row', () => {
    const { screen, text } = mk(30);
    screen.setInput(view(['› hello']));
    screen.setFooter(['  ◉ Auto Routing · GPT-6 Luna · Medium', '  /model  /reasoning  /approval']);
    screen.flush();
    const lines = strip(text()).split('\n');
    expect(lines).toEqual(['─'.repeat(29), '› hello', '─'.repeat(29), '  ◉ Auto Routing · GPT-6 Luna · Medium', '  /model  /reasoning  /approval']);
    expect(text()).toMatch(/\x1b\[3A\r\x1b\[3G\x1b\[\?25h$/); // cursor moved up from the last row to the input row, column 3
    expect(screen.rowCount).toBe(5);
  });
  it('input grows downward without redrawing unchanged rows', () => {
    const { screen, text, reset } = mk(30);
    screen.setInput(view(['› a']));
    screen.setFooter(['  status']);
    screen.flush();
    const before = text();
    reset();
    screen.setInput(view(['› a', '  b'], 1, 3));
    screen.flush();
    const t = strip(text());
    expect(t).toContain('  b');
    expect(t).not.toContain('› a'); // unchanged rows above the change are not rewritten
    expect(emulate(`${before}${text()}`)).toEqual(['─'.repeat(29), '› a', '  b', '─'.repeat(29), '  status']);
    expect(screen.rowCount).toBe(5);
  });
  it('streaming: the open line shows above the composer, committed lines go above the region, composer stays at the bottom', () => {
    const { screen, text } = mk(40);
    screen.setInput(view(['› draft']));
    screen.setFooter(['  footer']);
    screen.flush();
    screen.write('Hello wor');
    screen.flush();
    expect(emulate(text())).toEqual(['Hello wor', '─'.repeat(39), '› draft', '─'.repeat(39), '  footer']);
    screen.write('ld\nnext');
    screen.flush();
    expect(emulate(text())).toEqual(['Hello world', 'next', '─'.repeat(39), '› draft', '─'.repeat(39), '  footer']);
    screen.write(' line\n');
    screen.flush();
    expect(emulate(text())).toEqual(['Hello world', 'next line', '─'.repeat(39), '› draft', '─'.repeat(39), '  footer']);
  });
  it('the composer survives long streams: history accumulates above, the region stays intact at the bottom', () => {
    const { screen, text } = mk(40);
    screen.setInput(view(['› typing…'], 0, 10));
    screen.setFooter(['  footer']);
    for (let i = 0; i < 30; i++) { screen.write(`row ${i}\n`); screen.flush(); }
    const rows = emulate(text());
    expect(rows.slice(0, 30)).toEqual(Array.from({ length: 30 }, (_, i) => `row ${i}`));
    expect(rows.slice(30)).toEqual(['─'.repeat(39), '› typing…', '─'.repeat(39), '  footer']);
  });
  it('batches many writes in one tick into a single repaint', () => {
    const { screen, out } = mk();
    let writes = 0;
    out.on('data', () => { writes++; });
    screen.setInput(view(['› ']));
    screen.flush();
    writes = 0;
    return Promise.resolve().then(() => {
      for (let i = 0; i < 50; i++) screen.write(`line ${i}\n`);
      return new Promise<void>((r) => setTimeout(r, 5));
    }).then(() => { expect(writes).toBe(1); });
  });
  it('applies the prefix at the start of each conversation line; blank lines stay blank', () => {
    const { screen, text } = mk();
    screen.prefix = '  ';
    screen.write('a\n\nb\n');
    screen.flush();
    expect(strip(text()).split('\n').slice(0, 3)).toEqual(['  a', '', '  b']);
  });
  it('commits very long unbroken lines in terminal-wide pieces so the region stays small', () => {
    const { screen } = mk(20);
    screen.write('word '.repeat(60));
    screen.flush();
    expect(screen.rowCount).toBeLessThanOrEqual(3 + 3 + 3 + 3);
  });
  it('resize: erases by the re-wrapped height, repaints at the new width, keeps the draft', () => {
    const { screen, out, text, reset } = mk(30);
    screen.setInput(view(['› hello world draft here'], 0, 24));
    screen.setFooter(['  footer']);
    screen.flush();
    (out as unknown as { columns: number }).columns = 10;
    reset();
    screen.setInput(view(['› hello'], 0, 7));
    screen.onResize();
    const raw = text();
    expect(raw).toMatch(/^\x1b\[\d+A\r\x1b\[J/); // moved up over the (re-wrapped) old rows and cleared
    expect(emulate(raw)).toEqual(['─'.repeat(10), '› hello', '─'.repeat(10), '  footer']); // 10 = minimum region width
  });
  it('stop leaves the terminal clean: region erased, pending text committed, cursor shown, no later writes', () => {
    const { screen, text, reset } = mk();
    screen.setInput(view(['› ']));
    screen.flush();
    screen.write('tail');
    reset();
    screen.stop();
    expect(strip(text())).toBe('tail\n');
    expect(text()).toContain('\x1b[?25h');
    reset();
    screen.write('x'); screen.setStatus('y'); screen.flush();
    expect(text()).toBe('');
  });
});

describe('Screen plain (non-TTY) mode', () => {
  it('writes sequentially with no escape sequences and ignores the live region', () => {
    const { screen, text } = mk(40, false);
    screen.setInput(view(['› x']));
    screen.setFooter(['f']);
    screen.setStatus('status');
    screen.prefix = '  ';
    screen.write('one\ntw');
    screen.write('o\n');
    screen.flush();
    expect(text()).toBe('  one\n  two\n');
    expect(screen.live).toBe(false);
  });
});
