/**
 * Routing benchmark: legacy fixed-pipeline routing (bench/legacy, frozen snapshot) vs the current adaptive routing.
 *
 *   npx tsx bench/routing.bench.ts                 # mock: exact stage/turn/switch counts on scripted executions (no model calls)
 *   npx tsx bench/routing.bench.ts --real 1,2,3    # real Codex App Server runs (uses your subscription quota), provider-reported tokens
 *
 * Every scenario runs on an identical fresh fixture repo for both variants. Results are written to bench/results/.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema } from '../src/smart-codex/config.js';
import { loadCatalog, ModelInfo } from '../src/smart-codex/models.js';
import { route } from '../src/smart-codex/router.js';
import { StagedExecution, planExecution } from '../src/lumina/stages.js';
import { Chat, TokenBreakdown, TurnItem, TurnResult } from '../src/lumina/tui/chat.js';
import { AppServerClient } from '../src/lumina/appserver/client.js';
import { route as legacyRoute } from './legacy/router.legacy.js';
import { StagedExecution as LegacyExecution, planStages as legacyPlan } from './legacy/stages.legacy.js';

interface Scenario { id: number; name: string; task: string; /** mock: items each successive turn returns */ mock: (turn: number) => TurnItem[] }
const pass = (): TurnItem => ({ type: 'commandExecution', command: "/bin/zsh -lc 'node --test'", exitCode: 0 });
const fail = (): TurnItem => ({ type: 'commandExecution', command: "/bin/zsh -lc 'node --test'", exitCode: 1 });
const edit = (f: string): TurnItem => ({ type: 'fileChange', files: [f] });
export const SCENARIOS: Scenario[] = [
  { id: 1, name: 'simple code change', task: 'Rename the function `sum` to `add` in src/math.js and update its usages.', mock: () => [edit('src/math.js')] },
  { id: 2, name: 'small security review', task: 'Create math.js exporting add(a, b), add tests using node:test and run them, then do a short security review.', mock: () => [edit('math.js'), pass()] },
  { id: 3, name: 'medium feature', task: 'Add a parseCsv(text) function in src/csv.js that handles quoted fields, with node:test tests, and run the tests.', mock: () => [edit('src/csv.js'), pass()] },
  { id: 4, name: 'complex architecture', task: 'Design and implement a plugin system with a registry, lifecycle hooks, database migrations for plugin state, tests and documentation.', mock: () => [edit('src/plugins.js'), pass()] },
  { id: 5, name: 'multi-module refactor', task: 'Refactor src/math.js and src/csv.js across all modules to share a common validation helper, keep behavior, and run the tests.', mock: () => [edit('src/validate.js'), pass()] },
  { id: 6, name: 'debugging, repeated failures', task: 'Fix the failing tests in test/date.test.js; run node --test to check.', mock: (n) => [edit('src/date.js'), n < 2 ? fail() : pass()] },
];

