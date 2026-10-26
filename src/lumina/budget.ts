import type { RouterConfig } from '../smart-codex/config.js';
import type { TokenBreakdown } from './tui/chat.js';

/**
 * Per-request execution budget. The stage, escalation, switch and repair limits are the existing ones (stages.*,
 * self_healing.*); this adds an optional wall-clock limit and optional provider-reported token thresholds, and one
 * decision point used before any ADDITIONAL stage or repair: is there budget left, and is the expected benefit worth it?
 * Checks happen only at execution boundaries. Verification commands are never budgeted away (they cost no model tokens),
 * and an exhausted budget stops the work with its progress kept — it never marks unfinished work as done.
 */
export interface BudgetLimits {
  stages: number; escalations: number; switches: number; retries: number; stageTimeoutMs: number;
  repairs: number; repairEscalations: number;
  /** 0 = no limit. */ durationMs: number; inputTokens: number; outputTokens: number;
}
export type Benefit = 'high' | 'medium' | 'low';

export function limitsFrom(cfg: RouterConfig): BudgetLimits {
  return {
    stages: cfg.stages.max_stages, escalations: cfg.stages.max_escalations, switches: cfg.stages.max_switches, retries: cfg.stages.max_retries, stageTimeoutMs: cfg.stages.stage_timeout_ms,
    repairs: cfg.self_healing.max_repair_attempts, repairEscalations: cfg.self_healing.max_escalations,
    durationMs: cfg.budget.max_duration_ms, inputTokens: cfg.budget.max_input_tokens, outputTokens: cfg.budget.max_output_tokens,
  };
}

export class Budget {
  readonly started: number;
  stages = 0; repairs = 0; escalations = 0; switches = 0;
  usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  /** Turns whose usage Codex reported, and turns it did not. */
  reported = 0; unreported = 0;
  stopped?: { reason: string; unfinished: string[] };
  private stageMs: number[] = [];

  constructor(readonly limits: BudgetLimits, readonly critical = false, private readonly now: () => number = Date.now) { this.started = now(); }

  private turnStart?: number;
  /** A Codex turn (stage or repair) is about to start. */
  beginTurn(): void { this.turnStart = this.now(); }
  /** It finished: its provider-reported usage, when there is one, and its duration. */
  turn(usage: TokenBreakdown | undefined): void {
    if (usage) { this.reported++; this.usage.inputTokens += usage.inputTokens; this.usage.cachedInputTokens += usage.cachedInputTokens; this.usage.outputTokens += usage.outputTokens; } else this.unreported++;
    if (this.turnStart !== undefined) { this.stageMs.push(this.now() - this.turnStart); this.turnStart = undefined; }
  }

  get elapsed(): number { return this.now() - this.started; }

  /** Fraction of the most-used optional dimension (time or tokens); 0 when none is limited or measured. */
  private used(): number {
    const l = this.limits;
    const f: number[] = [];
    if (l.durationMs) f.push(this.elapsed / l.durationMs);
    if (l.inputTokens && this.reported) f.push(this.usage.inputTokens / l.inputTokens);
    if (l.outputTokens && this.reported) f.push(this.usage.outputTokens / l.outputTokens);
    return f.length ? Math.max(...f) : 0;
  }

  /**
   * Before an additional stage or repair: the hard limits (time, tokens), then whether the expected benefit justifies
   * spending most of what is left. Critical (security-sensitive) work is never denied for "low benefit" reasons.
   */
  allow(kind: 'stage' | 'repair', benefit: Benefit): { ok: true } | { ok: false; reason: string } {
    const l = this.limits;
    const avg = this.stageMs.length ? this.stageMs.reduce((a, b) => a + b, 0) / this.stageMs.length : 0;
    if (l.durationMs && this.elapsed + avg > l.durationMs) return { ok: false, reason: `time budget: ${Math.round(this.elapsed / 1000)}s used of ${Math.round(l.durationMs / 1000)}s${avg ? `, and another ${kind} takes about ${Math.round(avg / 1000)}s` : ''}` };
    if (l.inputTokens && this.reported && this.usage.inputTokens >= l.inputTokens) return { ok: false, reason: `input token threshold: ${this.usage.inputTokens.toLocaleString('en-US')} of ${l.inputTokens.toLocaleString('en-US')} (provider-reported)` };
    if (l.outputTokens && this.reported && this.usage.outputTokens >= l.outputTokens) return { ok: false, reason: `output token threshold: ${this.usage.outputTokens.toLocaleString('en-US')} of ${l.outputTokens.toLocaleString('en-US')} (provider-reported)` };
    if (benefit === 'low' && !this.critical && this.used() >= 0.75) return { ok: false, reason: `low expected benefit with ${Math.round(this.used() * 100)}% of the budget used` };
    return { ok: true };
  }

  stop(reason: string, unfinished: string[]): void { this.stopped = { reason, unfinished }; }

  /** /budget lines: limits, consumption (provider-reported tokens only), and why tokens may be unknown. */
  format(title = 'Last request'): string[] {
    const l = this.limits;
    const t = (n: number) => n.toLocaleString('en-US');
    const out = [`${title}:`, `  Stages: ${this.stages} of ${l.stages}${l.escalations ? ` (+ up to ${l.escalations} escalation stages)` : ''} · Escalations: ${this.escalations} of ${l.escalations} · Model switches: ${this.switches} of ${l.switches}`, `  Repair attempts: ${this.repairs} of ${l.repairs}`, `  Duration: ${Math.round(this.elapsed / 1000)}s${l.durationMs ? ` of ${Math.round(l.durationMs / 1000)}s` : ' (no time limit)'}`];
    if (this.reported) out.push(`  Tokens (provider-reported${this.unreported ? `; ${this.unreported} turn${this.unreported === 1 ? '' : 's'} not reported` : ''}): input ${t(this.usage.inputTokens)}${l.inputTokens ? ` of ${t(l.inputTokens)}` : ''} (cached ${t(this.usage.cachedInputTokens)}) · output ${t(this.usage.outputTokens)}${l.outputTokens ? ` of ${t(l.outputTokens)}` : ''}`);
    else out.push(`  Tokens: not reported by Codex${l.inputTokens || l.outputTokens ? ' — token thresholds cannot be enforced for this request' : ''}`);
    if (this.stopped) out.push(`  Stopped: ${this.stopped.reason}`, ...this.stopped.unfinished.map((u) => `    unfinished: ${u}`), '  /continue resumes it with a fresh budget.');
    return out;
  }
}

export function formatLimits(l: BudgetLimits): string[] {
  const t = (n: number) => n.toLocaleString('en-US');
  return [
    'Budget limits (per request):',
    `  Stages: ${l.stages} planned, + up to ${l.escalations} escalation stage${l.escalations === 1 ? '' : 's'} · retries per stage: ${l.retries} · model switches: ${l.switches} · stage timeout: ${Math.round(l.stageTimeoutMs / 1000)}s`,
    `  Self-healing: ${l.repairs} repair attempt${l.repairs === 1 ? '' : 's'} · ${l.repairEscalations} escalation${l.repairEscalations === 1 ? '' : 's'}`,
    `  Duration: ${l.durationMs ? `${Math.round(l.durationMs / 1000)}s` : 'no limit'} · Input tokens: ${l.inputTokens ? t(l.inputTokens) : 'no threshold'} · Output tokens: ${l.outputTokens ? t(l.outputTokens) : 'no threshold'}`,
    '  Verification and safety checks are never skipped to stay within budget. Tokens are provider-reported counts, not billing.',
  ];
}
