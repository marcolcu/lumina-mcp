import { CodeBlock, MarkdownLines, Styler, wrapLine } from './text.js';

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visibleLength = (s: string): number => s.replace(ANSI, '').length;

/** What the input area wants drawn: its rows and where the cursor sits inside them. */
export interface InputView { rows: string[]; cursor: { row: number; col: number } }

export interface ScreenOptions {
  /** Cursor-addressable terminal: draw the persistent bottom region. Otherwise plain sequential output. */
  live: boolean;
  color: boolean;
  /** Styles assistant Markdown in live mode (bold, code, links, bullets). */
  styler?: Styler;
}

const HIDE = '\x1b[?25l';
const SHOW = '\x1b[?25h';

/**
 * Owns the terminal. Conversation text is committed above a persistent bottom region
 * (streaming partial line, spinner, separator, input rows, separator, status bar); the terminal's own
 * scrollback holds the history, so mouse/keyboard scrolling and resize reflow are native.
 * The region is repainted row by row (only rows that changed), in a single write per render.
 */
export class Screen {
  /** Prepended to every conversation line (assistant text is indented). */
  prefix = '';
  private open = false; // a conversation line is in progress
  private partial = ''; // live mode: text of that line so far
  private pending: { text: string; md: boolean; prefix: number; reset?: boolean }[] = []; // live mode: completed lines waiting to be committed
  private openMd = false; // the open line is assistant Markdown
  private openPrefix = 0;
  private readonly md?: MarkdownLines;
  private status?: string;
  private overlay: string[] = [];
  private input: InputView = { rows: [''], cursor: { row: 0, col: 0 } };
  private footer: string[] = [];
  private prev: string[] = [];
  private curRow = 0;
  private curCol = 0;
  private scheduled = false;
  private stopped = false;

  constructor(private readonly out: NodeJS.WritableStream & { columns?: number }, private readonly opts: ScreenOptions) {
    if (opts.styler) this.md = new MarkdownLines(opts.styler);
  }

  /** Forget Markdown state (e.g. an unclosed code fence) between turns. */
  // queued, not immediate: lines already written but not yet rendered must still see the current fence state
  resetMarkdown(): void { if (this.opts.live) { this.pending.push({ text: '', md: false, prefix: 0, reset: true }); this.request(); } }

  /** Committed lines: Markdown styled (assistant text only) and word-wrapped with a hanging indent. */
  private format(lines: { text: string; md: boolean; prefix: number; reset?: boolean }[]): string[] {
    return lines.flatMap((l) => {
      if (l.reset) { this.md?.reset(); return []; }
      if (!l.md || !this.md) return wrapLine(l.text, this.width);
      const r = this.md.format(l.text, l.prefix);
      if (!r) return [];
      return r.verbatim ? [r.text] : wrapLine(r.text, this.width); // code: exact text, the terminal wraps it natively
    });
  }

  /** Fenced code blocks from assistant answers this session (live mode only). */
  get codeBlocks(): CodeBlock[] { return this.md?.blocks ?? []; }

  get live(): boolean { return this.opts.live; }
  get columns(): number { return this.out.columns || 80; }
  get atLineStart(): boolean { return !this.open; }
  get rowCount(): number { return this.prev.length; }
  private get width(): number { return Math.max(10, this.columns - 1); }

  dim(s: string): string { return this.opts.color ? `\x1b[2m${s}\x1b[0m` : s; }
  private rule(): string { return this.dim('─'.repeat(this.width)); }

  // ---- conversation ------------------------------------------------------------------------------
  write(text: string, opts: { markdown?: boolean } = {}): void {
    if (this.stopped || !text) return;
    const md = Boolean(opts.markdown);
    const clean = text.replace(/\r/g, '');
    if (!this.opts.live) {
      const lines = clean.split('\n');
      lines.forEach((chunk, i) => {
        if (chunk) { if (!this.open) { this.out.write(this.prefix); this.open = true; } this.out.write(chunk); }
        if (i < lines.length - 1) { this.out.write('\n'); this.open = false; }
      });
      return;
    }
    const parts = clean.split('\n');
    parts.forEach((chunk, i) => {
      if (chunk) {
        if (!this.open) { this.partial = this.prefix; this.open = true; this.openMd = md; this.openPrefix = this.prefix.length; }
        this.partial += chunk;
        // a very long unbroken status line is committed in terminal-wide pieces so the live region stays small
        // (assistant text is never split: code must stay copyable; its preview is clipped in compose())
        while (!this.openMd && visibleLength(this.partial) > this.width * 3) {
          const cut = this.partial.lastIndexOf(' ', this.width);
          const at = cut > this.prefix.length ? cut : this.width;
          this.pending.push({ text: this.partial.slice(0, at), md: this.openMd, prefix: this.openPrefix });
          this.partial = this.prefix + this.partial.slice(at).trimStart();
        }
      }
      if (i < parts.length - 1) { this.pending.push({ text: this.open ? this.partial : '', md: this.open ? this.openMd : md, prefix: this.open ? this.openPrefix : 0 }); this.partial = ''; this.open = false; }
    });
    this.request();
  }

