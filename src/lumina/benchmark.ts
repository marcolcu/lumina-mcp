import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RouterConfig, stateDir } from '../smart-codex/config.js';
import { ModelInfo } from '../smart-codex/models.js';
import { Compactor } from './compaction.js';
import { StagedExecution, planExecution } from './stages.js';
import { TicketSession, readingSelection } from './ticket.js';
import { TurnRouter } from './tui/routing.js';
import type { Selection, TokenBreakdown, TurnItem, TurnResult } from './tui/chat.js';

/**
 * Routing benchmark suite (extends bench/routing.bench.ts, which now runs it with --suite). MOCK mode routes each
 * scenario with the real router and drives the real stage engine with scripted turn results: no model calls, fully
 * deterministic, checked against policy expectations (e.g. simple work stays on the efficient model, high risk stays
 * high). REAL mode — only on explicit request — executes runnable scenarios through Codex in throwaway repositories,
 * several samples each, and reports provider-reported tokens, duration and verification. Results are stored (bounded)
 * so later runs can be compared; mock expectations and real observations are never mixed.
 */
export interface Expect {
  tiers?: string[]; models?: string[]; efforts?: string[]; risk?: string[]; complexity?: [number, number];
  strategy?: string[]; plannedStages?: number; stages?: [number, number]; switches?: [number, number];
  readOnly?: boolean; sticky?: boolean; compaction?: boolean; referenceUsed?: boolean;
}
export interface Scenario {
  id: string; name: string;
  /** Messages in order; earlier ones build conversation state, the last one is measured. */
  turns: string[];
  ticket?: boolean;
  /** Scripted items per executed turn of the measured request (mock mode). */
  mock?: (turn: number) => TurnItem[];
  /** Compaction scenario: the context Codex would report and how many turns preceded. */
  context?: { used: number; window: number; turns: number };
  /** Runnable for real: fixture files and the command that verifies the result. */
  real?: { files: Record<string, string>; verify: string[] };
  expect: Expect;
}

const pass = (): TurnItem => ({ type: 'commandExecution', command: "/bin/zsh -lc 'node --test'", exitCode: 0 });
const fail = (): TurnItem => ({ type: 'commandExecution', command: "/bin/zsh -lc 'node --test'", exitCode: 1 });
const edit = (f: string): TurnItem => ({ type: 'fileChange', files: [f] });
const BACKEND_DOC = `## Orders API (backend team)\n\n${Array.from({ length: 30 }, (_, i) => `- Field ${i}: order_${i} is a string with authentication token rules, payments and migrations notes for the billing service.`).join('\n')}\n\n## Error codes\n${Array.from({ length: 10 }, (_, i) => `| E${i} | refund failure ${i} |`).join('\n')}`;
const TICKET = `OP-559: Show order status badge on the order list page\n\nDescription:\n${Array.from({ length: 12 }, (_, i) => `- Requirement ${i}: the badge colour follows the status mapping table (paid, pending, refunded ${i}).`).join('\n')}`;
const JS_FIXTURE = {
  'package.json': JSON.stringify({ name: 'bench', type: 'module', scripts: { test: 'node --test' } }),
  'src/math.js': 'export function sum(a, b) {\n  return a + b;\n}\n',
  'src/app.js': "import { sum } from './math.js';\nexport const total = (xs) => xs.reduce((a, x) => sum(a, x), 0);\n",
  'test/math.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/math.js';\ntest('adds', () => assert.equal((m.add ?? m.sum)(2, 3), 5));\n",
};

