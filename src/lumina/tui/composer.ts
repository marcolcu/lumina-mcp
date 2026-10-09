import { Key, KeyParser } from './keys.js';

export const MAX_ROWS = 8;
const WORD = /\S/;

export interface Row { start: number; end: number; last: boolean; }

/** Hard-wraps `value` at `width` columns. Row ranges exclude the '\n' separators. */
export function layout(value: string, width: number): Row[] {
  const rows: Row[] = [];
  let off = 0;
  for (const line of value.split('\n')) {
    if (line.length === 0) rows.push({ start: off, end: off, last: true });
    else for (let i = 0; i < line.length; i += width) {
      const end = Math.min(i + width, line.length);
      rows.push({ start: off + i, end: off + end, last: end === line.length });
    }
    off += line.length + 1;
  }
  return rows;
}

/** A cursor at the end of a wrapped (non-final) row belongs to the next row. */
export function locate(rows: Row[], cursor: number): { row: number; col: number } {
  const i = rows.findIndex((r) => r.start <= cursor && (cursor < r.end || (cursor === r.end && r.last)));
  const row = i < 0 ? rows.length - 1 : i;
  return { row, col: cursor - rows[row].start };
}

/** Text buffer + cursor. Newlines are ordinary characters, so editing across lines needs no special cases. */
export class Editor {
  value = '';
  cursor = 0;
  private want = -1; // preferred column for vertical movement

  set(value: string, cursor = value.length): void { this.value = value; this.cursor = cursor; this.want = -1; }
  clear(): void { this.set(''); }
  insert(s: string): void { this.value = this.value.slice(0, this.cursor) + s + this.value.slice(this.cursor); this.cursor += s.length; this.want = -1; }
  backspace(): void { if (this.cursor > 0) { this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor); this.cursor--; } this.want = -1; }
  del(): void { this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1); this.want = -1; }
  move(delta: number): void { this.cursor = Math.max(0, Math.min(this.value.length, this.cursor + delta)); this.want = -1; }
  private lineStart(): number { return this.value.lastIndexOf('\n', this.cursor - 1) + 1; }
  private lineEnd(): number { const i = this.value.indexOf('\n', this.cursor); return i < 0 ? this.value.length : i; }
  killLineStart(): void { const s = this.lineStart(); this.value = this.value.slice(0, s) + this.value.slice(this.cursor); this.cursor = s; this.want = -1; }
  killLineEnd(): void { this.value = this.value.slice(0, this.cursor) + this.value.slice(this.lineEnd()); this.want = -1; }
  private wordLeft(): number { let i = this.cursor; while (i > 0 && !WORD.test(this.value[i - 1])) i--; while (i > 0 && WORD.test(this.value[i - 1])) i--; return i; }
  killWord(): void { const i = this.wordLeft(); this.value = this.value.slice(0, i) + this.value.slice(this.cursor); this.cursor = i; this.want = -1; }
  wordMove(dir: -1 | 1): void {
    if (dir < 0) this.cursor = this.wordLeft();
    else { let i = this.cursor; while (i < this.value.length && !WORD.test(this.value[i])) i++; while (i < this.value.length && WORD.test(this.value[i])) i++; this.cursor = i; }
    this.want = -1;
  }
  home(rows: Row[]): void { this.cursor = rows[locate(rows, this.cursor).row].start; this.want = -1; }
  end(rows: Row[]): void { const r = rows[locate(rows, this.cursor).row]; this.cursor = r.last ? r.end : Math.max(r.start, r.end - 1); this.want = -1; }
  /** Moves by visual rows, keeping the preferred column. No-op at the first/last row. */
  vertical(rows: Row[], dir: -1 | 1): void {
    const { row, col } = locate(rows, this.cursor);
    const target = rows[row + dir];
    if (!target) return;
    if (this.want < 0) this.want = col;
    const max = target.last ? target.end - target.start : Math.max(0, target.end - target.start - 1);
    this.cursor = target.start + Math.min(this.want, max);
  }
}

export interface ComposerHandlers {
  /** Return false to keep the draft (e.g. a turn is running). */
  onSubmit(text: string): boolean;
  onInterrupt(): void;
  onEof(): void;
  /** The draft or cursor changed: repaint. */
  onChange?(): void;
  /** Gets every key first (e.g. an open menu); return true to consume it. */
  onKey?(k: Key): boolean;
}

type Input = NodeJS.ReadableStream & { setRawMode?(mode: boolean): unknown; isTTY?: boolean };
type Output = NodeJS.WriteStream;

const ENABLE = '\x1b[?2004h\x1b[>1u\x1b[>4;2m'; // bracketed paste, kitty keyboard (disambiguate), xterm modifyOtherKeys 2
const DISABLE = '\x1b[?2004l\x1b[<u\x1b[>4;0m';

/**
 * Multi-line input state + keyboard handling. It paints nothing itself: `view()` returns the visible rows and cursor
 * for the Screen's persistent bottom region. `keyMode` (raw TTY) decodes keys, bracketed paste and modified Enter;
 * otherwise input is plain lines.
 */
export class Composer {
  private readonly editor = new Editor();
  private readonly parser: KeyParser;
  private prompt = '› ';
  placeholder = '';
  private dimmer: (s: string) => string = (s) => s;
  private stashed?: { value: string; cursor: number };
  private top = 0;
  private started = false;
  private width = 77;
  private readonly onData = (d: Buffer | string) => this.handle(this.parser.feed(d.toString()));
  private readonly onEnd = () => this.handlers.onEof();
  private readonly onExit = () => this.stop();

