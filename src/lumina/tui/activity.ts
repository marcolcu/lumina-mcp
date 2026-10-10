import { Screen } from './screen.js';

const FRAMES = ['◐', '◓', '◑', '◒'];
const MAX_COMMITTED = 12; // non-failure timeline lines per turn; the rest are folded away

type Kind = 'read' | 'search' | 'command' | 'edit' | 'tool' | 'web';
const LABEL: Record<Kind, string> = {
  read: 'Reading files...', search: 'Searching files...', command: 'Running command...',
  edit: 'Editing files...', tool: 'Calling tool...', web: 'Searching the web...',
};
export type EndStatus = 'completed' | 'failed' | 'cancelled';

interface Item {
  type: string; id?: string; status?: string; exitCode?: number | null;
  commandActions?: { type: string }[]; changes?: unknown[];
}

export interface ActivityOptions {
  /** Timer-driven spinner (live terminals only). Otherwise labels update on events and nothing ticks. */
  animate: boolean;
  color: boolean;
  intervalMs?: number;
}

/**
 * A turn's progress: spinner/status row, compact activity timeline, completion line. Output goes through the
 * Screen (so it can never overwrite the input area). All labels come from App Server events; nothing is invented.
 */
export class Activity {
  private t0 = 0;
  private active = false;
  private paused = false;
  private label = '';
  private frame = 0;
  private timer?: NodeJS.Timeout;
  private seenStarted = new Set<string>();
  private seenDone = new Set<string>();
  private running = 0;
  private group?: { kind: Kind; n: number };
  private committed = 0;
  private hidden = 0;

  constructor(private readonly screen: Screen, private readonly opts: ActivityOptions, private readonly now: () => number = Date.now) {}

  get atLineStart(): boolean { return this.screen.atLineStart; }
  get isActive(): boolean { return this.active; }
  get hasTimer(): boolean { return this.timer !== undefined; }

  // ---- colors -----------------------------------------------------------------------------------
  private paint(code: string, s: string): string { return this.opts.color ? `\x1b[${code}m${s}\x1b[0m` : s; }
  dim(s: string): string { return this.paint('2', s); }
  accent(s: string): string { return this.paint('36', s); }
  paintStatus(kind: 'ok' | 'bad' | 'warn', glyph: string): string { return this.paint(kind === 'ok' ? '32' : kind === 'bad' ? '31' : '33', glyph); }

  // ---- output -----------------------------------------------------------------------------------
  private elapsed(): string { return `${Math.floor((this.now() - this.t0) / 1000)}s`; }

  /** Prefix shown before the label, e.g. the running stage and its model. */
  context = '';

  private draw(): void {
    if (!this.screen.live) return;
    if (!this.active || this.paused) return this.screen.setStatus(undefined);
    const width = Math.max(10, this.screen.columns - 1) - 2;
    let line = `${FRAMES[this.frame]} ${this.context}${this.label} (${this.elapsed()})`;
    if (line.length > width) line = `${line.slice(0, width - 1)}…`;
    this.screen.setStatus(`  ${this.paint('36', line[0])}${line.slice(1)}`);
  }

  /** Streamed assistant text. */
  text(s: string): void {
    if (this.group && this.active) { if (!this.screen.atLineStart) this.screen.write('\n'); this.flushGroup(); } // finished tool steps precede the answer
    if (!s) return;
    // breathing room: a blank line between a block of status lines and the answer text
    if (this.last === 'line' && this.screen.atLineStart && s.trim()) this.screen.write('\n');
    if (s.trim()) this.last = 'text';
    this.screen.write(s, { markdown: this.active });
  }

  /** A self-contained block (e.g. an approval prompt): separated from what comes before and after. */
  block(s: string): void {
    if (!this.screen.atLineStart) this.screen.write('\n');
    if (this.last !== 'none') this.screen.write('\n');
    this.screen.write(s.endsWith('\n') ? s : `${s}\n`);
    this.last = 'line';
  }

  /** A permanent one-line notice (e.g. auto-approval) on its own row. */
  notice(line: string): void { this.commit(line); }

  private commit(line: string): void {
    if (!this.screen.atLineStart) this.screen.write('\n');
    if (this.last === 'text') this.screen.write('\n'); // status lines after prose start a new paragraph
    this.screen.write(`${line}\n`);
    this.last = 'line';
  }

  /** What was written last in this turn, for paragraph spacing. */
  private last: 'none' | 'text' | 'line' = 'none';

  // ---- lifecycle ---------------------------------------------------------------------------------
  begin(label: string): void {
    this.stopTimer();
    this.t0 = this.now();
    this.active = true; this.paused = false; this.running = 0; this.group = undefined;
    this.seenStarted.clear(); this.seenDone.clear(); this.committed = 0; this.hidden = 0;
    this.label = label; this.frame = 0;
    this.screen.write(`${this.accent('◆')} Lumina\n`);
    this.screen.prefix = '  ';
    this.last = 'none';
    this.draw();
    if (this.opts.animate && this.screen.live) {
      this.timer = setInterval(() => { this.frame = (this.frame + 1) % FRAMES.length; this.draw(); }, this.opts.intervalMs ?? 100);
      this.timer.unref();
    }
  }

