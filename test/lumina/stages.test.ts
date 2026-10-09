import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { ModelInfo } from '../../src/smart-codex/models.js';
import { route } from '../../src/smart-codex/router.js';
import { RoutingLog, StagedExecution, analyzeStage, planExecution, startTier } from '../../src/lumina/stages.js';
import type { Selection, TokenBreakdown, TurnItem, TurnResult } from '../../src/lumina/tui/chat.js';

const CAT: ModelInfo[] = [
  { slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
  { slug: 'gpt-6-astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
];
const cfgOf = (stages: Record<string, unknown> = {}) => ConfigSchema.parse({ stages, analytics: { enabled: false } });
const r = (task: string, cfg = cfgOf()) => route({ task, repository: '/nonexistent' }, cfg, CAT);
const planOf = (task: string, cfg = cfgOf()) => { const rt = r(task, cfg); return planExecution(task, rt, cfg, { model: rt.model, effort: rt.reasoning_effort }); };

const U = (input: number, cached: number, output: number): TokenBreakdown => ({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, totalTokens: input + output });
const ok = (items: TurnItem[] = [], text = 'done', usage?: TokenBreakdown): TurnResult => ({ status: 'completed', items: [...items, { type: 'agentMessage', text }], usage });
const testRun = (exit: number): TurnItem => ({ type: 'commandExecution', command: "/bin/zsh -lc 'npm test'", exitCode: exit, status: exit ? 'failed' : 'completed' });
const edit = (...files: string[]): TurnItem => ({ type: 'fileChange', files, status: 'completed' });

function harness(task: string, results: (TurnResult | ((i: number) => TurnResult | Promise<TurnResult>))[], cfg = cfgOf(), opts: { cancelAfter?: number; context?: () => { used: number; window: number | null } | undefined; compactOk?: boolean } = {}) {
  const calls: { prompt: string; sel: Selection; first: boolean; isolated: boolean }[] = [];
  const logs: RoutingLog[] = [];
  const starts: string[] = [];
  let interrupts = 0;
  let compacts = 0;
  const rt = r(task, cfg);
  const plan = planExecution(task, rt, cfg, { model: rt.model, effort: rt.reasoning_effort });
  const exec = new StagedExecution(task, plan, {
    cfg, catalog: CAT,
    send: async (prompt, sel, o) => {
      calls.push({ prompt, sel, first: o.first, isolated: o.isolated });
      const x = results[Math.min(calls.length - 1, results.length - 1)];
      return typeof x === 'function' ? x(calls.length - 1) : x;
    },
    interrupt: async () => { interrupts++; },
    cancelled: () => opts.cancelAfter !== undefined && calls.length >= opts.cancelAfter,
    context: opts.context,
    compact: async () => { compacts++; return opts.compactOk ?? true; },
    hooks: { planned: () => undefined, stageStart: (s, _i, _n, sel, sw) => { starts.push(`${s.type}:${sel.model}${sw ? `:switch ${sw.from}->${sw.to}` : ''}`); }, stageEnd: () => undefined, notice: () => undefined },
    log: (e) => logs.push(e),
  }, { model: rt.model, effort: rt.reasoning_effort });
  return { exec, calls, logs, starts, plan, interrupts: () => interrupts, compacts: () => compacts };
}
const used = (calls: { sel: Selection }[]) => calls.map((c) => `${c.sel.model}/${c.sel.effort}`);

afterEach(() => { vi.useRealTimers(); });

describe('planning: one stage unless execution needs more', () => {
  it.each([
    'update the button text', 'Implement user CRUD', 'Add CSV export with tests and update the docs',
    'Create math.js exporting add(a, b), add tests using node:test and run them, then do a short security review.',
    'Review this authentication middleware', 'Refactor the database layer across multiple modules', 'Build an authentication system with JWT, refresh tokens, tests, and security review.',
  ])('%s → one stage', (task) => {
    const p = planOf(task);
    expect(p.stages.map((s) => s.type)).toEqual(['task']);
    expect(p.strategy).toBe('adaptive');
  });
  it('"security review" names an activity, not a risk: a small task with a review stays fast and low-risk', () => {
    const t = 'Create math.js exporting add(a, b), add tests using node:test and run them, then do a short security review.';
    expect([r(t).tier, r(t).risk]).toEqual(['normal', 'low']);
    expect(planOf(t).reviewAfter).toBe(false);
    expect(planOf(t).stages[0].tier).toBe('fast');
  });
  it('risk changes the model, not the stage count', () => {
    const review = planOf('Review this authentication middleware');
    expect([review.stages.length, review.stages[0].tier, review.reviewAfter]).toEqual([1, 'balanced', false]);
    const impl = planOf('Implement refresh token rotation and do a security review');
    expect([impl.stages.length, impl.stages[0].tier, impl.reviewAfter]).toEqual([1, 'balanced', true]); // review only after real changes
  });
  it('genuinely complex work is orchestrated (design → implement), still within the stage budget', () => {
    const t = 'Design and implement multi-tenant RBAC with database migrations, tests and documentation across all services';
    const p = planOf(t);
    expect(p.strategy).toBe('orchestrated');
    expect(p.stages.map((s) => `${s.type}/${s.tier}`)).toEqual(['design/balanced', 'implement/fast']);
    expect(planOf(t, cfgOf({ max_stages: 1 })).stages).toHaveLength(1);
  });
  it('starting tier: complex + high risk can start on the advanced model immediately', () => {
    expect(startTier({ ...r('x'), risk: 'high', base_complexity: 9, tier: 'critical' })).toBe('advanced');
    expect(startTier({ ...r('x'), risk: 'high', base_complexity: 3, tier: 'critical' })).toBe('balanced');
    expect(startTier(r('update the button text'))).toBe('fast');
  });
  it('execution_strategy=direct and disabled stages give plain single turns without escalation', () => {
    expect(planOf('Implement user CRUD', cfgOf({ execution_strategy: 'direct' }))).toMatchObject({ strategy: 'direct', adaptive: false });
    expect(planOf('Implement user CRUD', cfgOf({ enabled: false })).strategy).toBe('direct');
  });
});

describe('execution', () => {
  it('a successful simple task is one turn: the request verbatim, on the router\'s own model, no extra stages', async () => {
    const h = harness('Implement user CRUD', [ok([edit('src/users.ts')])]);
    const res = await h.exec.run();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ prompt: 'Implement user CRUD', first: true, isolated: false });
    expect(used(h.calls)).toEqual(['gpt-6-luna/medium']);
    expect([res.status, res.strategy, res.switches]).toEqual(['completed', 'adaptive', 0]);
  });
  it('high-risk change with requested review: review stage added only because files changed; same model, no switch', async () => {
    const h = harness('Implement refresh token rotation and do a security review', [ok([edit('src/auth/refresh.ts')]), ok()]);
    const res = await h.exec.run();
    expect(res.stages.map((s) => s.type)).toEqual(['task', 'review']);
    expect(used(h.calls)).toEqual(['gpt-6-sol/high', 'gpt-6-sol/high']);
    expect(res.switches).toBe(0);
    const none = harness('Implement refresh token rotation and do a security review', [ok()]);
    expect((await none.exec.run()).stages).toHaveLength(1); // nothing changed → nothing to review
  });
  it('failed straightforward task: bounded escalation fast → balanced → advanced, then a clear failure', async () => {
    const h = harness('Implement user CRUD', [{ status: 'failed', error: 'patch did not apply' }]);
    const res = await h.exec.run();
    expect(used(h.calls)).toEqual(['gpt-6-luna/medium', 'gpt-6-sol/high', 'gpt-6-astra/high']);
    expect(res.status).toBe('failed');
    expect(res.escalations).toBe(2);
    expect(h.calls[1].prompt).toContain('previous attempt failed: patch did not apply');
  });
  it('trivial command failures do not escalate; environment failures stop immediately', async () => {
    const h = harness('Implement user CRUD', [ok([{ type: 'commandExecution', command: 'ls nope', exitCode: 1 }])]);
    expect((await h.exec.run()).escalations).toBe(0);
    const env = harness('Implement user CRUD', [{ status: 'failed', error: 'rate limit exceeded' }]);
    const e = await env.exec.run();
    expect(env.calls).toHaveLength(1);
    expect(e.error).toMatch(/rate_limit/);
  });
  it('tests still failing → lazy fix stages one tier at a time; later stages return to their base tier unless the switch penalty applies', async () => {
    const t = 'Implement refresh token rotation and do a security review';
    const results = [ok([edit('a.ts'), testRun(1)]), ok([testRun(0)]), ok()];
    const h = harness(t, results);
    const res = await h.exec.run();
    expect(res.stages.map((s) => s.type)).toEqual(['task', 'fix', 'review']);
    expect(used(h.calls)).toEqual(['gpt-6-sol/high', 'gpt-6-astra/high', 'gpt-6-astra/high']); // penalty: no step down for the final short stage
    expect(h.logs.some((l) => l.event === 'switch_skipped')).toBe(true);
    const np = harness(t, results, cfgOf({ model_switch_penalty: false }));
    await np.exec.run();
    expect(used(np.calls)).toEqual(['gpt-6-sol/high', 'gpt-6-astra/high', 'gpt-6-sol/high']); // de-escalation back to the review's tier
  });
  it('a fast task that fails tests escalates to balanced and returns to fast for nothing else (single remaining stage)', async () => {
    const h = harness('Add CSV export with tests', [ok([testRun(1)]), ok([testRun(0)])]);
    const res = await h.exec.run();
    expect(used(h.calls)).toEqual(['gpt-6-luna/medium', 'gpt-6-sol/high']);
    expect([res.strategy, res.switches, res.escalations]).toEqual(['adaptive', 1, 1]);
  });
  it('no duplicate execution: completed stages are never re-run, and every turn is a distinct stage or bounded retry', async () => {
    const h = harness('Add CSV export with tests', [ok([testRun(1)]), ok([testRun(0)])]);
    await h.exec.run();
    expect(h.calls.filter((c) => c.prompt === 'Add CSV export with tests')).toHaveLength(1);
    expect(h.calls[1].prompt).toMatch(/do not redo/i);
  });
  it('orchestrated: design on balanced, implement on fast; the full request is sent once', async () => {
    const t = 'Design and implement multi-tenant RBAC with database migrations, tests and documentation across all services';
    const h = harness(t, [ok([], 'decisions'), ok([edit('rbac.ts')])]);
    const res = await h.exec.run();
    expect(used(h.calls)).toEqual(['gpt-6-sol/high', 'gpt-6-luna/medium']);
    expect(h.calls[0].prompt).toContain(`User request:\n${t}`);
    expect(h.calls[1].prompt).not.toContain('User request');
    expect(res.strategy).toBe('orchestrated');
  });
});

