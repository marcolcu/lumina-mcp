// FROZEN SNAPSHOT of the pre-optimization stage planner/executor (fixed pipeline, shared thread), kept only so
// bench/routing.bench.ts can compare old vs new routing on identical scenarios. Not part of the build.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RouterConfig, stateDir } from '../../src/smart-codex/config.js';
import { ModelInfo, resolveModel } from '../../src/smart-codex/models.js';
import { Route } from './router.legacy.js';
import { classifyFailure } from '../../src/smart-codex/run.js';
import type { Selection, TurnItem, TurnResult } from '../../src/lumina/tui/chat.js';

export type Tier = 'fast' | 'balanced' | 'advanced';
export const TIER_ORDER: Tier[] = ['fast', 'balanced', 'advanced'];
export type StageType = 'analyze' | 'design' | 'implement' | 'test' | 'fix' | 'review' | 'docs';
export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface Stage {
  id: string; type: StageType; title: string; tier: Tier; effort: string; status: StageStatus;
  model?: string; attempts: number; escalation: number; outcome?: string; ms?: number; reason: string;
}

// Base tier/effort per stage kind. Final-response work is folded into the last stage (no extra turn).
const DEF: Record<StageType, { title: string; tier: Tier; effort: string; reason: string; objective: string }> = {
  analyze: { title: 'Analyze requirements', tier: 'fast', effort: 'medium', reason: 'requirement analysis is light reasoning',
    objective: 'Analyze the request and inspect only the relevant code. Do not modify files. Reply with a numbered plan (max 8 lines) and key risks.' },
  design: { title: 'Design architecture', tier: 'balanced', effort: 'high', reason: 'architecture/security decisions need deeper reasoning',
    objective: 'Make the design decisions this change needs (interfaces, data model, security approach). Do not write code yet. Reply with the decisions as a concise list.' },
  implement: { title: 'Implement', tier: 'fast', effort: 'medium', reason: 'implementation follows the agreed plan',
    objective: 'Implement the change following the plan and decisions so far. Keep changes minimal. Reply with a short summary of the files changed.' },
  test: { title: 'Write and run tests', tier: 'fast', effort: 'medium', reason: 'tests are routine work',
    objective: 'Add or update focused tests for this change and run them. Reply with the test command and whether it passed.' },
  fix: { title: 'Fix failing checks', tier: 'balanced', effort: 'high', reason: 'previous stage left failures',
    objective: 'Investigate and fix the failures listed under known_issues without redoing completed work. Re-run the failing checks. Reply with the cause, the fix and the final result.' },
  review: { title: 'Security review', tier: 'balanced', effort: 'high', reason: 'security-sensitive review',
    objective: 'Review the changes made in this task for security problems (authn/authz, injection, secrets, input validation) and fix real issues. Reply with findings and fixes.' },
  docs: { title: 'Update documentation', tier: 'fast', effort: 'low', reason: 'documentation is light work',
    objective: 'Update the relevant documentation for this change. Reply with the files updated.' },
};

const CUE = {
  design: /\b(architect\w*|design|schema|data model|rbac|permissions?|authori[sz]ation|refresh tokens?|multi-?tenant|migrations?)\b/i,
  tests: /\b(tests?|testing|unit tests?|e2e|coverage|pengujian|tes)\b/i,
  review: /\b(security|secure|review|audit|keamanan|vulnerab\w*)\b/i,
  docs: /\b(docs?|documentation|readme|dokumentasi)\b/i,
};
// Drop order when over the stage budget: the least essential first; "implement" always stays.
const DROP: StageType[] = ['docs', 'analyze', 'design', 'test', 'review'];

/**
 * Deterministic stage plan (no LLM). Simple requests return [] and keep the single-turn path:
 * staging only happens when the route is hard/critical or the prompt clearly asks for several kinds of work.
 */
