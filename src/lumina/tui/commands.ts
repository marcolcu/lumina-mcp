import type { Key } from './keys.js';

export interface CommandSpec {
  name: string;
  /** Argument hint shown after the name; commands with args complete with a trailing space. */
  args?: string;
  description: string;
  /** Shown in the hint line under the input. */
  hint?: boolean;
}

/** The single list of slash commands: dispatch, /help, hints and the palette all read from here. */
export const COMMANDS: CommandSpec[] = [
  { name: '/resume', args: '[n|id]', description: 'Resume a previous conversation' },
  { name: '/model', args: '[name|auto]', description: 'Select or change the active AI model', hint: true },
  { name: '/reasoning', args: '[level|auto]', description: 'Configure model reasoning effort', hint: true },
  { name: '/approval', args: '[manual|smart|auto|status]', description: 'Manage tool execution approvals', hint: true },
  { name: '/skills', args: '[filter]', description: 'Browse and use available skills', hint: true },
  { name: '/usage', description: 'View token usage and plan limits', hint: true },
  { name: '/new', description: 'Start a new conversation' },
  { name: '/help', description: 'Show available commands' },
  { name: '/exit', description: 'Exit Lumina' },
];

export const commandNames = (): string => COMMANDS.map((c) => c.name).join(' ');
export const helpText = (): string => {
  const w = Math.max(...COMMANDS.map((c) => `${c.name} ${c.args ?? ''}`.trim().length));
  return COMMANDS.map((c) => `${`${c.name} ${c.args ?? ''}`.trim().padEnd(w)}  ${c.description}`).join('\n');
};

/** Relevance: exact < prefix < substring < description < fuzzy subsequence; undefined = no match. */
function score(c: CommandSpec, q: string): number | undefined {
  const n = c.name.slice(1).toLowerCase();
  if (!q) return 0;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  if (c.description.toLowerCase().includes(q)) return 3;
  let i = 0;
  for (const ch of n) if (ch === q[i]) i++;
  return i === q.length ? 4 : undefined;
}

/** Text that is a command being typed: "/" + one token at the very start, single line, no arguments yet. */
const EDITING = /^\/[^\s/]*$/;

/**
 * Slash-command palette. Pure state, driven by the input text; `handle()` decides which keys it consumes
 * (only while open). Choosing a suggestion fills the input; executing stays a separate Enter.
 */
export class CommandPalette {
  index = 0;
  private text = '';
  private dismissed?: string; // Esc / accept hide the palette until the text changes

  constructor(private readonly commands: CommandSpec[] = COMMANDS) {}

  get open(): boolean { return EDITING.test(this.text) && this.dismissed !== this.text; }
  get matches(): CommandSpec[] {
    const q = this.text.slice(1).toLowerCase();
    const hits = this.commands
      .map((c, i) => ({ c, i, s: score(c, q) }))
      .filter((x): x is { c: CommandSpec; i: number; s: number } => x.s !== undefined);
    // once a name matches by prefix, description/fuzzy hits are noise: "/res" → /resume only
    const cutoff = hits.some((x) => x.s <= 1) ? 2 : 4;
    return hits.filter((x) => x.s <= cutoff).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.c);
  }
  get selected(): CommandSpec | undefined { return this.open ? this.matches[this.index] : undefined; }

  /** Call whenever the input changes. */
  update(text: string): void {
    if (text !== this.text) { this.text = text; this.index = 0; if (this.dismissed !== text) this.dismissed = undefined; }
  }

  /**
   * Returns the text to put in the input when a suggestion is accepted, `true` if the key was otherwise consumed,
   * or `false` to let the input handle it (typing, Backspace, Shift+Enter, Ctrl-C…).
   */
  handle(k: Key): string | boolean {
    if (!this.open || k.t !== 'key') return false;
    const n = this.matches.length;
    switch (k.name) {
      case 'down': if (n) this.index = (this.index + 1) % n; return true;
      case 'up': if (n) this.index = (this.index + n - 1) % n; return true;
      case 'escape': this.dismissed = this.text; return true;
      case 'tab':
      case 'submit': {
        const c = this.matches[this.index];
        if (!c) return k.name === 'tab'; // Enter with no match falls through (unknown command message)
        // Enter on an already complete command runs it; otherwise it only fills the input
        if (k.name === 'submit' && this.text === c.name) return false;
        const filled = c.args ? `${c.name} ` : c.name;
        this.dismissed = filled;
        this.text = filled;
        return filled;
      }
      default: return false;
    }
  }

  /** Inline panel rows, fitted to `width`; at most `maxRows` suggestions, scrolled to keep the selection visible. */
  rows(width: number, maxRows: number, paint: { accent(s: string): string; dim(s: string): string }): string[] {
    const m = this.matches;
    const fit = (s: string) => (s.length > width ? `${s.slice(0, Math.max(1, width - 1))}…` : s);
    const out = [paint.dim(fit('  Commands'))];
    if (!m.length) return [...out, paint.dim(fit('  No matching commands')), paint.dim(fit('  Esc Close'))];
    const visible = Math.max(1, maxRows);
    const start = Math.max(0, Math.min(this.index - visible + 1, m.length - visible)); // keeps the selection visible
    const nameW = Math.min(14, Math.max(...m.map((c) => c.name.length)));
    for (let i = start; i < Math.min(m.length, start + visible); i++) {
      const c = m[i];
      const sel = i === this.index;
      const line = fit(`  ${sel ? '❯' : ' '} ${c.name.padEnd(nameW)}  ${c.description}${c.args ? `  ${c.args}` : ''}`);
      out.push(sel ? paint.accent(line) : line);
    }
    if (m.length > visible) out.push(paint.dim(fit(`  ${this.index + 1}/${m.length}`)));
    out.push(paint.dim(fit('  ↑↓ Navigate · Tab/Enter Select · Esc Close')));
    return out;
  }
}
