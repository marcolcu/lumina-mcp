import type { ChangedFile } from '../diff.js';
import type { Key } from './keys.js';

export interface DiffPaint { add(s: string): string; del(s: string): string; hunk(s: string): string; head(s: string): string; dim(s: string): string; accent(s: string): string }
export type DiffAction = { type: 'consumed' } | { type: 'close' } | { type: 'open'; file: ChangedFile };

const SECTION_TITLE = { staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked' } as const;
const STATUS = (f: ChangedFile) => (f.status === 'R' && f.origPath ? `R ${f.origPath} → ${f.path}` : `${f.status} ${f.path}`);
const stats = (f: ChangedFile) => (f.binary ? 'binary' : `${f.added === null ? '' : `+${f.added}`}${f.removed ? ` −${f.removed}` : ''}`.trim() || '—');

/**
 * Read-only viewer: a file list (staged / unstaged / untracked) and a scrollable per-file diff.
 * Pure state + rendering; the TUI loads diffs on `open` and paints `rows()` in the region above the input.
 */
export class DiffViewer {
  index = 0;
  file?: ChangedFile;
  lines: string[] = [];
  truncated = false;
  top = 0;
  loading = false;
  error?: string;
  constructor(readonly files: ChangedFile[]) {}

  showDiff(file: ChangedFile, lines: string[], truncated: boolean): void { this.file = file; this.lines = lines; this.truncated = truncated; this.top = 0; this.loading = false; }

  handle(k: Key, pageSize: number): DiffAction {
    if (k.t !== 'key') return { type: 'consumed' }; // typing does nothing in the viewer
    const page = Math.max(1, pageSize - 1);
    if (this.file) {
      const max = Math.max(0, this.lines.length - pageSize);
      switch (k.name) {
        case 'down': this.top = Math.min(max, this.top + 1); break;
        case 'up': this.top = Math.max(0, this.top - 1); break;
        case 'page-down': case 'tab': this.top = Math.min(max, this.top + page); break;
        case 'page-up': this.top = Math.max(0, this.top - page); break;
        case 'home': this.top = 0; break;
        case 'end': this.top = max; break;
        case 'escape': case 'left': case 'backspace': this.file = undefined; this.lines = []; break;
        case 'interrupt': case 'eof': return { type: 'close' };
      }
      return { type: 'consumed' };
    }
    const n = this.files.length;
    switch (k.name) {
      case 'down': if (n) this.index = (this.index + 1) % n; break;
      case 'up': if (n) this.index = (this.index + n - 1) % n; break;
      case 'page-down': this.index = Math.min(n - 1, this.index + page); break;
      case 'page-up': this.index = Math.max(0, this.index - page); break;
      case 'home': this.index = 0; break;
      case 'end': this.index = Math.max(0, n - 1); break;
      case 'submit': case 'right': return n && !this.loading ? { type: 'open', file: this.files[this.index] } : { type: 'consumed' };
      case 'escape': case 'interrupt': case 'eof': return { type: 'close' };
    }
    return { type: 'consumed' };
  }

  /** Rows for a region `width` wide and at most `height` rows tall (header included). */
  rows(width: number, height: number, p: DiffPaint): string[] {
    const fit = (s: string) => (s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s);
    if (this.file) {
      const f = this.file;
      const body = Math.max(1, height - 1);
      const end = Math.min(this.lines.length, this.top + body);
      const head = `  ${STATUS(f)} · ${f.section} · ${stats(f)}${this.lines.length > body ? ` · ${this.top + 1}–${end}/${this.lines.length}` : ''}${this.truncated ? ' (truncated)' : ''} · ↑↓ PgUp/PgDn · Esc back`;
      const out = [p.head(fit(head))];
      if (!this.lines.length) out.push(p.dim(fit(f.binary ? '  Binary file — no text diff' : '  No textual changes (mode or rename only)')));
      for (const raw of this.lines.slice(this.top, end)) {
        const l = fit(raw.replace(/\t/g, '  '));
        out.push(/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(raw) ? p.dim(l)
          : raw.startsWith('@@') ? p.hunk(l)
            : raw.startsWith('+') ? p.add(l)
              : raw.startsWith('-') ? p.del(l)
                : raw.startsWith('Binary files') ? p.dim(l) : l);
      }
      return out;
    }
    const n = this.files.length;
    const total = this.files.reduce((a, f) => ({ add: a.add + (f.added ?? 0), del: a.del + (f.removed ?? 0) }), { add: 0, del: 0 });
    const out = [p.head(fit(`  Changes · ${n} file${n === 1 ? '' : 's'} · +${total.add} −${total.del} · read-only · ↑↓ Enter open · Esc close`))];
    if (this.error) return [...out, p.del(fit(`  ${this.error}`))];
    if (!n) return [...out, p.dim(fit('  No changes — the working tree matches HEAD.'))];
    if (this.loading) out[0] = p.head(fit('  Loading diff…'));
    // one row per file plus a title row per section; scroll so the selection stays visible
    type Row = { text: string; file?: number };
    const all: Row[] = [];
    let last: string | undefined;
    this.files.forEach((f, i) => {
      if (f.section !== last) { all.push({ text: p.dim(`  ${SECTION_TITLE[f.section]}`) }); last = f.section; }
      const s = stats(f);
      const name = STATUS(f);
      const room = Math.max(8, width - 6 - s.length);
      const label = name.length > room ? `…${name.slice(name.length - room + 1)}` : name.padEnd(room);
      all.push({ text: `  ${i === this.index ? '❯' : ' '} ${label}  ${s}`, file: i });
    });
    const body = Math.max(2, height - 1);
    const sel = all.findIndex((r) => r.file === this.index);
    const start = Math.max(0, Math.min(sel - body + 2, all.length - body));
    for (const r of all.slice(start, start + body)) {
      const t = fit(r.text);
      if (r.file === undefined) { out.push(t); continue; }
      const f = this.files[r.file];
      out.push(r.file === this.index ? p.accent(t) : f.status === 'D' ? p.del(t) : f.section === 'untracked' || f.status === 'A' ? p.add(t) : t);
    }
    return out;
  }
}