export function planStages(task: string, route: Route, cfg: RouterConfig): Stage[] {
  const sc = cfg.stages;
  if (!sc.enabled) return [];
  const cues = { design: CUE.design.test(task), tests: CUE.tests.test(task), review: CUE.review.test(task) || route.tier === 'critical', docs: CUE.docs.test(task) };
  const heavy = route.tier === 'hard' || route.tier === 'critical';
  const cueCount = Object.values(cues).filter(Boolean).length;
  if (!heavy && cueCount < 2) return [];
  const types: StageType[] = [];
  if (heavy) types.push('analyze');
  if (cues.design || route.tier === 'critical') types.push('design');
  types.push('implement');
  if (cues.tests || route.tier === 'critical') types.push('test');
  if (cues.review) types.push('review');
  if (cues.docs) types.push('docs');
  // leave room for one inserted fix stage
  for (const d of DROP) if (types.length > Math.max(1, sc.max_stages - 1) && types.includes(d)) types.splice(types.indexOf(d), 1);
  if (types.length < 2) return [];
  return types.map((t) => makeStage(t));
}

const makeStage = (type: StageType, tier = DEF[type].tier, reason = DEF[type].reason): Stage =>
  ({ id: `stage_${randomUUID().slice(0, 8)}`, type, title: DEF[type].title, tier, effort: DEF[type].effort, status: 'pending', attempts: 0, escalation: 0, reason });

/** Compact, structured hand-off kept by Lumina across stages (the thread itself keeps the full conversation). */
export interface ExecutionContext {
  task: string; completed: string[]; current_stage: string; modified_files: string[]; known_issues: string[]; pending: string[]; constraints: string[];
}