export const SCENARIOS: Scenario[] = [
  { id: 'rename', name: 'Simple rename', turns: ['Rename the function `sum` to `add` in src/math.js and update its usages.'], mock: () => [edit('src/math.js')],
    real: { files: JS_FIXTURE, verify: ['node', '--test'] }, expect: { tiers: ['fast', 'normal'], efforts: ['low', 'medium'], risk: ['low'], plannedStages: 1, stages: [1, 1], switches: [0, 0], complexity: [0, 5] } },
  { id: 'endpoint', name: 'Single-page endpoint change', turns: ['Only update the order list endpoint on this one page to sort by created date.'], mock: () => [edit('src/orders.ts')],
    expect: { tiers: ['fast', 'normal'], efforts: ['low', 'medium'], risk: ['low'], plannedStages: 1, stages: [1, 1] } },
  { id: 'pasted-docs', name: 'Long pasted backend documentation', turns: [`Add pagination to the orders list request in the frontend client.\n\n${BACKEND_DOC}`], mock: () => [edit('src/api/orders.ts')],
    expect: { tiers: ['normal'], efforts: ['medium'], risk: ['low'], referenceUsed: true, plannedStages: 1 } },
  { id: 'security-review', name: 'Simple security review', turns: ['Review authentication security'], mock: () => [],
    expect: { tiers: ['critical'], efforts: ['medium'], risk: ['high'], plannedStages: 1, stages: [1, 1] } },
  { id: 'auth-impl', name: 'Complex authentication implementation', turns: ['Implement JWT refresh token rotation with revocation in the auth middleware and add tests.'], mock: () => [edit('src/auth.ts'), pass()],
    expect: { tiers: ['critical'], efforts: ['high'], risk: ['high'], complexity: [7, 10] } },
  { id: 'migration', name: 'Database migration', turns: ['Write a database migration that adds a non-null status column to orders with a backfill.'], mock: () => [edit('migrations/0002.sql')],
    expect: { tiers: ['critical'], risk: ['high'], efforts: ['high', 'medium'] } },
  { id: 'refactor', name: 'Multi-module refactor', turns: ['Refactor src/math.js and src/csv.js across all modules to share a common validation helper, keep behavior, and run the tests.'], mock: () => [edit('src/validate.js'), pass()],
    real: { files: { ...JS_FIXTURE, 'src/csv.js': "export function splitLine(line) {\n  return line.split(',');\n}\n" }, verify: ['node', '--test'] }, expect: { tiers: ['hard'], efforts: ['high'], risk: ['medium', 'low'], plannedStages: 1 } },
  { id: 'debug', name: 'Failing test debugging', turns: ['Fix the failing tests in test/date.test.js; run node --test to check.'], mock: (n) => [edit('src/date.js'), n < 1 ? fail() : pass()],
    real: { files: { 'package.json': JS_FIXTURE['package.json'], 'src/date.js': 'export function daysInMonth(year, month) {\n  return new Date(year, month, 0).getDate() + 1;\n}\n', 'test/date.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { daysInMonth } from '../src/date.js';\ntest('feb leap', () => assert.equal(daysInMonth(2024, 2), 29));\n" }, verify: ['node', '--test'] },
    expect: { tiers: ['normal', 'fast'], stages: [2, 2], switches: [1, 1] } },
  { id: 'ticket-understand', name: 'OpenProject ticket understanding', ticket: true, turns: ['Tolong jelaskan tiket OP-559 dulu sebelum dikerjakan'], mock: () => [],
    expect: { readOnly: true, models: ['fast'], efforts: ['low', 'medium'], plannedStages: 1 } },
  { id: 'ticket-implement', name: 'Confirmed ticket implementation', ticket: true, turns: [`Jelaskan tiket ini\n\n${TICKET}`, 'badge untuk refunded pakai warna abu-abu ya', 'oke kerjakan'], mock: () => [edit('src/orders/Badge.tsx'), pass()],
    expect: { readOnly: false, tiers: ['fast', 'normal'], risk: ['low'], plannedStages: 1 } },
  { id: 'long-conversation', name: 'Long conversation (vague follow-up keeps the selection)', turns: ['Fix payment webhook signature verification', 'ok do it'], mock: () => [edit('src/webhooks.ts')],
    expect: { sticky: true, models: ['critical'], efforts: ['high'] } },
  { id: 'escalation', name: 'Model escalation after repeated failure', turns: ['Add a parseCsv(text) function in src/csv.js that handles quoted fields, with node:test tests, and run the tests.'], mock: (n) => [edit('src/csv.js'), n < 2 ? fail() : pass()],
    expect: { stages: [3, 3], switches: [1, 2] } },
  { id: 'compaction', name: 'Context compaction', turns: ['Continue with the next refactoring step'], context: { used: 200_000, window: 250_000, turns: 8 }, mock: () => [edit('src/x.ts')],
    expect: { compaction: true } },
];

export interface ScenarioResult {
  id: string; name: string; mode: 'mock' | 'real';
  route: { tier: string; model: string; effort: string; complexity: number; risk: string; referenceChars: number };
  strategy: string; plannedStages: number; stages: number; switches: number; escalations: number; models: string[];
  readOnly: boolean; sticky: boolean; compaction?: boolean;
  checks: { name: string; ok: boolean; expected: string; actual: string }[];
  /** Real mode only: provider-reported, per sample. */
  samples?: { usage?: TokenBreakdown; ms: number; status: string; verified?: boolean; stages: number; switches: number }[];
}

/** Policy checks: simple work never needs an expensive model; risky work keeps its classification. */
function check(s: Scenario, r: Omit<ScenarioResult, 'checks'>, cfg: RouterConfig): ScenarioResult['checks'] {
  const e = s.expect;
  const out: ScenarioResult['checks'] = [];
  const add = (name: string, ok: boolean, expected: string, actual: string) => out.push({ name, ok, expected, actual });
  const model = (m: string) => (Object.entries(cfg.models).find(([, v]) => v === m)?.[0] ?? (Object.entries(cfg.stages.tiers).find(([, v]) => v === m)?.[0] === 'fast' ? 'fast' : m));
  if (e.tiers) add('tier', e.tiers.includes(r.route.tier), e.tiers.join('|'), r.route.tier);
  if (e.models) add('model', e.models.some((t) => (cfg.models as Record<string, string>)[t] === r.route.model || cfg.stages.tiers[t as 'fast'] === r.route.model), e.models.join('|'), `${r.route.model} (${model(r.route.model)})`);
  if (e.efforts) add('reasoning', e.efforts.includes(r.route.effort), e.efforts.join('|'), r.route.effort);
  if (e.risk) add('risk', e.risk.includes(r.route.risk), e.risk.join('|'), r.route.risk);
  if (e.complexity) add('complexity', r.route.complexity >= e.complexity[0] && r.route.complexity <= e.complexity[1], `${e.complexity[0]}–${e.complexity[1]}`, String(r.route.complexity));
  if (e.strategy) add('strategy', e.strategy.includes(r.strategy), e.strategy.join('|'), r.strategy);
  if (e.plannedStages !== undefined) add('planned stages', r.plannedStages === e.plannedStages, String(e.plannedStages), String(r.plannedStages));
  if (e.stages) add('stages', r.stages >= e.stages[0] && r.stages <= e.stages[1], `${e.stages[0]}–${e.stages[1]}`, String(r.stages));
  if (e.switches) add('model switches', r.switches >= e.switches[0] && r.switches <= e.switches[1], `${e.switches[0]}–${e.switches[1]}`, String(r.switches));
  if (e.readOnly !== undefined) add('read-only', r.readOnly === e.readOnly, String(e.readOnly), String(r.readOnly));
  if (e.sticky !== undefined) add('kept previous selection', r.sticky === e.sticky, String(e.sticky), String(r.sticky));
  if (e.compaction !== undefined) add('compaction', r.compaction === e.compaction, String(e.compaction), String(r.compaction));
  if (e.referenceUsed) add('pasted reference not judged', r.route.referenceChars > 0, '>0 chars set aside', String(r.route.referenceChars));
  // global policy: the cheapest tier's model for trivial tiers
  if (r.route.tier === 'fast') add('simple task on the efficient model', r.route.model === cfg.models.fast, cfg.models.fast, r.route.model);
  return out;
}

/** Routes a scenario exactly as the TUI does (ticket workflow, vague follow-ups, read-only ticket turns). */
function routeScenario(s: Scenario, cfg: RouterConfig, catalog: ModelInfo[]) {
  const router = new TurnRouter(cfg, '/nonexistent', catalog);
  const ticket = new TicketSession();
  let last;
  for (const msg of s.turns) {
    const tturn = s.ticket ? ticket.prepare(msg) : undefined;
    let pick = router.pick(tturn?.routeText ?? msg);
    const reading = Boolean(tturn?.readOnly);
    if (reading) pick = { ...pick, sel: readingSelection(pick.route, msg, ticket, catalog, cfg) };
    if (tturn) ticket.afterTurn('understood: order list badge', [], true);
    last = { pick, prompt: tturn?.prompt ?? msg, reading, text: msg };
  }
  return last!;
}

/** MOCK: no model calls; the real router and stage engine with scripted turn results. */
export async function runMock(cfg: RouterConfig, catalog: ModelInfo[], ids?: string[]): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const s of SCENARIOS.filter((x) => !ids?.length || ids.includes(x.id))) {
    const { pick, prompt, reading } = routeScenario(s, cfg, catalog);
    const plan = reading ? undefined : planExecution(prompt, pick.route, cfg, pick.sel);
    let n = 0;
    const sent: Selection[] = [];
    let stages = 1; let switches = 0; let escalations = 0; let models = [pick.sel.model ?? '?'];
    if (plan && plan.strategy !== 'direct') {
      const exec = new StagedExecution(prompt, plan, {
        cfg: { ...cfg, analytics: { ...cfg.analytics, enabled: false } }, catalog,
        send: async (_p, sel) => { sent.push(sel); return { status: 'completed', items: [...(s.mock?.(n++) ?? []), { type: 'agentMessage', text: 'ok' }] } as TurnResult; },
        interrupt: async () => undefined, cancelled: () => false,
        hooks: { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: () => undefined }, log: () => undefined,
      }, pick.sel);
      const r = await exec.run();
      stages = r.stages.filter((x) => x.status !== 'skipped').length; switches = r.switches; escalations = r.escalations; models = r.models;
    }
    let compaction: boolean | undefined;
    if (s.context) {
      const c = new Compactor(cfg.stages, async () => true);
      for (let i = 0; i < s.context.turns; i++) c.turnDone(s.context);
      compaction = c.decide(s.context).compact;
    }
    const base = {
      id: s.id, name: s.name, mode: 'mock' as const,
      route: { tier: pick.route.tier, model: pick.sel.model ?? pick.route.model, effort: pick.sel.effort ?? pick.route.reasoning_effort, complexity: pick.route.complexity_score, risk: pick.route.risk, referenceChars: pick.route.reference_chars },
      strategy: plan?.strategy ?? 'direct', plannedStages: plan?.stages.length ?? 1, stages, switches, escalations, models, readOnly: reading, sticky: pick.sticky, compaction,
    };
    out.push({ ...base, checks: check(s, base, cfg) });
  }
  return out;
}

