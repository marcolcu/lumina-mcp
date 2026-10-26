import type { Key } from './keys.js';

export interface SessionItem { id: string; title: string; updatedAt: number /* unix seconds */ }
export type SessionPickerResult = 'consumed' | 'close' | 'select';

/** "just now", "5m ago", "3h ago", "yesterday", "4d ago", or a date for older activity. */
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const s = Math.max(0, Math.round(now / 1000 - unixSeconds));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: s > 300 * 86400 ? 'numeric' : undefined });
}

/**
 * Keyboard-driven list of saved conversations (Codex threads), newest first, filtered by title as you type.
 * Pure state: the TUI loads pages (`append`) when `wantsMore` is true and paints `rows()`.
 */
export class SessionPicker {
  filter = '';
  index = 0;
  loading = false;
  private items: SessionItem[] = [];
  constructor(first: SessionItem[] = [], public cursor: string | null = null, private readonly heading = 'Resume a conversation', private readonly action = 'resume', private readonly empty = 'No saved conversations in this directory yet — they are saved automatically as you chat.') { this.append(first, cursor); }

  /** Adds a page (deduplicated, kept sorted by last activity). */
  append(page: SessionItem[], cursor: string | null): void {
    const seen = new Set(this.items.map((i) => i.id));
    this.items.push(...page.filter((p) => !seen.has(p.id)));
    this.items.sort((a, b) => b.updatedAt - a.updatedAt);
    this.cursor = cursor;
    this.loading = false;
  }

  get total(): number { return this.items.length; }
  get matches(): SessionItem[] {
    const f = this.filter.toLowerCase();
    return f ? this.items.filter((i) => i.title.toLowerCase().includes(f)) : this.items;
  }
  get selected(): SessionItem | undefined { return this.matches[this.index]; }
  /** More pages exist and the user is near the end, or a filter found nothing in what is loaded. */
  get wantsMore(): boolean {
    if (!this.cursor || this.loading) return false;
    const m = this.matches.length;
    return m === 0 || this.index >= m - 3;
  }

  handle(k: Key): SessionPickerResult {
    const n = this.matches.length;
    if (k.t === 'text' || k.t === 'paste') { this.filter += k.s.replace(/\s+/g, ' ').trimStart(); this.index = 0; return 'consumed'; }
    switch (k.name) {
      case 'down': if (n) this.index = Math.min(n - 1, this.index + 1); return 'consumed'; // no wrap: the list grows downwards
      case 'up': this.index = Math.max(0, this.index - 1); return 'consumed';
      case 'home': this.index = 0; return 'consumed';
      case 'end': this.index = Math.max(0, n - 1); return 'consumed';
      case 'backspace': this.filter = this.filter.slice(0, -1); this.index = 0; return 'consumed';
      case 'kill-line-start': this.filter = ''; this.index = 0; return 'consumed';
      case 'submit': case 'tab': return this.selected ? 'select' : 'consumed';
      case 'escape': case 'interrupt': case 'eof': return 'close';
      default: return 'consumed';
    }
  }

  rows(width: number, maxRows: number, paint: { accent(s: string): string; dim(s: string): string }, now = Date.now()): string[] {
    const fit = (s: string, w = width) => (s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s);
    const m = this.matches;
    const head = `  ${this.heading}${this.total ? ` · ${m.length}${this.cursor ? '+' : ''}` : ''}${this.filter ? ` · filter: ${this.filter}` : ' · type to filter'} · ↑↓ · Enter ${this.action} · Esc cancel`;
    const out = [paint.dim(fit(head))];
    if (!m.length) {
      if (this.loading) out.push(paint.dim('  Loading…'));
      else if (!this.total) out.push(paint.dim(fit(`  ${this.empty}`)));
      else out.push(paint.dim(fit(`  Nothing matches "${this.filter}"`)));
      return out;
    }
    const visible = Math.max(1, maxRows);
    const start = Math.max(0, Math.min(this.index - visible + 1, m.length - visible));
    // ids are noise unless two conversations share a title
    const dup = new Set(m.map((i) => i.title).filter((t, i, a) => a.indexOf(t) !== i));
    for (let i = start; i < Math.min(m.length, start + visible); i++) {
      const it = m[i];
      const when = relativeTime(it.updatedAt, now);
      const title = `${it.title}${dup.has(it.title) ? ` [${it.id.slice(0, 8)}]` : ''}`;
      const room = Math.max(8, width - 4 - when.length - 2);
      const line = `  ${i === this.index ? '❯' : ' '} ${fit(title, room).padEnd(room)}  ${when}`;
      out.push(i === this.index ? paint.accent(fit(line)) : fit(line));
    }
    if (this.loading) out.push(paint.dim('  Loading more…'));
    else if (m.length > visible || this.cursor) out.push(paint.dim(fit(`  ${this.index + 1}/${m.length}${this.cursor ? '+' : ''}`)));
    return out;
  }
}
