// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const strip = (s: string) => s.replace(ANSI, '');

export interface Styler { bold(s: string): string; code(s: string): string; link(s: string): string; dim(s: string): string }

/**
 * Minimal Markdown → terminal styling for assistant text, one completed line at a time:
 * **bold**, `code`, [text](url) → text, # headings, - bullets → •, ``` fences (dimmed, no inline styling).
 * Keeps the line's leading indentation. Stateful only for code fences.
 */
export interface CodeBlock { lang: string; text: string }

export class MarkdownLines {
  private fence = false;
  private current?: { lang: string; lines: string[] };
  /** Every fenced code block seen so far (exact content, for /copy). */
  readonly blocks: CodeBlock[] = [];
  constructor(private readonly s: Styler) {}
  reset(): void { this.closeBlock(); this.fence = false; }

  private closeBlock(): void {
    if (this.current) this.blocks.push({ lang: this.current.lang, text: this.current.lines.join('\n') });
    this.current = undefined;
  }

  /**
   * Line for the terminal. Fenced code is emitted VERBATIM (no indent, no wrapping, no styling) so it can be selected
   * and copied exactly; the opening fence becomes a small header naming the /copy index, the closing fence disappears.
   * Returns null for lines that are not shown.
   */
  format(line: string, prefixLength: number): { text: string; verbatim?: boolean } | null {
    const body = line.slice(prefixLength);
    const fence = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/.exec(body);
    if (fence && !this.fence) {
      this.fence = true;
      this.current = { lang: fence[2], lines: [] };
      return { text: `${line.slice(0, prefixLength)}${this.s.dim(`${fence[2] || 'code'} · /copy ${this.blocks.length + 1}`)}` };
    }
    if (fence && this.fence) { this.fence = false; this.closeBlock(); return null; }
    if (this.fence) { this.current?.lines.push(body); return { text: body, verbatim: true }; }
    return { text: this.render(line) };
  }

  render(line: string): string {
    const lead = /^\s*/.exec(line)![0];
    const body = line.slice(lead.length);
    if (/^(```|~~~)/.test(body)) { this.fence = !this.fence; return lead + this.s.dim(body); }
    if (this.fence) return lead + this.s.dim(body);
    let m = /^(#{1,6})\s+(.*)$/.exec(body);
    if (m) return lead + this.s.bold(this.inline(m[2]));
    m = /^[-*+]\s+(.*)$/.exec(body);
    if (m) return `${lead}• ${this.inline(m[1])}`;
    m = /^>\s?(.*)$/.exec(body);
    if (m) return `${lead}${this.s.dim(`│ ${m[1]}`)}`;
    return lead + this.inline(body);
  }

  private inline(t: string): string {
    // split out code spans first so their content is never re-styled
    return t.split(/(`[^`]+`)/).map((part) => {
      if (/^`[^`]+`$/.test(part)) return this.s.code(part.slice(1, -1));
      return part
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string) => this.s.link(text))
        .replace(/\*\*([^*]+)\*\*/g, (_, x: string) => this.s.bold(x))
        .replace(/__([^_]+)__/g, (_, x: string) => this.s.bold(x));
    }).join('');
  }
}

/**
 * Word-wraps one line (ANSI-aware) to `width` with a hanging indent: continuation lines align under the text after
 * the leading spaces and any list marker (•, -, 1., ›). Open styles are closed at each break and reopened after it.
 */
export function wrapLine(line: string, width: number): string[] {
  const plain = strip(line);
  if (plain.length <= width) return [line];
  const marker = /^(\s*)((?:[•\-*›]|\d+[.)])\s+)?/.exec(plain)![0].length;
  const indent = ' '.repeat(Math.min(marker, Math.floor(width / 2)));
  // cells: each visible char with the escape codes that precede it
  const cells: { pre: string; ch: string }[] = [];
  let pre = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') { const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i)); if (m) { pre += m[0]; i += m[0].length - 1; continue; } } // eslint-disable-line no-control-regex
    cells.push({ pre, ch: line[i] }); pre = '';
  }
  const tail = pre;
  const active: string[] = [];
  const track = (codes: string) => {
    for (const m of codes.matchAll(/\x1b\[([0-9;]*)m/g)) { // eslint-disable-line no-control-regex
      for (const n of (m[1] || '0').split(';').map(Number)) {
        if (n === 0) active.length = 0;
        else if (n === 22) remove((x) => x === 1 || x === 2);
        else if (n === 23) remove((x) => x === 3);
        else if (n === 24) remove((x) => x === 4);
        else if (n === 39) remove((x) => (x >= 30 && x <= 37) || (x >= 90 && x <= 97));
        else active.push(`\x1b[${n}m`);
      }
    }
  };
  const remove = (f: (n: number) => boolean) => { for (let i = active.length - 1; i >= 0; i--) if (f(Number(/\d+/.exec(active[i])![0]))) active.splice(i, 1); };

  const out: string[] = [];
  let start = 0;
  let first = true;
  while (start < cells.length) {
    const avail = first ? width : width - indent.length;
    let end = Math.min(cells.length, start + avail);
    if (end < cells.length) {
      let sp = -1;
      for (let i = end; i > start; i--) if (cells[i].ch === ' ') { sp = i; break; }
      if (sp > start) end = sp;
    }
    const reopen = first ? '' : active.join('');
    let s = '';
    for (let i = start; i < end; i++) { s += cells[i].pre + cells[i].ch; track(cells[i].pre); }
    if (end >= cells.length) s += tail;
    out.push(`${first ? '' : indent}${reopen}${s}${end < cells.length && active.length ? '\x1b[0m' : ''}`);
    first = false;
    start = end;
    while (start < cells.length && cells[start].ch === ' ') { track(cells[start].pre); start++; }
  }
  return out;
}