  constructor(private readonly input: Input, private readonly out: Output, private readonly handlers: ComposerHandlers, private readonly keyMode = Boolean(out.isTTY)) {
    this.parser = new KeyParser(!this.keyMode);
  }

  get text(): string { return this.editor.value; }
  get isEmpty(): boolean { return this.editor.value.length === 0; }
  setDim(f: (s: string) => string): void { this.dimmer = f; }

  start(): void {
    if (this.started) return;
    this.started = true;
    (this.input as { setEncoding?: (e: string) => unknown }).setEncoding?.('utf8');
    if (this.keyMode) { this.input.setRawMode?.(true); this.out.write(ENABLE); process.once('exit', this.onExit); }
    this.input.on('data', this.onData);
    this.input.on('end', this.onEnd);
    (this.input as { resume?: () => void }).resume?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    process.off('exit', this.onExit);
    if (this.keyMode) { this.out.write(DISABLE); this.input.setRawMode?.(false); }
    (this.input as { pause?: () => void }).pause?.(); // let the event loop end (a flowing stdin keeps the process alive)
  }

  /** Approval answers use a fresh buffer; the user's draft is restored afterwards. */
  stash(): void { this.stashed = { value: this.editor.value, cursor: this.editor.cursor }; this.editor.clear(); this.top = 0; this.handlers.onChange?.(); }
  restore(): void { if (this.stashed) { this.editor.set(this.stashed.value, this.stashed.cursor); this.stashed = undefined; } this.top = 0; this.handlers.onChange?.(); }
  clear(): void { this.editor.clear(); this.top = 0; this.handlers.onChange?.(); }
  /** Replaces the whole draft (cursor at the end), e.g. with a chosen slash command. */
  replace(s: string): void { this.editor.set(s); this.top = 0; this.handlers.onChange?.(); }

  /** Inserts text at the cursor without submitting (e.g. a chosen `$skill`). */
  insertText(s: string): void { this.editor.insert(s); this.handlers.onChange?.(); }
  setPlaceholder(p: string): void { this.placeholder = p; this.handlers.onChange?.(); }

  // ---- input ------------------------------------------------------------------------------------
  private rows(): Row[] { return layout(this.editor.value, this.width); }

  handle(keys: Key[]): void {
    for (const k of keys) {
      if (this.handlers.onKey?.(k)) continue;
      if (k.t === 'text' || k.t === 'paste') this.editor.insert(k.s);
      else switch (k.name) {
        case 'submit': this.submit(); break;
        case 'newline': this.editor.insert('\n'); break;
        case 'tab': this.editor.insert('  '); break;
        case 'escape': break;
        case 'left': this.editor.move(-1); break;
        case 'right': this.editor.move(1); break;
        case 'up': this.editor.vertical(this.rows(), -1); break;
        case 'down': this.editor.vertical(this.rows(), 1); break;
        case 'home': this.editor.home(this.rows()); break;
        case 'end': this.editor.end(this.rows()); break;
        case 'backspace': this.editor.backspace(); break;
        case 'delete': this.editor.del(); break;
        case 'kill-line-start': this.editor.killLineStart(); break;
        case 'kill-line-end': this.editor.killLineEnd(); break;
        case 'kill-word': this.editor.killWord(); break;
        case 'word-left': this.editor.wordMove(-1); break;
        case 'word-right': this.editor.wordMove(1); break;
        case 'interrupt': this.handlers.onInterrupt(); break;
        case 'eof': if (this.isEmpty) this.handlers.onEof(); else this.editor.del(); break;
      }
    }
    this.handlers.onChange?.();
  }

  private submit(): void {
    const v = this.editor.value;
    const c = this.editor.cursor;
    // Backslash + Enter inserts a newline: a fallback for terminals that cannot report Shift+Enter.
    if (this.keyMode && c > 0 && v[c - 1] === '\\') { this.editor.backspace(); this.editor.insert('\n'); return; }
    this.editor.clear();
    this.top = 0;
    const accepted = this.handlers.onSubmit(v);
    if (!accepted && this.keyMode) this.editor.set(v, c);
  }

  /** Visible input rows (at most MAX_ROWS, scrolled to keep the cursor in view) for a terminal `columns` wide. */
  view(columns: number): { rows: string[]; cursor: { row: number; col: number }; total: number } {
    this.width = Math.max(4, columns - 3);
    const rows = this.rows();
    const { row, col } = locate(rows, this.editor.cursor);
    if (row < this.top) this.top = row;
    if (row >= this.top + MAX_ROWS) this.top = row - MAX_ROWS + 1;
    this.top = Math.max(0, Math.min(this.top, rows.length - MAX_ROWS));
    const vis = rows.slice(this.top, this.top + MAX_ROWS);
    const lines = vis.map((r, i) => (this.top + i === 0 ? this.prompt : '  ') + this.editor.value.slice(r.start, r.end));
    if (this.isEmpty && this.placeholder) lines[0] = this.prompt + this.dimmer(this.placeholder.slice(0, this.width));
    return { rows: lines, cursor: { row: row - this.top, col: col + 2 }, total: rows.length };
  }
}
