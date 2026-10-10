import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RouterConfig, stateDir } from '../smart-codex/config.js';
import { ModelInfo, resolveModel } from '../smart-codex/models.js';
import { Route, splitPrompt } from '../smart-codex/router.js';
import { classifyFailure } from '../smart-codex/run.js';
import { unwrap } from './approval/policy.js';
import type { Selection, TokenBreakdown, TurnItem, TurnResult } from './tui/chat.js';

export type Tier = 'fast' | 'balanced' | 'advanced';
export const TIER_ORDER: Tier[] = ['fast', 'balanced', 'advanced'];
/** task = the user's request as-is (no wrapper). Other stages exist only when planned (orchestrated) or added lazily. */
export type StageType = 'task' | 'design' | 'implement' | 'fix' | 'review';
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type Strategy = 'direct' | 'adaptive' | 'orchestrated';

export interface Stage {
  id: string; type: StageType; title: string; tier: Tier; effort: string; status: StageStatus;
  model?: string; attempts: number; escalation: number; outcome?: string; ms?: number; reason: string;
  thread?: 'shared' | 'isolated'; usage?: TokenBreakdown;
}

const DEF: Record<StageType, { title: string; tier: Tier; effort: string; reason: string; objective: string }> = {
  task: { title: 'Execute request', tier: 'fast', effort: 'medium', reason: 'single-stage execution', objective: '' },
  design: { title: 'Design', tier: 'balanced', effort: 'high', reason: 'architecture decisions need deeper reasoning',
    objective: 'Make the design decisions this change needs (interfaces, data model, security approach). Do not write code yet. Reply with the decisions as a concise list.' },
  implement: { title: 'Implement', tier: 'fast', effort: 'medium', reason: 'implementation follows the agreed design',
    objective: 'Implement the request following the design decisions, including any tests or docs it asks for, and run the relevant tests. Reply with a short summary of files changed and test results.' },
  fix: { title: 'Fix failing checks', tier: 'balanced', effort: 'high', reason: 'previous stage left failures',
    objective: 'Investigate and fix the failures listed under known_issues without redoing completed work. Re-run the failing checks. Reply with the cause, the fix and the final result.' },
  review: { title: 'Security review', tier: 'balanced', effort: 'high', reason: 'high-risk change: independent verification',
    objective: 'Review the changes listed under modified_files for security problems (authn/authz, injection, secrets, input validation) and fix real issues only. Reply with findings and fixes.' },
};

const CUE = {
  design: /\b(architect\w*|design|schema|data model|rbac|permissions?|authori[sz]ation|multi-?tenant|migrations?)\b/i,
  tests: /\b(tests?|testing|unit tests?|e2e|coverage|pengujian)\b/i,
  review: /\b(review|audit|security check|keamanan)\b/i,
  docs: /\b(docs?|documentation|readme|dokumentasi)\b/i,
  migration: /\b(migrations?|schema|database)\b/i,
};
const MODIFY = /\b(implement|build|create|add|fix|change|update|refactor|rewrite|remove|delete|migrate|rotate|replace|patch|write|buat|tambah\w*|perbaiki|ubah)\b/i;

const makeStage = (type: StageType, tier = DEF[type].tier, effort = DEF[type].effort, reason = DEF[type].reason): Stage =>
  ({ id: `stage_${randomUUID().slice(0, 8)}`, type, title: DEF[type].title, tier, effort, status: 'pending', attempts: 0, escalation: 0, reason });

export interface ExecutionPlan {
  strategy: Strategy;
  stages: Stage[];
  /** add a review stage after execution if (and only if) the request modified files */
  reviewAfter: boolean;
  /** escalation and lazily added stages allowed */
  adaptive: boolean;
}

/** Starting tier from complexity and risk: risk raises the model, not the number of stages. */
export function startTier(route: Route): Tier {
  if (route.risk === 'high' && route.base_complexity >= 8) return 'advanced';
  if (route.tier === 'hard' || route.tier === 'critical') return 'balanced';
  return 'fast';
}

/**
 * Deterministic plan (no LLM). Default is one stage that runs the request as-is; more stages are planned only for
 * genuinely complex work (hard + several distinct deliverables), and a separate review only for high-risk changes the
 * user explicitly asked to have reviewed.
 */