describe('context isolation and compaction', () => {
  const t = 'Add CSV export with tests';
  it('small history → extra stage shares the thread with a compact hand-off (no request repeated)', async () => {
    const h = harness(t, [ok([testRun(1)]), ok([testRun(0)])], cfgOf(), { context: () => ({ used: 5000, window: 250000 }) });
    await h.exec.run();
    expect(h.calls[1].isolated).toBe(false);
    expect(h.calls[1].prompt).not.toContain('User request');
    expect(h.calls[1].prompt).toMatch(/Handoff: \{.*"known_issues":\["tests still failing/);
  });
  it('large history → extra stage runs on a fresh thread with request + hand-off only', async () => {
    const h = harness(t, [ok([edit('csv.ts'), testRun(1)]), ok([testRun(0)])], cfgOf(), { context: () => ({ used: 90000, window: 250000 }) });
    const res = await h.exec.run();
    expect(h.calls[1].isolated).toBe(true);
    expect(h.calls[1].prompt).toContain(`User request:\n${t}`);
    expect(JSON.parse(/Handoff: (\{.*\})/.exec(h.calls[1].prompt)![1]).modified_files).toEqual(['csv.ts']);
    expect(res.stages[1].thread).toBe('isolated');
    expect(h.compacts()).toBe(0); // isolated stages never compact the main thread
  });
  it('forced strategies are honoured; the first stage is always the main conversation', async () => {
    const iso = harness(t, [ok([testRun(1)]), ok([testRun(0)])], cfgOf({ context_strategy: 'isolated' }), { context: () => ({ used: 10, window: 1000 }) });
    await iso.exec.run();
    expect(iso.calls.map((c) => c.isolated)).toEqual([false, true]);
    const sh = harness(t, [ok([testRun(1)]), ok([testRun(0)])], cfgOf({ context_strategy: 'shared' }), { context: () => ({ used: 900000, window: 1000000 }) });
    await sh.exec.run();
    expect(sh.calls.map((c) => c.isolated)).toEqual([false, false]);
  });
  it('compaction only when a shared stage would start near the context window; never after every stage', async () => {
    const near = harness(t, [ok([testRun(1)]), ok([testRun(0)])], cfgOf({ context_strategy: 'shared' }), { context: () => ({ used: 190000, window: 250000 }) });
    const res = await near.exec.run();
    expect(near.compacts()).toBe(1);
    expect(res.compactions).toBe(1);
    const small = harness(t, [ok([testRun(1)]), ok([testRun(0)])], cfgOf({ context_strategy: 'shared' }), { context: () => ({ used: 20000, window: 250000 }) });
    await small.exec.run();
    expect(small.compacts()).toBe(0);
    const never = harness(t, [ok([testRun(1)]), ok([testRun(0)])], cfgOf({ context_strategy: 'shared', compaction_strategy: 'never' }), { context: () => ({ used: 240000, window: 250000 }) });
    await never.exec.run();
    expect(never.compacts()).toBe(0);
    const failing = harness(t, [ok([testRun(1)]), ok([testRun(0)])], cfgOf({ context_strategy: 'shared' }), { context: () => ({ used: 240000, window: 250000 }), compactOk: false });
    expect((await failing.exec.run()).compactions).toBe(0);
    expect(failing.logs.some((l) => l.event === 'compaction_failed')).toBe(true);
  });
});

describe('token accounting, logs, cancellation, timeout, fallback', () => {
  it('sums provider-reported per-turn usage; marks usage unavailable when not reported', async () => {
    const h = harness('Add CSV export with tests', [ok([testRun(1)], 'x', U(20000, 15000, 300)), ok([testRun(0)], 'y', U(8000, 7000, 120))]);
    const res = await h.exec.run();
    expect(res.usage).toEqual({ inputTokens: 28000, cachedInputTokens: 22000, outputTokens: 420, totalTokens: 28420 });
    expect(res.usageReported).toBe(true);
    const fin = h.logs.find((l) => l.event === 'execution_finished')!;
    expect(fin).toMatchObject({ token_source: 'provider', input_tokens: 28000, cached_input_tokens: 22000, output_tokens: 420, stages: 2, models: 'gpt-6-luna,gpt-6-sol', compactions: 0 });
    const none = harness('Implement user CRUD', [ok()]);
    const n = await none.exec.run();
    expect(n.usageReported).toBe(false);
    expect(none.logs.find((l) => l.event === 'execution_finished')).toMatchObject({ token_source: 'unavailable' });
  });
  it('routing logs carry the required fields and never the prompt', async () => {
    const secret = 'SECRET-PROMPT-TEXT';
    const h = harness(`Add CSV export with tests ${secret}`, [ok([testRun(1)]), ok([testRun(0)])]);
    await h.exec.run();
    const sw = h.logs.find((l) => l.event === 'model_switched')!;
    for (const k of ['request_id', 'execution_id', 'stage_id', 'stage_type', 'previous_model', 'selected_model', 'routing_reason', 'escalation_level', 'switch_count', 'routing_strategy']) expect(sw, k).toHaveProperty(k);
    expect(JSON.stringify(h.logs)).not.toContain(secret);
  });
  it('cancellation and interruption stop without further turns', async () => {
    const h = harness('Add CSV export with tests', [ok([testRun(1)])], cfgOf(), { cancelAfter: 1 });
    expect((await h.exec.run()).status).toBe('cancelled');
    expect(h.calls).toHaveLength(1);
    const i = harness('Implement user CRUD', [{ status: 'interrupted' }]);
    expect((await i.exec.run()).status).toBe('cancelled');
  });
  it('timeout interrupts and reports failure', async () => {
    vi.useFakeTimers();
    const h = harness('Implement user CRUD', [() => new Promise<TurnResult>(() => undefined)], cfgOf({ stage_timeout_ms: 10000 }));
    const p = h.exec.run();
    await vi.advanceTimersByTimeAsync(10001);
    const res = await p;
    expect(h.interrupts()).toBe(1);
    expect(res.error).toMatch(/timed out/);
  });
  it('unavailable tier models fall back; a backend-rejected model retries on fast', async () => {
    const h = harness('Add CSV export with tests', [ok([testRun(1)]), ok([testRun(0)])], cfgOf({ tiers: { balanced: 'gpt-9-imaginary' } }));
    await h.exec.run();
    expect(h.calls.every((c) => CAT.some((m) => m.slug === c.sel.model))).toBe(true);
    expect(h.logs.some((l) => l.event === 'model_fallback')).toBe(true);
    const rej = harness('Review this authentication middleware', [{ status: 'failed', error: 'model gpt-6-sol is not supported for this account' }, ok()]);
    const res = await rej.exec.run();
    expect(used(rej.calls).map((x) => x.split('/')[0])).toEqual(['gpt-6-sol', 'gpt-6-luna']);
    expect(res.status).toBe('completed');
  });
  it('direct strategy: no escalation, no extra stages', async () => {
    const h = harness('Add CSV export with tests', [ok([testRun(1)])], cfgOf({ execution_strategy: 'direct' }));
    const res = await h.exec.run();
    expect(h.calls).toHaveLength(1);
    expect(res.status).toBe('failed'); // reported honestly
  });
});

describe('analyzeStage', () => {
  it('uses the last test run, collects files, detects "stuck" reports', () => {
    expect(analyzeStage([testRun(1), testRun(0)]).testsFailed).toBe(false);
    expect(analyzeStage([testRun(0), testRun(2)]).testsFailed).toBe(true);
    expect(analyzeStage([edit('a.ts', 'b.ts'), edit('a.ts')]).files).toEqual(['a.ts', 'b.ts']);
    // seen in a real benchmark run: rg exits 1 when it finds nothing, which is success for a rename
    expect(analyzeStage([{ type: 'commandExecution', command: '/bin/zsh -lc "node --test test/math.test.js && rg -n \\"\\\\bsum\\\\b\\" src test"', exitCode: 1 }]).testsFailed).toBe(false);
    expect(analyzeStage([{ type: 'commandExecution', command: "/bin/zsh -lc 'npm run build && npm test'", exitCode: 1 }]).testsFailed).toBe(true);
    expect(analyzeStage([{ type: 'commandExecution', command: "/bin/zsh -lc 'node --test 2>&1 | tail -20'", exitCode: 0 }]).testsFailed).toBe(false);
    expect(analyzeStage([{ type: 'agentMessage', text: 'I could not resolve the race condition.' }]).stuck).toBe(true);
  });
});