export interface RealDeps {
  /** Starts an isolated Codex session in `cwd` and returns a send function plus a closer. */
  session(cwd: string): Promise<{ send(prompt: string, sel: Selection, isolated: boolean): Promise<TurnResult>; context(): { used: number; window: number | null } | undefined; compact(): Promise<boolean>; close(): Promise<void> }>;
}

/** REAL: explicit opt-in only. Each sample gets a fresh temporary repository; production repositories are never used. */
export async function runReal(cfg: RouterConfig, catalog: ModelInfo[], deps: RealDeps, opts: { confirmed: boolean; samples: number; ids?: string[]; onProgress?(msg: string): void }): Promise<ScenarioResult[]> {
  if (!opts.confirmed) throw new Error('real benchmarks run real Codex turns (subscription quota) and need explicit confirmation');
  if (!Number.isInteger(opts.samples) || opts.samples < 1 || opts.samples > 10) throw new Error('samples must be an integer from 1 to 10');
  const runnable = SCENARIOS.filter((s) => s.real && (!opts.ids?.length || opts.ids.includes(s.id)));
  if (!runnable.length) throw new Error(`no runnable scenario${opts.ids?.length ? ` among ${opts.ids.join(', ')}` : ''}; runnable: ${SCENARIOS.filter((s) => s.real).map((s) => s.id).join(', ')}`);
  const mock = await runMock(cfg, catalog, runnable.map((s) => s.id));
  const out: ScenarioResult[] = [];
  for (const s of runnable) {
    const m = mock.find((x) => x.id === s.id)!;
    const samples: NonNullable<ScenarioResult['samples']> = [];
    for (let k = 0; k < opts.samples; k++) {
      opts.onProgress?.(`${s.name} · sample ${k + 1}/${opts.samples}`);
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-bench-')));
      for (const [f, c] of Object.entries(s.real!.files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
      execFileSync('git', ['init', '-q'], { cwd: dir });
      execFileSync('git', ['add', '-A'], { cwd: dir });
      const sess = await deps.session(dir);
      const t0 = Date.now();
      try {
        const { pick, prompt } = routeScenario(s, cfg, catalog);
        const plan = planExecution(prompt, pick.route, cfg, pick.sel);
        const exec = new StagedExecution(prompt, plan, { cfg, catalog, send: (p, sel, o) => sess.send(p, sel, o.isolated), interrupt: async () => undefined, cancelled: () => false, context: () => sess.context(), compact: () => sess.compact(), hooks: { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: () => undefined } }, pick.sel);
        const r = await exec.run();
        let verified: boolean | undefined;
        try { execFileSync(s.real!.verify[0], s.real!.verify.slice(1), { cwd: dir, stdio: 'ignore', timeout: 120_000 }); verified = true; } catch { verified = false; }
        samples.push({ usage: r.usageReported ? r.usage : undefined, ms: Date.now() - t0, status: r.status, verified, stages: r.stages.filter((x) => x.status !== 'skipped').length, switches: r.switches });
      } finally { await sess.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); }
    }
    out.push({ ...m, mode: 'real', samples, checks: m.checks });
  }
  return out;
}

const median = (xs: number[]) => { if (!xs.length) return undefined; const s = [...xs].sort((a, b) => a - b); const i = Math.floor(s.length / 2); return s.length % 2 ? s[i] : Math.round((s[i - 1] + s[i]) / 2); };
export function aggregate(samples: NonNullable<ScenarioResult['samples']>) {
  const reported = samples.filter((x) => x.usage);
  return {
    samples: samples.length, reported: reported.length,
    input: median(reported.map((x) => x.usage!.inputTokens)), cached: median(reported.map((x) => x.usage!.cachedInputTokens)), output: median(reported.map((x) => x.usage!.outputTokens)),
    ms: median(samples.map((x) => x.ms)), stages: median(samples.map((x) => x.stages)), switches: median(samples.map((x) => x.switches)),
    verified: samples.filter((x) => x.verified).length,
  };
}

// ---- storage and regression detection ----------------------------------------------------------------------------------
export interface StoredRun { at: number; mode: 'mock' | 'real'; results: ScenarioResult[] }
const MAX_RUNS = 30;
export const resultsFile = () => path.join(stateDir(), 'benchmarks.jsonl');

export function saveRun(run: StoredRun, file = resultsFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const keep = loadRuns(file).slice(-(MAX_RUNS - 1));
  fs.writeFileSync(`${file}.tmp`, `${[...keep, run].map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}
export function loadRuns(file = resultsFile()): StoredRun[] {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out: StoredRun[] = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { const r = JSON.parse(l) as StoredRun; if ((r.mode === 'mock' || r.mode === 'real') && Array.isArray(r.results)) out.push(r); } catch { /* skip */ } }
  return out;
}

/**
 * Regressions against the previous run of the same mode. Mock: any change in model, reasoning, tier, risk or stage
 * count is reported (deterministic, so a change is real). Real: only with 3+ samples on both sides, and only clear
 * differences (tokens +25%, verification rate down), since real runs vary.
 */
export function regressions(prev: StoredRun | undefined, cur: StoredRun): string[] {
  if (!prev) return [];
  const out: string[] = [];
  for (const c of cur.results) {
    const p = prev.results.find((x) => x.id === c.id);
    if (!p) continue;
    if (cur.mode === 'mock') {
      for (const [k, a, b] of [['model', p.route.model, c.route.model], ['reasoning', p.route.effort, c.route.effort], ['tier', p.route.tier, c.route.tier], ['risk', p.route.risk, c.route.risk], ['stages', String(p.stages), String(c.stages)], ['planned stages', String(p.plannedStages), String(c.plannedStages)]] as const) {
        if (a !== b) out.push(`${c.id}: ${k} changed ${a} → ${b}`);
      }
      continue;
    }
    if (!p.samples || !c.samples || p.samples.length < 3 || c.samples.length < 3) continue;
    const pa = aggregate(p.samples); const ca = aggregate(c.samples);
    if (pa.input && ca.input && ca.input > pa.input * 1.25) out.push(`${c.id}: median input tokens ${pa.input.toLocaleString('en-US')} → ${ca.input.toLocaleString('en-US')} (provider-reported)`);
    if (pa.output && ca.output && ca.output > pa.output * 1.25) out.push(`${c.id}: median output tokens ${pa.output.toLocaleString('en-US')} → ${ca.output.toLocaleString('en-US')} (provider-reported)`);
    if (ca.verified / c.samples.length < pa.verified / p.samples.length - 0.2) out.push(`${c.id}: verified results ${pa.verified}/${p.samples.length} → ${ca.verified}/${c.samples.length}`);
  }
  return out;
}

export function formatRun(cur: StoredRun, prev: StoredRun | undefined): string {
  const out = [`Routing Benchmark · ${cur.mode === 'mock' ? 'MOCK (no model calls; deterministic expectations)' : 'REAL (Codex executions; observed, provider-reported)'} · ${cur.results.length} scenario${cur.results.length === 1 ? '' : 's'}`, ''];
  for (const r of cur.results) {
    const bad = r.checks.filter((c) => !c.ok);
    out.push(`${bad.length ? '✗' : '✓'} ${r.name} [${r.id}]: ${r.route.model}/${r.route.effort} · ${r.route.tier} · risk ${r.route.risk} · complexity ${r.route.complexity} · ${r.strategy} · stages ${r.stages}${r.switches ? ` · switches ${r.switches}` : ''}${r.readOnly ? ' · read-only' : ''}${r.sticky ? ' · kept previous selection' : ''}${r.compaction !== undefined ? ` · compaction ${r.compaction ? 'yes' : 'no'}` : ''}`);
    for (const c of bad) out.push(`    expected ${c.name} ${c.expected}, got ${c.actual}`);
    if (r.samples) {
      const a = aggregate(r.samples);
      out.push(`    ${a.samples} sample${a.samples === 1 ? '' : 's'} · verified ${a.verified}/${a.samples} · median ${a.ms !== undefined ? `${Math.round(a.ms / 1000)}s` : '—'} · stages ${a.stages} · switches ${a.switches} · ${a.reported ? `median tokens in ${a.input?.toLocaleString('en-US')} / cached ${a.cached?.toLocaleString('en-US')} / out ${a.output?.toLocaleString('en-US')} (${a.reported}/${a.samples} reported)` : 'tokens not reported'}`);
    }
  }
  const failed = cur.results.flatMap((r) => r.checks.filter((c) => !c.ok));
  const reg = regressions(prev, cur);
  out.push('', `Expectations: ${cur.results.reduce((n, r) => n + r.checks.length, 0) - failed.length}/${cur.results.reduce((n, r) => n + r.checks.length, 0)} passed`);
  out.push(prev ? (reg.length ? `Changes since the previous ${cur.mode} run (${new Date(prev.at).toISOString().slice(0, 16).replace('T', ' ')}):\n${reg.map((x) => `  - ${x}`).join('\n')}` : `No changes since the previous ${cur.mode} run.`) : `No previous ${cur.mode} run to compare with.`);
  if (cur.mode === 'mock') out.push('Mock results are expectations of the routing logic, not measured performance. Real runs: /benchmark real [samples] [scenario ids] (uses Codex quota; asks first).');
  else out.push('Real results are observations from these runs; differences under 3 samples per side are not treated as regressions. No savings are claimed without such measurements.');
  return out.join('\n');
}