export function planExecution(task: string, route: Route, cfg: RouterConfig, first: Selection): ExecutionPlan {
  const sc = cfg.stages;
  const tier = startTier(route);
  // the single stage keeps the router's own model/effort unless complexity+risk justify starting higher
  const taskStage = makeStage('task', tier, tier === 'advanced' ? 'high' : first.effort ?? 'medium', tier === 'fast' ? 'straightforward task' : `${route.tier} task (${route.risk} risk)`);
  if (!sc.enabled || sc.execution_strategy === 'direct') return { strategy: 'direct', stages: [taskStage], reviewAfter: false, adaptive: false };
  // plan on the user's request, not on pasted tickets/docs (their headings would look like many deliverables)
  if (route.reference_chars > 0) task = splitPrompt(task).instruction;
  const modifies = MODIFY.test(task);
  const reviewAfter = modifies && route.risk === 'high' && CUE.review.test(task) && sc.max_stages >= 2;
  const deliverables = [CUE.design, CUE.tests, CUE.docs, CUE.migration, CUE.review].filter((re) => re.test(task)).length;
  // several distinct deliverables (design + migrations + tests + docs…), or hard work with a few of them
  const complex = modifies && (deliverables >= 4 || (route.base_complexity >= 7 && deliverables >= 3));
  if ((complex || (sc.execution_strategy === 'orchestrated' && route.base_complexity >= 7 && modifies)) && sc.max_stages >= 2 && CUE.design.test(task)) {
    const implTier: Tier = route.base_complexity >= 9 ? 'balanced' : 'fast';
    return { strategy: 'orchestrated', stages: [makeStage('design', tier === 'advanced' ? 'advanced' : 'balanced'), makeStage('implement', implTier)], reviewAfter, adaptive: true };
  }
  return { strategy: 'adaptive', stages: [taskStage], reviewAfter, adaptive: true };
}

/** Compact, structured hand-off kept by Lumina across stages. */
export interface ExecutionContext {
  task: string; completed: string[]; current_stage: string; modified_files: string[]; known_issues: string[]; pending: string[]; constraints: string[];
}

