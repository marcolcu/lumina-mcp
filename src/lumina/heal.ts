import { createHash } from 'node:crypto';
import type { RouterConfig } from '../smart-codex/config.js';
import type { ModelInfo } from '../smart-codex/models.js';
import { ExecutionPlan, Stage, StageDeps, StageHooks, StagedExecution, TIER_ORDER, Tier, raiseEffort } from './stages.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
import type { Selection, TurnItem, TurnResult } from './tui/chat.js';
import type { Budget } from './budget.js';
import type { Change, CheckResult, Impact, Level, Verification } from './verify.js';

/**
 * Self-healing: when verification finds failures Lumina's change caused, run a focused repair as a `fix` stage of the
 * existing stage engine (same model selection, switching limits, context isolation, approvals and logging), then
 * re-verify. Classification is deterministic; only code failures lead to code changes. Bounded by attempts,
 * escalations and failure signatures (the same failure twice without progress stops the loop).
 */
export type HealClass = 'CODE_FAILURE' | 'ENVIRONMENT_FAILURE' | 'TRANSIENT_FAILURE' | 'PRE_EXISTING_FAILURE' | 'UNKNOWN_FAILURE';

const TRANSIENT = /\b(ECONNRESET|EAI_AGAIN|ETIMEDOUT|EBUSY|ETXTBSY)\b|socket hang up|\b(429|502|503)\b|rate.?limit|temporarily unavailable|try again later|text file busy|database is locked/i;
const ERROR_LINE = /error|fail|assert|expected|exception|panic|undefined|cannot|✗|×|not ok/i;
const LOCATION = /(?:file:\/\/)?((?:\/|\.{0,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)*\.(?:[cm]?[jt]sx?|go|py|rs|vue|svelte))(?=[:(\s'"]|$)/g;

/** Repository-relative file paths mentioned in output (absolute paths under `root` are made relative). */
export function errorLocations(output: string, root: string): string[] {
  const out = new Set<string>();
  for (const m of output.matchAll(LOCATION)) {
    let p = m[1];
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
    else if (p.startsWith('/')) continue; // outside the repository (node internals, toolchains)
    p = p.replace(/^\.\//, '');
    if (!p.startsWith('..') && !p.includes('node_modules/')) out.add(p);
  }
  return [...out];
}

/** Deterministic class of a failed check: whether Lumina's change caused it and whether code changes can help. */
export function healClass(r: CheckResult, impact: Impact, root: string): { cls: HealClass; reason: string } {
  const out = r.output ?? r.tail ?? '';
  if (TRANSIENT.test(out)) return { cls: 'TRANSIENT_FAILURE', reason: 'temporary error (network, lock or busy resource)' };
  if (r.failure === 'missing dependency' || r.failure === 'external service unavailable') return { cls: 'ENVIRONMENT_FAILURE', reason: r.failure };
  if (r.failure === 'environment problem') return /timed out after/.test(out) ? { cls: 'UNKNOWN_FAILURE', reason: 'the check timed out' } : { cls: 'ENVIRONMENT_FAILURE', reason: r.failure };
  if (r.failure?.startsWith('unrelated')) return { cls: 'PRE_EXISTING_FAILURE', reason: 'failing tests are unrelated to the changed files' };
  const scope = new Set([...impact.changes.map((c) => c.path), ...impact.importerFiles, ...impact.tests]);
  const locs = errorLocations(out, root);
  if (locs.length) {
    return locs.some((l) => scope.has(l) || [...scope].some((s) => s.endsWith(`/${l}`)))
      ? { cls: 'CODE_FAILURE', reason: `${r.failure} in ${locs.filter((l) => scope.has(l)).slice(0, 3).join(', ') || locs[0]}` }
      : { cls: 'PRE_EXISTING_FAILURE', reason: `errors only in files this change did not touch (${locs.slice(0, 3).join(', ')})` };
  }
  // only the tests of the changed files ran: their failure is this change's
  if (r.check.kind === 'related') return { cls: 'CODE_FAILURE', reason: `${r.failure} in the related tests` };
  return { cls: 'UNKNOWN_FAILURE', reason: 'the output does not show where the failure is' };
}

const errorLines = (out: string) => out.split('\n').map((l) => l.trim()).filter((l) => l && ERROR_LINE.test(l)).slice(-20);
/** Same failure = same checks failing with the same error lines (line/column positions, times and hashes ignored). */
export function signature(failed: CheckResult[]): string {
  const h = createHash('sha1');
  for (const r of [...failed].sort((a, b) => a.check.command.localeCompare(b.check.command))) {
    h.update(`${r.check.command}|${r.failure}|`);
    for (const l of errorLines(r.output ?? r.tail ?? '')) h.update(l.replace(/\b[0-9a-f]{7,}\b/g, '#').replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '').replace(/\(\d+,\d+\)|:\d+(:\d+)?\b/g, ':L')).update('\n');
  }
  return h.digest('hex');
}

/** Compact evidence for the repair prompt: the failing command and its error lines, nothing else. */
export function failureBrief(r: CheckResult, root: string): string {
  const lines = errorLines(r.output ?? r.tail ?? '').map((l) => l.replace(`${root}/`, '').slice(0, 220));
  return `\`${r.check.command}\` → ${r.failure} (exit ${r.exitCode}):\n${(lines.length ? lines : (r.tail ?? '').split('\n').slice(-8)).join('\n')}`.slice(0, 1400);
}

export interface HealDeps {
  cfg: RouterConfig;
  catalog: ModelInfo[];
  root: string;
  request: string;
  changes: Change[];
  /** Model of the turn that made the change (its tier is where repairs start). */
  startModel?: string;
  /** Reasoning effort of the turn that made the change. */
  startEffort?: string;
  /** The request's budget: each repair is additional work and must fit (checked before it starts). */
  budget?: Budget;
  stage: Pick<StageDeps, 'send' | 'interrupt' | 'cancelled' | 'context' | 'compact' | 'log'>;
  hooks: StageHooks;
  /** Re-runs verification at `level` for the given changes (Codex's own runs in `items` may be reused). */
  verify(changes: Change[], items: TurnItem[], level: Level): Promise<Verification | undefined>;
  /** Wraps each repair in a checkpoint; returns the files the repair changed. */
  checkpoint?: { begin(task: string): Promise<void>; finish(cancelled: boolean): Promise<Change[]> };
  ui: { attempt(n: number, max: number, sel: Selection, reason: string, brief: string): void; repairEnd(ok: boolean): void; notice(text: string): void };
}
export interface HealOutcome {
  status: 'not-needed' | 'repaired' | 'exhausted' | 'stopped' | 'cancelled' | 'skipped';
  attempts: number; escalations: number; models: string[]; /** Reasoning effort actually sent per attempt. */ efforts: string[]; reason: string; last?: Verification;
  classes: { check: string; cls: HealClass; reason: string }[];
}

const up = (t: Tier): Tier => TIER_ORDER[Math.min(TIER_ORDER.indexOf(t) + 1, TIER_ORDER.length - 1)];

export async function selfHeal(v0: Verification, d: HealDeps): Promise<HealOutcome> {
  const lim = d.cfg.self_healing;
  const tiers = d.cfg.stages.tiers;
  const start: Tier = (TIER_ORDER.find((t) => tiers[t] === d.startModel) ?? 'fast');
  let v = v0;
  let attempts = 0;
  let escalations = 0;
  let transient = 0;
  let tier: Tier | undefined;
  let effort: string | undefined;
  const models: string[] = [];
  const efforts: string[] = [];
  const seen: string[] = [];
  let changes = [...d.changes];
  const out = (status: HealOutcome['status'], reason: string, classes: HealOutcome['classes'] = []): HealOutcome => ({ status, attempts, escalations, models, efforts, reason, last: v, classes });

  for (;;) {
    const failed = v.results.filter((r) => r.status === 'failed');
    if (!failed.length) return attempts ? out('repaired', 'verification passed') : out('not-needed', 'nothing failed');
    const classes = failed.map((r) => ({ r, ...healClass(r, v.impact, d.root) }));
    const summary = classes.map((c) => ({ check: c.r.check.label, cls: c.cls, reason: c.reason }));
    const code = classes.filter((c) => c.cls === 'CODE_FAILURE').map((c) => c.r);
    if (!lim.enabled) return out('skipped', 'self_healing.enabled = false', summary);
    if (!code.length) {
      if (classes.some((c) => c.cls === 'TRANSIENT_FAILURE') && transient < lim.transient_retries && !d.stage.cancelled()) {
        transient++;
        d.ui.notice(`Transient failure (${classes.find((c) => c.cls === 'TRANSIENT_FAILURE')!.reason}); re-running the checks once, code unchanged`);
        v = (await d.verify(changes, [], v.level === 'off' ? 'quick' : v.level)) ?? v;
        continue;
      }
      return out('skipped', 'no failure this change caused that code edits can fix', summary);
    }
    if (d.stage.cancelled()) return out('cancelled', 'cancelled', summary);
    const sig = signature(code);
    const repeated = seen.filter((s) => s === sig).length;
    if (attempts >= lim.max_repair_attempts) return out('exhausted', `${attempts} attempt${attempts === 1 ? '' : 's'} used`, summary);
    const room = d.budget?.allow('repair', 'high');
    if (room && !room.ok) { d.budget!.stop(room.reason, [`repair: ${code.map((r) => r.check.label).join(', ')}`]); return out('stopped', `budget exhausted (${room.reason})`, summary); }

    // model: start where the change was made; harder failures start one tier up; no progress → one tier up (bounded)
    const complex = new Set(code.map((r) => r.check.kind)).size >= 2 || new Set(code.flatMap((r) => errorLocations(r.output ?? '', d.root))).size >= 3
      || code.some((r) => errorLines(r.output ?? '').length >= 15) || v.impact.flags.critical || v.impact.flags.shared;
    // reasoning is raised before the model: a deeper pass on the same model keeps its prompt cache
    let reason: string;
    if (!tier) {
      tier = complex && start !== 'advanced' && up(start) !== 'advanced' ? up(start) : start;
      const base = d.startEffort && EFFORTS.indexOf(d.startEffort) >= 1 ? d.startEffort : 'medium'; // a repair never runs on low reasoning
      effort = complex ? raiseEffort(base) : base;
      reason = complex ? 'several or wide failures' : 'same model and reasoning that made the change';
    } else if (repeated) {
      const next = up(tier);
      if (escalations >= lim.max_escalations) return out('stopped', 'the same failure remains and the escalation limit is reached', summary);
      if (EFFORTS.indexOf(effort!) < EFFORTS.indexOf('high')) { effort = raiseEffort(effort!); escalations++; reason = `the previous fix did not change the failure: more reasoning (${effort}) on the same model`; }
      else if (next !== tier && (next !== 'advanced' || complex)) { tier = next; escalations++; reason = 'the previous fix did not change the failure even with high reasoning: stronger model'; }
      else return out('stopped', 'the same failure remains and no stronger model is justified', summary);
    } else reason = 'previous fix made progress; same model and reasoning';
    seen.push(sig);
    attempts++;

    const fix: Stage = { id: `stage_heal${attempts}`, type: 'fix', title: 'Fix failing checks', tier, effort: effort!, status: 'pending', attempts: 0, escalation: escalations, reason };
    const plan: ExecutionPlan = { strategy: 'adaptive', stages: [fix], reviewAfter: false, adaptive: false }; // one turn per attempt; this loop owns retries
    const briefs = code.map((r) => failureBrief(r, d.root));
    const task = `Repair the failing checks after the last change (original request: "${d.request.split('\n')[0].slice(0, 160)}"). Make the smallest fix; then re-run: ${code.map((r) => `\`${r.check.command}\``).join(', ')}.`;
    const items: TurnItem[] = [];
    const exec = new StagedExecution(task, plan, {
      ...d.stage, cfg: d.cfg, catalog: d.catalog,
      send: (p, s, o) => d.stage.send(p, s, o).then((res: TurnResult) => { items.push(...(res.items ?? [])); return res; }),
      budget: undefined, // the repair loop does its own budget accounting below
      hooks: { ...d.hooks, stageStart: (st, i, n, s, sw) => { models.push(s.model ?? '?'); efforts.push(s.effort ?? '?'); d.ui.attempt(attempts, lim.max_repair_attempts, s, reason, briefs.join('\n')); d.hooks.stageStart(st, i, n, s, sw); } },
    }, {});
    // compact, focused hand-off instead of the conversation: errors, files, constraints, previous attempts
    exec.ctx.completed = [`original request implemented: ${d.request.split('\n')[0].slice(0, 120)}`];
    exec.ctx.modified_files = changes.map((c) => c.path).slice(0, 30);
    exec.ctx.known_issues = briefs;
    exec.ctx.constraints = ['fix only the listed failures with minimal changes', 'keep all working changes; do not restart the original task', 'no unrelated refactoring', 'do not weaken or delete tests unless the test itself is wrong', 'if the failure needs a missing tool, service or dependency, stop and say so instead of changing code',
      ...(attempts > 1 ? [`attempt ${attempts}: the previous repair ${repeated ? 'did not change the failure' : 'changed but did not clear the failure'}`] : [])];
    await d.checkpoint?.begin(`self-heal attempt ${attempts}: ${d.request.split('\n')[0]}`);
    d.budget?.beginTurn();
    const r = await exec.run();
    if (d.budget) { d.budget.repairs++; d.budget.turn(r.usageReported ? r.usage : undefined); }
    const repaired = (await d.checkpoint?.finish(r.status === 'cancelled')) ?? [];
    d.ui.repairEnd(r.status === 'completed');
    if (r.status === 'cancelled' || d.stage.cancelled()) return out('cancelled', 'cancelled', summary);
    for (const c of repaired) if (!changes.some((x) => x.path === c.path)) changes.push(c);
    changes = changes.length ? changes : d.changes;
    v = (await d.verify(changes, items, v.level === 'off' ? 'quick' : v.level)) ?? v;
  }
}