  setLabel(label: string): void {
    if (!this.active || label === this.label) return;
    this.label = label;
    this.draw();
  }

  /** Hides the status row (approval prompt). The timer keeps counting but draws nothing. */
  pause(): void { this.paused = true; this.draw(); }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.draw();
  }

  /** Terminal resized: the status row is re-fitted. */
  refresh(): void { this.draw(); }

  end(status: EndStatus, detail?: string): void {
    if (!this.active) return; // completion feedback exactly once
    this.flushGroup();
    this.active = false;
    this.stopTimer();
    this.draw();
    if (!this.screen.atLineStart) this.screen.write('\n');
    if (this.last !== 'none') this.screen.write('\n'); // completion stands apart from the answer
    if (this.hidden > 0) this.screen.write(`${this.dim(`… ${this.hidden} more step${this.hidden === 1 ? '' : 's'}`)}\n`);
    const t = this.elapsed();
    const line = status === 'completed' ? `${this.paint('32', '✓')} Completed in ${t}`
      : status === 'failed' ? `${this.paint('31', '✗')} Failed after ${t}`
        : `${this.paint('33', '!')} Cancelled after ${t}`;
    this.screen.write(`${line}\n`);
    if (detail) this.screen.write(`${this.dim(detail.replace(/\s+/g, ' ').slice(0, 200))}\n`);
    this.screen.prefix = '';
    this.screen.write('\n');
    this.screen.resetMarkdown();
    this.last = 'none';
  }

  dispose(): void {
    this.context = '';
    this.stopTimer();
    this.active = false;
    this.screen.setStatus(undefined);
    this.screen.prefix = '';
  }

  private stopTimer(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
  }

  // ---- App Server events → timeline --------------------------------------------------------------
  event(method: string, params: unknown): void {
    if (!this.active) return;
    const item = (params as { item?: Item } | undefined)?.item;
    if (method === 'turn/started') return this.setLabel('Thinking...');
    if (!item) return;
    if (method === 'item/started') return this.onStarted(item);
    if (method === 'item/completed') return this.onCompleted(item);
  }

  private kindOf(item: Item): Kind | undefined {
    switch (item.type) {
      case 'commandExecution': {
        const a = item.commandActions ?? [];
        if (a.length && a.every((x) => x.type === 'read')) return 'read';
        if (a.length && a.every((x) => x.type === 'search' || x.type === 'listFiles')) return 'search';
        return 'command';
      }
      case 'fileChange': return 'edit';
      case 'mcpToolCall': case 'dynamicToolCall': return 'tool';
      case 'webSearch': return 'web';
      default: return undefined;
    }
  }

  private onStarted(item: Item): void {
    const key = item.id ?? '';
    if (key && this.seenStarted.has(key)) return;
    if (key) this.seenStarted.add(key);
    const kind = this.kindOf(item);
    if (kind) {
      if (this.group && this.group.kind !== kind) this.flushGroup();
      this.group ??= { kind, n: 0 };
      this.running++;
      return this.setLabel(LABEL[kind]);
    }
    if (item.type === 'reasoning') { this.flushGroup(); this.setLabel('Reasoning...'); }
    else if (item.type === 'plan') this.setLabel('Planning...');
    else if (item.type === 'contextCompaction') this.setLabel('Compacting context...');
  }

  private onCompleted(item: Item): void {
    const key = item.id ?? '';
    if (key && this.seenDone.has(key)) return;
    if (key) this.seenDone.add(key);
    const kind = this.kindOf(item);
    if (kind) {
      this.running = Math.max(0, this.running - 1);
      const failed = item.status === 'failed' || item.status === 'declined' || (typeof item.exitCode === 'number' && item.exitCode !== 0);
      if (failed) {
        this.flushGroup();
        const what = kind === 'edit' ? 'Edit' : kind === 'tool' ? 'Tool call' : kind === 'web' ? 'Search' : 'Command';
        const declined = item.status === 'declined';
        this.commit(declined ? `${this.paint('33', '!')} ${what} declined` : `${this.paint('31', '✗')} ${what} failed${typeof item.exitCode === 'number' ? ` (exit ${item.exitCode})` : ''}`);
      } else if (this.group) {
        this.group.n += kind === 'edit' ? Math.max(1, item.changes?.length ?? 1)
          : kind === 'read' ? Math.max(1, (item.commandActions ?? []).filter((a) => a.type === 'read').length) : 1;
      }
      if (this.running === 0) this.setLabel('Thinking...');
    } else if (item.type === 'reasoning') this.setLabel('Thinking...');
    else if (item.type === 'agentMessage') { this.flushGroup(); this.setLabel('Finalizing...'); }
  }

  private flushGroup(): void {
    const g = this.group;
    this.group = undefined;
    if (!g || g.n === 0) return;
    const s = g.n === 1 ? '' : 's';
    const text = { read: `Read ${g.n} file${s}`, search: `Searched ${g.n} time${s}`, command: `Ran ${g.n} command${s}`, edit: `Edited ${g.n} file${s}`, tool: `Used ${g.n} tool call${s}`, web: 'Searched the web' }[g.kind];
    if (this.committed >= MAX_COMMITTED) { this.hidden++; return; }
    this.committed++;
    this.commit(`${this.paint('32', '✓')} ${text}`);
  }
}