const TEST_CMD = /\b(vitest|jest|mocha|pytest|phpunit|rspec|go test|cargo test|node --test|npm (run )?test|pnpm (run )?test|yarn test|bun test|make test)\b/;
const STUCK = /\b(unable to|could not|cannot|can't) (fix|resolve|determine|figure out|make (it|the tests?) pass)\b|\bstill fail(s|ing)\b/i;

/** Signals read from a finished stage. "Tests failing" uses only the last test run of the stage, not any non-zero exit. */
export function analyzeStage(items: TurnItem[] = []): { files: string[]; testsFailed: boolean; stuck: boolean; outcome: string; failures: string[] } {
  const files = [...new Set(items.flatMap((i) => i.files ?? []))];
  // The exit code only reflects the tests when the runner is the LAST command of a chain:
  // `node --test && rg -n x` exits 1 when rg finds nothing, which says nothing about the tests.
  const isTestResult = (cmd: string) => TEST_CMD.test(unwrap(cmd).split(/&&|\|\||;|\|/).pop() ?? '');
  const tests = items.filter((i) => i.type === 'commandExecution' && i.command && isTestResult(i.command));
  const last = tests.at(-1);
  const testsFailed = Boolean(last && typeof last.exitCode === 'number' && last.exitCode !== 0);
  const message = items.filter((i) => i.type === 'agentMessage' && i.text).at(-1)?.text ?? '';
  const failures = testsFailed ? [`tests still failing (exit ${last!.exitCode}) after \`${last!.command!.replace(/^\S*sh -lc /, '').slice(0, 80)}\``] : [];
  return { files, testsFailed, stuck: STUCK.test(message), outcome: message.replace(/\s+/g, ' ').trim().slice(0, 160), failures };
}

export interface RoutingLog {
  level: 'info' | 'warn'; event: string; request_id: string; execution_id: string; stage_id?: string; stage_type?: string;
  previous_model?: string | null; selected_model?: string; routing_reason?: string; escalation_level?: number;
  execution_duration_ms?: number; retry_count?: number; switch_count?: number; routing_strategy: string; status?: string; [k: string]: unknown;
}

/** Structured routing log (JSONL next to the router's analytics). Never contains prompt text, code or credentials. */
export function logRouting(entry: RoutingLog, cfg: RouterConfig): void {
  if (!cfg.analytics.enabled) return;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.appendFileSync(path.join(stateDir(), 'routing.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch { /* logging must never break execution */ }
}

export interface StageHooks {
  /** Called once with the initial plan; `models` are what each stage starts on. */
  planned(plan: ExecutionPlan, models: string[]): void;
  stageStart(stage: Stage, index: number, total: number, sel: Selection, switched?: { from: string; to: string; reason: string }): void;
  stageEnd(stage: Stage, index: number, total: number): void;
  notice(text: string): void;
}

export interface StageDeps {
  cfg: RouterConfig;
  catalog: ModelInfo[];
  /** Runs one turn with an explicit model/effort (the real switch), on the main thread or an isolated one. */
  send(prompt: string, sel: Selection, opts: { first: boolean; isolated: boolean }): Promise<TurnResult>;
  interrupt(): Promise<unknown>;
  cancelled(): boolean;
  /** Main-thread context size (provider-reported), used for isolation/compaction decisions. */
  context?(): { used: number; window: number | null } | undefined;
  compact?(): Promise<boolean>;
  hooks: StageHooks;
  log?: (e: RoutingLog) => void;
  requestId?: string;
}

export interface ExecutionResult {
  status: 'completed' | 'failed' | 'cancelled'; error?: string; stages: Stage[]; strategy: Strategy;
  switches: number; escalations: number; compactions: number; retries: number; usage: TokenBreakdown; usageReported: boolean; ms: number; models: string[];
}

/**
 * Runs a request as one or more turns, each with its own model/effort (Codex cannot change the model inside a running
 * turn, so stage = turn). Stage 1 is the user's request verbatim. Further stages are added only when execution needs
 * them: a fix stage on meaningful failure signals (escalated one tier at a time), or a review stage for high-risk
 * changes. Bounded by the configured limits.
 */
export class StagedExecution {
  readonly id = `exec_${randomUUID().slice(0, 12)}`;
  readonly ctx: ExecutionContext;
  readonly stages: Stage[];
  private strategy: Strategy;
  private switches = 0;
  private escalations = 0;
  private compactions = 0;
  private retries = 0;
  private prevModel: string | null = null;
  private prevTier: Tier | null = null;

  constructor(private readonly task: string, readonly plan: ExecutionPlan, private readonly deps: StageDeps, private readonly first: Selection = {}, constraints: string[] = []) {
    this.stages = [...plan.stages];
    this.strategy = plan.strategy;
    this.ctx = { task: task.replace(/\s+/g, ' ').trim().slice(0, 200), completed: [], current_stage: '', modified_files: [], known_issues: [], pending: [], constraints: ['do not redo completed stages', ...constraints] };
  }

  private log(e: Omit<RoutingLog, 'request_id' | 'execution_id' | 'routing_strategy'>): void {
    const entry = { request_id: this.deps.requestId ?? this.id, execution_id: this.id, routing_strategy: this.strategy, switch_count: this.switches, ...e } as RoutingLog;
    (this.deps.log ?? ((x) => logRouting(x, this.deps.cfg)))(entry);
  }

  /** Model for a stage. A plain single task keeps the router's own selection; tiers resolve through the catalog. */
  private select(stage: Stage, tier: Tier, effort: string): Selection & { note?: string } {
    if (stage.type === 'task' && stage.attempts <= 1 && tier === stage.tier && tier !== 'advanced' && this.first.model) return { model: this.first.model, effort: this.first.effort ?? effort };
    const r = resolveModel(this.deps.catalog, this.deps.cfg.stages.tiers[tier], effort, false, this.deps.cfg.stages.tiers.fast);
    return { model: r.model, effort: r.effort, note: r.note };
  }

  /** Shared thread while its history is small; an isolated thread with a compact hand-off once it is large. */
  private isolate(i: number): boolean {
    const mode = this.deps.cfg.stages.context_strategy;
    if (i === 0 || mode === 'shared') return false;
    if (mode === 'isolated') return true;
    const c = this.deps.context?.();
    return Boolean(c && c.used >= this.deps.cfg.stages.isolate_min_context_tokens);
  }

  private prompt(stage: Stage, i: number, isolated: boolean): string {
    if (stage.type === 'task' && stage.attempts <= 1) return this.task; // verbatim: no wrapper overhead on the common path
    this.ctx.current_stage = stage.title;
    this.ctx.pending = this.stages.slice(i + 1).filter((s) => s.status === 'pending').map((s) => s.title);
    const parts = [`[Lumina stage ${i + 1}: ${stage.title}]`, `Handoff: ${JSON.stringify(this.ctx)}`];
    parts.push(`Objective: ${stage.type === 'task' ? 'Complete the user request below; the previous attempt failed (see known_issues). Do not redo work that already succeeded.' : DEF[stage.type].objective}`);
    // a fresh thread knows nothing: give it the request (bounded); on the shared thread the history already has it
    if (isolated || (i === 0)) parts.push(`User request:\n${this.task.slice(0, 4000)}`);
    if (!this.stages.slice(i + 1).some((s) => s.status === 'pending')) parts.push('This is the final stage: finish with a concise summary for the user of everything done.');
    return parts.join('\n\n');
  }

  async run(): Promise<ExecutionResult> {
    const { cfg, hooks } = this.deps;
    const lim = cfg.stages;
    const t0 = Date.now();
    const usage: TokenBreakdown = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    let usageReported = false;
    hooks.planned(this.plan, this.stages.map((s) => this.select(s, s.tier, s.effort).model ?? ''));
    this.log({ level: 'info', event: 'plan_created', status: `${this.stages.length} stage(s)`, stage_type: this.stages.map((s) => s.type).join('>'), review_after: this.plan.reviewAfter });
    let failure: string | undefined;
    let status: ExecutionResult['status'] = 'completed';

    for (let i = 0; i < this.stages.length; i++) {
      const stage = this.stages[i];
      if (this.deps.cancelled()) { status = 'cancelled'; break; }
      stage.status = 'running';
      let tier = stage.tier;
      let effort = stage.effort;
      for (;;) {
        stage.attempts++;
        let sel = this.select(stage, tier, effort);
        // switching costs a cold start (no prompt cache) on another model: don't step DOWN just for a final short review
        const last = !this.stages.slice(i + 1).some((s) => s.status === 'pending');
        if (lim.model_switch_penalty && stage.type === 'review' && stage.attempts === 1 && this.prevModel && this.prevTier && sel.model !== this.prevModel && last && TIER_ORDER.indexOf(tier) < TIER_ORDER.indexOf(this.prevTier)) {
          this.log({ level: 'info', event: 'switch_skipped', stage_id: stage.id, stage_type: stage.type, selected_model: this.prevModel, routing_reason: 'model_switch_penalty: final stage stays on the current model' });
          sel = { model: this.prevModel, effort: sel.effort }; tier = this.prevTier;
        }
        let switched: { from: string; to: string; reason: string } | undefined;
        if (this.prevModel && sel.model !== this.prevModel) {
          if (this.switches >= lim.max_switches) {
            this.log({ level: 'warn', event: 'switch_limit_reached', stage_id: stage.id, stage_type: stage.type, selected_model: this.prevModel, routing_reason: `wanted ${sel.model}` });
            sel = { model: this.prevModel, effort: sel.effort };
          } else {
            this.switches++;
            switched = { from: this.prevModel, to: sel.model!, reason: stage.reason };
            this.log({ level: 'info', event: 'model_switched', stage_id: stage.id, stage_type: stage.type, previous_model: this.prevModel, selected_model: sel.model, routing_reason: stage.reason, escalation_level: stage.escalation });
          }
        }
        if (sel.note) this.log({ level: 'warn', event: 'model_fallback', stage_id: stage.id, stage_type: stage.type, selected_model: sel.model, routing_reason: sel.note });
        const isolated = this.isolate(i);
        if (!isolated && i > 0 && lim.compaction_strategy === 'auto' && this.deps.compact) {
          const c = this.deps.context?.();
          if (c?.window && c.used / c.window >= lim.compact_threshold) {
            const ok = await this.deps.compact().catch(() => false);
            if (ok) this.compactions++;
            this.log({ level: ok ? 'info' : 'warn', event: ok ? 'context_compacted' : 'compaction_failed', stage_id: stage.id, routing_reason: `context ${Math.round((c.used / c.window) * 100)}% of window` });
          }
        }
        stage.model = sel.model;
        stage.thread = isolated ? 'isolated' : 'shared';
        hooks.stageStart(stage, i, this.stages.length, sel, switched);
        this.log({ level: 'info', event: 'stage_started', stage_id: stage.id, stage_type: stage.type, previous_model: this.prevModel, selected_model: sel.model, routing_reason: stage.reason, escalation_level: stage.escalation, retry_count: stage.attempts - 1, context: stage.thread });
        const st = Date.now();
        let result: TurnResult;
        try {
          result = await this.withTimeout(this.deps.send(this.prompt(stage, i, isolated), { model: sel.model, effort: sel.effort }, { first: i === 0 && stage.attempts === 1, isolated }), lim.stage_timeout_ms);
        } catch (e) {
          result = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
        }
        stage.ms = (stage.ms ?? 0) + Date.now() - st;
        if (result.usage) {
          usageReported = true;
          stage.usage = add(stage.usage, result.usage);
          for (const k of Object.keys(usage) as (keyof TokenBreakdown)[]) usage[k] += result.usage[k];
        }
        this.prevModel = sel.model ?? this.prevModel;
        this.prevTier = tier;
        const sig = analyzeStage(result.items);
        for (const f of sig.files) if (!this.ctx.modified_files.includes(f)) this.ctx.modified_files.push(f);
        this.ctx.modified_files = this.ctx.modified_files.slice(-30);

        if (result.status === 'interrupted' || this.deps.cancelled()) { stage.status = 'skipped'; stage.outcome = 'cancelled'; status = 'cancelled'; break; }
        if (result.status === 'failed') {
          const kind = classifyFailure(result.error ?? '');
          const rejectedModel = /model/i.test(result.error ?? '') && /(not (supported|available)|unsupported|unknown|invalid)/i.test(result.error ?? '');
          if (this.plan.adaptive && rejectedModel && sel.model !== cfg.stages.tiers.fast && stage.attempts <= lim.max_retries) {
            this.log({ level: 'warn', event: 'model_rejected', stage_id: stage.id, stage_type: stage.type, selected_model: sel.model, routing_reason: 'backend rejected model; falling back' });
            tier = 'fast'; this.retries++; continue;
          }
          if (this.plan.adaptive && kind === 'coding' && stage.attempts <= lim.max_retries && this.escalations < lim.max_escalations && tier !== 'advanced') {
            tier = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1]; effort = 'high'; stage.escalation++; this.escalations++; this.retries++;
            this.strategy = this.strategy === 'direct' ? 'adaptive' : this.strategy;
            this.ctx.known_issues = [`previous attempt failed: ${(result.error ?? 'failed').slice(0, 160)}`];
            this.log({ level: 'warn', event: 'escalated', stage_id: stage.id, stage_type: stage.type, selected_model: this.select(stage, tier, effort).model, routing_reason: 'stage failed', escalation_level: stage.escalation, retry_count: stage.attempts });
            hooks.notice(`stage failed; retrying ${stage.title} on a stronger model`);
            continue;
          }
          stage.status = 'failed'; stage.outcome = (result.error ?? 'failed').slice(0, 160);
          failure = `${stage.title} failed${kind !== 'coding' ? ` (${kind})` : ''}: ${stage.outcome}`;
          status = 'failed';
          break;
        }
        stage.status = 'done';
        stage.outcome = sig.outcome;
        this.ctx.completed.push(`${stage.title}: ${sig.outcome || 'done'}`.slice(0, 200));
        if (sig.failures.length) this.ctx.known_issues.push(...sig.failures);
        this.ctx.known_issues = this.ctx.known_issues.slice(-5);
        const problem = sig.testsFailed || (sig.stuck && ['task', 'implement', 'fix'].includes(stage.type));
        if (problem && this.plan.adaptive) {
          // lazy stage: fix on the next tier up from where we are (de-escalation happens for later independent stages)
          const fixes = this.stages.filter((s) => s.type === 'fix').length;
          const nextTier = TIER_ORDER[Math.min(TIER_ORDER.indexOf(tier) + 1, 2)];
          if (fixes < lim.max_retries && this.escalations < lim.max_escalations && this.stages.length < lim.max_stages + lim.max_escalations) {
            const fix = makeStage('fix', nextTier, 'high', sig.testsFailed ? 'tests still failing after previous stage' : 'previous stage reported it could not resolve the problem');
            fix.escalation = TIER_ORDER.indexOf(nextTier);
            this.escalations++;
            this.strategy = this.strategy === 'direct' ? 'adaptive' : this.strategy;
            this.stages.splice(i + 1, 0, fix);
            this.log({ level: 'warn', event: 'escalated', stage_id: fix.id, stage_type: 'fix', selected_model: this.select(fix, nextTier, 'high').model, routing_reason: fix.reason, escalation_level: fix.escalation });
          } else {
            this.log({ level: 'warn', event: 'escalation_limit_reached', stage_id: stage.id, stage_type: stage.type, routing_reason: 'problems remain' });
            failure = `${stage.title}: ${sig.failures[0] ?? 'problem unresolved'}`; status = 'failed';
          }
        } else if (problem) {
          failure = `${stage.title}: ${sig.failures[0] ?? 'problem unresolved'}`; status = 'failed';
        } else if (stage.type === 'fix') this.ctx.known_issues = [];
        break;
      }
      hooks.stageEnd(stage, i, this.stages.length);
      this.log({ level: stage.status === 'failed' ? 'warn' : 'info', event: 'stage_completed', stage_id: stage.id, stage_type: stage.type, selected_model: stage.model, status: stage.status, execution_duration_ms: stage.ms, retry_count: stage.attempts - 1, escalation_level: stage.escalation, context: stage.thread, ...flat(stage.usage) });
      if (status !== 'completed') break;
      // lazy review: only after the work is otherwise complete, and only if something was actually changed
      const remaining = this.stages.slice(i + 1).some((s) => s.status === 'pending');
      if (!remaining && this.plan.reviewAfter && this.ctx.modified_files.length && !this.stages.some((s) => s.type === 'review')) {
        this.stages.push(makeStage('review'));
        this.strategy = this.strategy === 'direct' ? 'adaptive' : this.strategy;
        this.log({ level: 'info', event: 'stage_added', stage_type: 'review', routing_reason: 'high-risk change with requested review' });
      }
    }
    for (const s of this.stages) if (s.status === 'pending') s.status = 'skipped';
    const result: ExecutionResult = {
      status, error: failure, stages: this.stages, strategy: this.strategy, switches: this.switches, escalations: this.escalations,
      compactions: this.compactions, retries: this.retries, usage, usageReported, ms: Date.now() - t0,
      models: [...new Set(this.stages.map((s) => s.model).filter((m): m is string => Boolean(m)))],
    };
    this.log({ level: status === 'completed' ? 'info' : 'warn', event: 'execution_finished', status, stages: this.stages.filter((s) => s.status !== 'skipped').length, models: result.models.join(','), escalation_level: this.escalations, compactions: this.compactions, retry_count: this.retries, execution_duration_ms: result.ms, token_source: usageReported ? 'provider' : 'unavailable', ...(usageReported ? flat(usage) : {}) });
    return result;
  }

  private withTimeout(p: Promise<TurnResult>, ms: number): Promise<TurnResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<TurnResult>((resolve) => {
      timer = setTimeout(() => {
        void this.deps.interrupt().catch(() => undefined);
        resolve({ status: 'failed', error: `stage timed out after ${Math.round(ms / 1000)}s` });
      }, ms);
      timer.unref?.();
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }
}

const add = (a: TokenBreakdown | undefined, b: TokenBreakdown): TokenBreakdown =>
  ({ totalTokens: (a?.totalTokens ?? 0) + b.totalTokens, inputTokens: (a?.inputTokens ?? 0) + b.inputTokens, cachedInputTokens: (a?.cachedInputTokens ?? 0) + b.cachedInputTokens, outputTokens: (a?.outputTokens ?? 0) + b.outputTokens });
const flat = (u?: TokenBreakdown) => (u ? { input_tokens: u.inputTokens, cached_input_tokens: u.cachedInputTokens, output_tokens: u.outputTokens, total_tokens: u.totalTokens } : {});