function fixture(scenario: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-bench-'));
  const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
  w('package.json', JSON.stringify({ name: 'bench', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  w('src/math.js', 'export function sum(a, b) {\n  return a + b;\n}\n');
  w('src/app.js', "import { sum } from './math.js';\nexport const total = (xs) => xs.reduce((a, x) => sum(a, x), 0);\n");
  w('src/csv.js', "export function splitLine(line) {\n  return line.split(',');\n}\n");
  w('test/math.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as m from '../src/math.js';\ntest('adds', () => assert.equal((m.add ?? m.sum)(2, 3), 5));\n");
  // deliberate bug, only in scenario 6's repo: months are 0-based and the weekend check is off
  if (scenario === 6) w('src/date.js', "export function daysInMonth(year, month) {\n  return new Date(year, month, 0).getDate() + 1;\n}\nexport function isWeekend(d) {\n  return d.getDay() === 6;\n}\n");
  if (scenario === 6) w('test/date.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { daysInMonth, isWeekend } from '../src/date.js';\ntest('february leap', () => assert.equal(daysInMonth(2024, 2), 29));\ntest('april', () => assert.equal(daysInMonth(2023, 4), 30));\ntest('sunday is weekend', () => assert.equal(isWeekend(new Date(2024, 0, 7)), true));\n");
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

interface Run { variant: 'legacy' | 'optimized'; scenario: number; escalations?: string[]; testCommands?: string[]; strategy: string; stages: number; turns: number; switches: number; models: string[]; usage?: TokenBreakdown; ms: number; status: string; testsPass?: boolean }
const sumUsage = (a: TokenBreakdown | undefined, b?: TokenBreakdown): TokenBreakdown | undefined => (!b ? a : { totalTokens: (a?.totalTokens ?? 0) + b.totalTokens, inputTokens: (a?.inputTokens ?? 0) + b.inputTokens, cachedInputTokens: (a?.cachedInputTokens ?? 0) + b.cachedInputTokens, outputTokens: (a?.outputTokens ?? 0) + b.outputTokens });
const hooks = { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: () => undefined };

async function runVariant(variant: Run['variant'], s: Scenario, catalog: ModelInfo[], send: (p: string, sel: { model?: string; effort?: string }, isolated: boolean) => Promise<TurnResult>, chat?: Chat): Promise<Run> {
  const t0 = Date.now();
  let turns = 0;
  let usage: TokenBreakdown | undefined;
  const models: string[] = [];
  const testCommands: string[] = [];
  const counted = async (p: string, sel: { model?: string; effort?: string }, isolated = false) => {
    turns++; models.push(sel.model ?? '?');
    const r = await send(p, sel, isolated);
    usage = sumUsage(usage, r.usage);
    for (const i of r.items ?? []) if (i.type === 'commandExecution' && /test/.test(i.command ?? '')) testCommands.push(`turn ${turns}: exit ${i.exitCode} · ${i.command?.slice(0, 120)}`);
    return r;
  };
  if (variant === 'legacy') {
    const cfg = ConfigSchema.parse({ stages: { max_stages: 8, max_switches: 8 }, analytics: { enabled: false } }); // legacy defaults
    const rt = legacyRoute({ task: s.task, repository: '/nonexistent' }, cfg, catalog);
    const stages = legacyPlan(s.task, rt as never, cfg);
    if (!stages.length) { const r = await counted(s.task, { model: rt.model, effort: rt.reasoning_effort }); return { variant, scenario: s.id, strategy: 'single', stages: 1, turns, switches: 0, models, usage, ms: Date.now() - t0, status: r.status }; }
    const exec = new LegacyExecution(s.task, stages, { cfg, catalog, send: (p, sel) => counted(p, sel), interrupt: async () => undefined, cancelled: () => false, hooks: { ...hooks, planned: () => undefined } as never, log: () => undefined });
    const r = await exec.run();
    return { variant, scenario: s.id, strategy: 'fixed pipeline', stages: r.stages.filter((x) => x.status !== 'skipped').length, turns, switches: r.switches, models, usage, ms: Date.now() - t0, status: r.status };
  }
  const cfg = ConfigSchema.parse({ analytics: { enabled: false } });
  const rt = route({ task: s.task, repository: '/nonexistent' }, cfg, catalog);
  const plan = planExecution(s.task, rt, cfg, { model: rt.model, effort: rt.reasoning_effort });
  const reasons: string[] = [];
  const exec = new StagedExecution(s.task, plan, { cfg, catalog, send: (p, sel, o) => counted(p, sel, o.isolated), interrupt: async () => undefined, cancelled: () => false, context: () => chat?.contextTokens(), compact: chat ? () => chat.compact() : undefined, hooks, log: (e) => { if (e.event === 'escalated' || e.event === 'stage_added') reasons.push(String(e.routing_reason)); } }, { model: rt.model, effort: rt.reasoning_effort });
  const r = await exec.run();
  return { escalations: reasons, testCommands, variant, scenario: s.id, strategy: r.strategy, stages: r.stages.filter((x) => x.status !== 'skipped').length, turns, switches: r.switches, models, usage, ms: Date.now() - t0, status: r.status };
}

async function mock(): Promise<Run[]> {
  const catalog: ModelInfo[] = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra'].map((slug) => ({ slug, efforts: ['low', 'medium', 'high', 'xhigh'] }));
  const out: Run[] = [];
  for (const s of SCENARIOS) for (const v of ['legacy', 'optimized'] as const) {
    let n = 0;
    out.push(await runVariant(v, s, catalog, async () => ({ status: 'completed', items: [...s.mock(n++), { type: 'agentMessage', text: 'ok' }] })));
  }
  return out;
}

async function real(ids: number[], variants: Run['variant'][]): Promise<Run[]> {
  const catalog = loadCatalog();
  const out: Run[] = [];
  for (const s of SCENARIOS.filter((x) => ids.includes(x.id))) for (const v of variants) {
    const dir = fixture(s.id);
    const client = new AppServerClient({ cwd: dir });
    await client.start();
    const chat = new Chat(client, { cwd: dir, onDelta: () => undefined, policy: { approvalPolicy: 'never', sandbox: 'workspace-write' } });
    try {
      process.stderr.write(`scenario ${s.id} (${s.name}) · ${v}…\n`);
      const r = await runVariant(v, s, catalog, (p, sel, isolated) => chat.send(p, sel, [], { isolated }), chat);
      try { execFileSync('node', ['--test'], { cwd: dir, stdio: 'ignore', timeout: 60000 }); r.testsPass = true; } catch { r.testsPass = false; }
      // keep the agent's last messages for diagnosing escalations (no prompts are stored)
      out.push(r);
    } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  return out;
}

function table(runs: Run[], realMode: boolean): string {
  const rows = runs.map((r) => {
    const s = SCENARIOS.find((x) => x.id === r.scenario)!;
    const tok = r.usage ? `${r.usage.inputTokens} / ${r.usage.cachedInputTokens} / ${r.usage.outputTokens}` : realMode ? 'not reported' : 'n/a (mock)';
    return `| ${r.scenario}. ${s.name} | ${r.variant} | ${r.strategy} | ${r.stages} | ${r.turns} | ${r.switches} | ${[...new Set(r.models)].join(', ')} | ${tok} | ${realMode ? `${Math.round(r.ms / 1000)}s` : '-'} | ${r.status}${r.testsPass === undefined ? '' : r.testsPass ? ', tests pass' : ', tests FAIL'} |`;
  });
  return ['| scenario | variant | strategy | stages | turns | switches | models | tokens in / cached / out | time | result |', '|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n');
}

const args = process.argv.slice(2);
const realIdx = args.indexOf('--real');
const realMode = realIdx >= 0;
const ids = realMode ? (args[realIdx + 1] ?? '1,2,3,4,5,6').split(',').map(Number) : [];
const vIdx = args.indexOf('--variant');
const variants = (vIdx >= 0 ? [args[vIdx + 1]] : ['legacy', 'optimized']) as Run['variant'][];
const runs = realMode ? await real(ids, variants) : await mock();
const md = table(runs, realMode);
const file = path.join('bench', 'results', `routing-${realMode ? `real-${ids.join('_')}-${variants.join('_')}` : 'mock'}-${new Date().toISOString().slice(0, 10)}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ mode: realMode ? 'real' : 'mock', date: new Date().toISOString(), runs }, null, 2));
console.log(md);
console.log(`\nwritten: ${file}`);
