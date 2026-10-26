import type { RouterConfig } from '../smart-codex/config.js';
import type { TokenBreakdown } from './tui/chat.js';

/**
 * Context compaction policy and record keeping on top of Codex's own `thread/compact/start` (no new memory system).
 * Compaction happens only at execution boundaries — before a user turn starts, or between stages — never during a
 * running turn, and only when it is likely to pay off: a long conversation, a large and mostly full context, and no
 * recent compaction. After compacting, a deterministic block of CRITICAL context (requirements, decisions, changed
 * files, pending work, approval limits, known failures) is restated so nothing essential depends on the summary.
 */
export interface CompactionRecord {
  at: number; trigger: 'turn boundary' | 'stage boundary'; ok: boolean; ms: number;
  /** Provider-reported context size before compacting (tokens in the last turn's window). */
  before?: number; window?: number | null;
  /** Context size reported for the first turn after compacting (includes that turn's new input). */
  after?: number;
  /** The compaction's own provider-reported cost; undefined = Codex did not report it. */
  usage?: TokenBreakdown;
  reason: string;
}
export interface ContextState { used: number; window: number | null }
type Stages = RouterConfig['stages'];

export const MIN_TURNS = 6; // shorter conversations are never compacted

export class Compactor {
  records: CompactionRecord[] = [];
  private turns = 0; // user turns since the conversation started or was last compacted
  private failedAt = -Infinity;
  private turnIndex = 0;

  constructor(private readonly cfg: Stages, private readonly compact: () => Promise<boolean>, private readonly usage: () => TokenBreakdown | undefined = () => undefined) {}

  reset(): void { this.records = []; this.turns = 0; this.failedAt = -Infinity; this.turnIndex = 0; }

  /** Whether compacting now is likely to pay off; the reason is shown when it is skipped. */
  decide(ctx: ContextState | undefined): { compact: boolean; reason: string } {
    if (this.cfg.compaction_strategy !== 'auto') return { compact: false, reason: 'compaction disabled (stages.compaction_strategy)' };
    if (!ctx || !ctx.window) return { compact: false, reason: 'context size not reported: nothing to measure against' };
    const ratio = ctx.used / ctx.window;
    if (this.turns < MIN_TURNS) return { compact: false, reason: `short conversation (${this.turns} turn${this.turns === 1 ? '' : 's'} since the last reset/compaction)` };
    if (ctx.used < this.cfg.isolate_min_context_tokens) return { compact: false, reason: `context ${ctx.used.toLocaleString('en-US')} tokens: too small to justify a summarization call` };
    if (ratio < this.cfg.compact_threshold) return { compact: false, reason: `context ${Math.round(ratio * 100)}% of the window (threshold ${Math.round(this.cfg.compact_threshold * 100)}%)` };
    if (this.turnIndex - this.failedAt < 3) return { compact: false, reason: 'the last compaction failed recently' };
    return { compact: true, reason: `context ${Math.round(ratio * 100)}% of the window after ${this.turns} turns` };
  }

  /** Runs Codex's compaction at a boundary and records what was measurable. */
  async run(trigger: CompactionRecord['trigger'], ctx: ContextState | undefined, reason: string): Promise<CompactionRecord> {
    const t0 = Date.now();
    const ok = await this.compact().catch(() => false);
    const rec: CompactionRecord = { at: t0, trigger, ok, ms: Date.now() - t0, before: ctx?.used, window: ctx?.window, reason, usage: ok ? this.usage() : undefined };
    this.records.push(rec);
    if (ok) this.turns = 0; else this.failedAt = this.turnIndex;
    return rec;
  }

  /** After each user turn: counts turns, and fills the measured size after the latest compaction. */
  turnDone(ctx: ContextState | undefined): void {
    this.turns++;
    this.turnIndex++;
    const last = this.records.at(-1);
    if (last?.ok && last.after === undefined && ctx) last.after = ctx.used;
  }

  /** /context section: only measured values; the size after is labelled as the next turn's context. */
  format(): string[] {
    const lines = ['', `Compaction: ${this.records.filter((r) => r.ok).length} done${this.records.some((r) => !r.ok) ? `, ${this.records.filter((r) => !r.ok).length} failed` : ''} · ${this.turns} turn${this.turns === 1 ? '' : 's'} since the last one`];
    for (const r of this.records.slice(-5)) {
      const size = r.before !== undefined ? `${r.before.toLocaleString('en-US')} tokens${r.window ? ` (${Math.round((r.before / r.window) * 100)}%)` : ''} → ${r.after !== undefined ? `${r.after.toLocaleString('en-US')} at the next turn (includes its new input)` : 'next turn not measured yet'}` : 'size not reported';
      lines.push(`  ${r.ok ? '✓' : '✗'} ${r.trigger} · ${size} · ${r.ms}ms · ${r.usage ? `compaction cost: input ${r.usage.inputTokens.toLocaleString('en-US')}, output ${r.usage.outputTokens.toLocaleString('en-US')} (provider-reported)` : 'compaction cost: not reported by Codex'}`);
    }
    return lines;
  }
}

/** Deterministic CRITICAL context restated after a compaction (bounded; data, not instructions; no file contents). */
export function preservedContext(p: {
  ticket?: { id: string; mode?: string; clarifications: string[] };
  decisions?: string[]; files?: string[]; pending?: string[]; approval?: string; failures?: string[]; constraints?: string[];
}, max = 2000): string | undefined {
  const parts: string[] = [];
  if (p.ticket) parts.push(`Ticket ${p.ticket.id}${p.ticket.mode ? ` (${p.ticket.mode})` : ''}${p.ticket.clarifications.length ? `; confirmed clarifications: ${p.ticket.clarifications.map((c, i) => `${i + 1}. ${c.replace(/\s+/g, ' ').slice(0, 200)}`).join(' ')}` : ''}`);
  if (p.decisions?.length) parts.push(`Decisions the user stated this session (recorded notes; the code is authoritative): ${p.decisions.slice(-8).join('; ')}`);
  if (p.files?.length) parts.push(`Files changed in this conversation: ${p.files.slice(0, 25).join(', ')}${p.files.length > 25 ? ', …' : ''}`);
  if (p.pending?.length) parts.push(`Pending: ${p.pending.join('; ')}`);
  if (p.failures?.length) parts.push(`Known verification failures: ${p.failures.join('; ')}`);
  if (p.constraints?.length) parts.push(`Constraints: ${p.constraints.join('; ')}`);
  if (p.approval) parts.push(`Approvals: ${p.approval}`);
  if (!parts.length) return undefined;
  const block = `[Lumina preserved context after compaction — restated so it does not depend on the summary:\n${parts.map((x) => `- ${x}`).join('\n')}]`;
  return block.length > max ? `${block.slice(0, max - 2)}…]` : block;
}