  // ---- live region parts -------------------------------------------------------------------------
  setStatus(line: string | undefined): void { if (line !== this.status) { this.status = line; this.request(); } }
  setInput(view: InputView): void { this.input = view; this.request(); }
  /** A menu drawn between the status row and the input (e.g. the skills picker). */
  setOverlay(lines: string[] | undefined): void { this.overlay = lines ?? []; this.request(); }
  setFooter(lines: string[]): void { this.footer = lines; this.request(); }

  /** Fits a line to the terminal width (plain text only, no ANSI). */
  fit(s: string): string { return s.length > this.width ? `${s.slice(0, this.width - 1)}…` : s; }

  request(): void {
    if (!this.opts.live || this.stopped || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.render(); });
  }

  /** Synchronous repaint (tests, shutdown). */
  flush(): void { this.scheduled = false; this.render(); }

  private compose(): { rows: string[]; cursor: { row: number; col: number } } {
    const rows: string[] = [];
    if (this.open) {
      const parts: string[] = [];
      for (let i = 0; i < this.partial.length || i === 0; i += this.width) parts.push(this.partial.slice(i, i + this.width));
      rows.push(...parts.slice(-3)); // preview of the line being streamed: last 3 rows at most
    }
    if (this.status !== undefined) rows.push(this.status);
    rows.push(...this.overlay);
    rows.push(this.rule());
    const start = rows.length;
    rows.push(...this.input.rows);
    rows.push(this.rule());
    rows.push(...this.footer);
    return { rows, cursor: { row: start + this.input.cursor.row, col: this.input.cursor.col } };
  }

  private render(): void {
    if (!this.opts.live || this.stopped) return;
    let out = HIDE;
    let cur = this.curRow;
    const move = (r: number) => {
      if (r < cur) out += `\x1b[${cur - r}A`; else if (r > cur) out += `\x1b[${r - cur}B`;
      cur = r;
    };
    const committed = this.pending.length ? this.format(this.pending) : [];
    this.pending = [];
    if (committed.length) {
      // commit finished conversation lines above the region, then redraw the region fresh below them
      if (this.prev.length) { move(0); out += '\r\x1b[J'; }
      out += `${committed.join('\n')}\n`;
      this.prev = []; cur = 0;
    }
    const next = this.compose();
    const p = this.prev.length;
    const n = next.rows.length;
    if (p === 0) {
      out += next.rows.join('\n');
      cur = n - 1;
    } else {
      for (let i = 0; i < Math.min(n, p); i++) if (this.prev[i] !== next.rows[i]) { move(i); out += `\r\x1b[2K${next.rows[i]}`; }
      if (n > p) { move(p - 1); for (let i = p; i < n; i++) out += `\n${next.rows[i]}`; cur = n - 1; }
      else if (n < p) { move(n - 1); out += '\x1b[1B\r\x1b[J'; cur = n; }
    }
    // nothing to repaint and the cursor is already in place: write nothing
    if (out === HIDE && cur === next.cursor.row && this.curCol === next.cursor.col && this.prev.length === n) return;
    move(next.cursor.row);
    out += `\r\x1b[${next.cursor.col + 1}G${SHOW}`;
    this.prev = next.rows;
    this.curRow = cur;
    this.curCol = next.cursor.col;
    this.out.write(out);
  }

  /** Terminal resized: rows already drawn may have reflowed, so erase them by re-wrapped height and repaint. */
  onResize(): void {
    if (!this.opts.live || this.stopped) return;
    if (this.prev.length) {
      const cols = Math.max(1, this.columns);
      const phys = (s: string) => Math.max(1, Math.ceil(visibleLength(s) / cols));
      const above = this.prev.slice(0, this.curRow).reduce((a, r) => a + phys(r), 0) + Math.floor(this.curCol / cols);
      this.out.write(`${above > 0 ? `\x1b[${above}A` : ''}\r\x1b[J`);
      this.prev = []; this.curRow = 0;
    }
    this.flush();
  }

  /** Leaves the terminal clean: pending text is committed, the region erased, the cursor restored. */
  stop(): void {
    if (this.stopped) return;
    if (this.opts.live) {
      if (this.open) { this.pending.push({ text: this.partial, md: this.openMd, prefix: this.openPrefix }); this.partial = ''; this.open = false; }
      let out = '';
      if (this.prev.length) { out += `${this.curRow > 0 ? `\x1b[${this.curRow}A` : ''}\r\x1b[J`; }
      const committed = this.format(this.pending);
      if (committed.length) out += `${committed.join('\n')}\n`;
      this.out.write(out + SHOW);
      this.pending = []; this.prev = [];
    }
    this.stopped = true;
  }
}