const TEST_CMD = /\b(vitest|jest|mocha|pytest|phpunit|rspec|go test|cargo test|node --test|npm (run )?test|pnpm (run )?test|yarn test|bun test|make test)\b/;
const STUCK = /\b(unable to|could not|cannot|can't) (fix|resolve|determine|figure out|make (it|the tests?) pass)\b|\bstill fail(s|ing)\b/i;

/** Signals read from a finished stage. "Tests failing" uses only the last test run of the stage, not any non-zero exit. */
export function analyzeStage(items: TurnItem[] = []): { files: string[]; testsFailed: boolean; stuck: boolean; outcome: string; failures: string[] } {
  const files = [...new Set(items.flatMap((i) => i.files ?? []))];
  const tests = items.filter((i) => i.type === 'commandExecution' && i.command && TEST_CMD.test(i.command));
  const last = tests.at(-1);
  const testsFailed = Boolean(last && typeof last.exitCode === 'number' && last.exitCode !== 0);
  const message = items.filter((i) => i.type === 'agentMessage' && i.text).at(-1)?.text ?? '';
  const failures = testsFailed ? [`tests still failing (exit ${last!.exitCode}) after \`${last!.command!.replace(/^\S*sh -lc /, '').slice(0, 80)}\``] : [];
  return { files, testsFailed, stuck: STUCK.test(message), outcome: message.replace(/\s+/g, ' ').trim().slice(0, 160), failures };
}

export interface RoutingLog {
  level: 'info' | 'warn'; event: string; request_id: string; execution_id: string; stage_id?: string; stage_type?: string;
  previous_model?: string | null; selected_model?: string; routing_reason?: string; escalation_level?: number;
  execution_duration_ms?: number; retry_count?: number; switch_count?: number; routing_strategy: 'single' | 'staged'; status?: string; [k: string]: unknown;
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
  /** `models` are the models each stage will start on (validated against the catalog). */
  planned(stages: Stage[], models: string[]): void;
  stageStart(stage: Stage, index: number, total: number, sel: Selection, switched?: { from: string; to: string; reason: string }): void;
  stageEnd(stage: Stage, index: number, total: number): void;
  notice(text: string): void;
}

export interface StageDeps {
  cfg: RouterConfig;
  catalog: ModelInfo[];
  /** Runs one turn on the current thread with an explicit model/effort (the real switch). */
  send(prompt: string, sel: Selection, first: boolean): Promise<TurnResult>;
  interrupt(): Promise<unknown>;
  cancelled(): boolean;
  hooks: StageHooks;
  log?: (e: RoutingLog) => void;
  requestId?: string;
}

export interface ExecutionResult { status: 'completed' | 'failed' | 'cancelled'; error?: string; stages: Stage[]; switches: number; escalations: number }

/**
 * Runs a planned request as successive turns on ONE thread, each with its own model/effort (Codex cannot change the
 * model inside a running turn, so stage = turn). Escalates on meaningful signals (turn failure, tests still failing,
 * model reports being stuck), returns to each stage's base tier afterwards, and is bounded by the configured limits.
 */
export class StagedExecution {
  readonly id = `exec_${randomUUID().slice(0, 12)}`;
  readonly ctx: ExecutionContext;
  private switches = 0;
  private escalations = 0;
  private prevModel: string | null = null;

  constructor(private readonly task: string, readonly stages: Stage[], private readonly deps: StageDeps, constraints: string[] = []) {
    this.ctx = { task: task.replace(/\s+/g, ' ').trim().slice(0, 200), completed: [], current_stage: '', modified_files: [], known_issues: [], pending: [], constraints: ['do not redo completed stages', ...constraints] };
  }

  private log(e: Omit<RoutingLog, 'request_id' | 'execution_id' | 'routing_strategy'>): void {
    const entry = { request_id: this.deps.requestId ?? this.id, execution_id: this.id, routing_strategy: 'staged', switch_count: this.switches, ...e } as RoutingLog;
    (this.deps.log ?? ((x) => logRouting(x, this.deps.cfg)))(entry);
  }

  /** Model for a tier, validated against the installed catalog; unavailable models fall back safely. */
  private select(tier: Tier, effort: string): Selection & { note?: string } {
    const want = this.deps.cfg.stages.tiers[tier];
    const r = resolveModel(this.deps.catalog, want, effort, false, this.deps.cfg.stages.tiers.fast);
    return { model: r.model, effort: r.effort, note: r.note };
  }

  private prompt(stage: Stage, i: number, total: number): string {
    this.ctx.current_stage = stage.title;
    this.ctx.pending = this.stages.slice(i + 1).filter((s) => s.status === 'pending').map((s) => s.title);
    const last = i === total - 1 || this.ctx.pending.length === 0;
    const parts = [`[Lumina stage ${i + 1}/${total}: ${stage.title}]`, `Handoff: ${JSON.stringify(this.ctx)}`, `Objective: ${DEF[stage.type].objective}`];
    if (i === 0) parts.push(`User request:\n${this.task}`); // the only time the full request is sent; later stages rely on the thread + handoff
    if (last) parts.push('This is the final stage: finish with a concise summary for the user of everything done across all stages.');
    return parts.join('\n\n');
  }

  async run(): Promise<ExecutionResult> {
    const { cfg, hooks } = this.deps;
    const lim = cfg.stages;
    hooks.planned(this.stages, this.stages.map((s) => this.select(s.tier, s.effort).model ?? ''));
    this.log({ level: 'info', event: 'plan_created', status: `${this.stages.length} stages`, stage_type: this.stages.map((s) => s.type).join('>') });
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
        let sel = this.select(tier, effort);
        let switched: { from: string; to: string; reason: string } | undefined;
        if (this.prevModel && sel.model !== this.prevModel) {
          if (this.switches >= lim.max_switches) { // limit reached: stay on the current model
            this.log({ level: 'warn', event: 'switch_limit_reached', stage_id: stage.id, stage_type: stage.type, selected_model: this.prevModel, routing_reason: `wanted ${sel.model}` });
            sel = { model: this.prevModel, effort: sel.effort };
          } else {
            this.switches++;
            switched = { from: this.prevModel, to: sel.model!, reason: stage.reason };
            this.log({ level: 'info', event: 'model_switched', stage_id: stage.id, stage_type: stage.type, previous_model: this.prevModel, selected_model: sel.model, routing_reason: stage.reason, escalation_level: stage.escalation });
          }
        }
        if (sel.note) this.log({ level: 'warn', event: 'model_fallback', stage_id: stage.id, stage_type: stage.type, selected_model: sel.model, routing_reason: sel.note });
        stage.model = sel.model;
        hooks.stageStart(stage, i, this.stages.length, sel, switched);
        this.log({ level: 'info', event: 'stage_started', stage_id: stage.id, stage_type: stage.type, previous_model: this.prevModel, selected_model: sel.model, routing_reason: stage.reason, escalation_level: stage.escalation, retry_count: stage.attempts - 1 });
        const t0 = Date.now();
        let result: TurnResult;
        try {
          result = await this.withTimeout(this.deps.send(this.prompt(stage, i, this.stages.length), { model: sel.model, effort: sel.effort }, i === 0 && stage.attempts === 1), lim.stage_timeout_ms);
        } catch (e) {
          result = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
        }
        stage.ms = (stage.ms ?? 0) + Date.now() - t0;
        this.prevModel = sel.model ?? this.prevModel;
        const sig = analyzeStage(result.items);
        for (const f of sig.files) if (!this.ctx.modified_files.includes(f)) this.ctx.modified_files.push(f);
        this.ctx.modified_files = this.ctx.modified_files.slice(-30);

        if (result.status === 'interrupted' || this.deps.cancelled()) { stage.status = 'skipped'; stage.outcome = 'cancelled'; status = 'cancelled'; break; }
        if (result.status === 'failed') {
          const kind = classifyFailure(result.error ?? '');
          const rejectedModel = /model/i.test(result.error ?? '') && /(not (supported|available)|unsupported|unknown|invalid)/i.test(result.error ?? '');
          if (rejectedModel && sel.model !== cfg.stages.tiers.fast && stage.attempts <= lim.max_retries) {
            this.log({ level: 'warn', event: 'model_rejected', stage_id: stage.id, stage_type: stage.type, selected_model: sel.model, routing_reason: 'backend rejected model; falling back' });
            tier = 'fast'; continue;
          }
          if (kind === 'coding' && stage.attempts <= lim.max_retries && this.escalations < lim.max_escalations && tier !== 'advanced') {
            tier = TIER_ORDER[TIER_ORDER.indexOf(tier) + 1]; effort = 'high'; stage.escalation++; this.escalations++;
            this.log({ level: 'warn', event: 'escalated', stage_id: stage.id, stage_type: stage.type, selected_model: this.select(tier, effort).model, routing_reason: 'stage failed', escalation_level: stage.escalation, retry_count: stage.attempts });
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
        // Dynamic replanning: insert a fix stage (escalated one tier per consecutive fix) when real problems remain.
        const problem = sig.testsFailed || (sig.stuck && ['implement', 'fix', 'test'].includes(stage.type));
        if (problem) {
          const fixes = this.stages.filter((s) => s.type === 'fix').length;
          const nextTier = TIER_ORDER[Math.min(TIER_ORDER.indexOf(stage.type === 'fix' ? stage.tier : 'fast') + 1, 2)];
          if (fixes < lim.max_retries && this.escalations < lim.max_escalations && this.stages.length < lim.max_stages) {
            const fix = makeStage('fix', nextTier, sig.testsFailed ? 'tests still failing after previous stage' : 'previous stage reported it could not resolve the problem');
            fix.escalation = TIER_ORDER.indexOf(nextTier);
            this.escalations++;
            this.stages.splice(i + 1, 0, fix);
            this.log({ level: 'warn', event: 'escalated', stage_id: fix.id, stage_type: 'fix', selected_model: this.select(nextTier, 'high').model, routing_reason: fix.reason, escalation_level: fix.escalation });
          } else {
            this.log({ level: 'warn', event: 'escalation_limit_reached', stage_id: stage.id, stage_type: stage.type, routing_reason: 'problems remain' });
            if (stage.type === 'fix' || stage.type === 'test') { failure = `${stage.title}: ${sig.failures[0] ?? 'problem unresolved'}`; status = 'failed'; }
          }
        } else if (stage.type === 'fix') this.ctx.known_issues = []; // resolved
        break;
      }
      hooks.stageEnd(stage, i, this.stages.length);
      this.log({ level: stage.status === 'failed' ? 'warn' : 'info', event: 'stage_completed', stage_id: stage.id, stage_type: stage.type, selected_model: stage.model, status: stage.status, execution_duration_ms: stage.ms, retry_count: stage.attempts - 1, escalation_level: stage.escalation });
      if (status !== 'completed') break;
    }
    for (const s of this.stages) if (s.status === 'pending') s.status = 'skipped';
    this.log({ level: status === 'completed' ? 'info' : 'warn', event: 'execution_finished', status, escalation_level: this.escalations });
    return { status, error: failure, stages: this.stages, switches: this.switches, escalations: this.escalations };
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
