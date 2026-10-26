import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { ModelInfo } from '../../src/smart-codex/models.js';
import { route } from '../../src/smart-codex/router.js';
import { Budget, formatLimits, limitsFrom } from '../../src/lumina/budget.js';
import { StagedExecution, planExecution } from '../../src/lumina/stages.js';
import { selfHeal } from '../../src/lumina/heal.js';
import type { Selection, TurnItem, TurnResult } from '../../src/lumina/tui/chat.js';
import type { Check, CheckResult, Verification } from '../../src/lumina/verify.js';

const CAT: ModelInfo[] = [{ slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh'] }, { slug: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh'] }];
const cfgOf = (o: Record<string, unknown> = {}) => ConfigSchema.parse({ analytics: { enabled: false }, ...o });
const usage = (i: number, c: number, o: number) => ({ totalTokens: i + o, inputTokens: i, cachedInputTokens: c, outputTokens: o });
const ok = (items: TurnItem[] = [], u?: ReturnType<typeof usage>): TurnResult => ({ status: 'completed', items: [...items, { type: 'agentMessage', text: 'done' }], usage: u });
const tests = (exit: number): TurnItem => ({ type: 'commandExecution', command: 'npm test', exitCode: exit });

async function run(task: string, results: TurnResult[], cfg = cfgOf(), clock?: () => number) {
  const rt = route({ task, repository: '/nonexistent' }, cfg, CAT);
  const plan = planExecution(task, rt, cfg, { model: rt.model, effort: rt.reasoning_effort });
  const budget = new Budget(limitsFrom(cfg), rt.risk === 'high', clock);
  const sent: Selection[] = [];
  const exec = new StagedExecution(task, plan, {
    cfg, catalog: CAT, budget,
    send: async (_p, sel) => { sent.push(sel); return results[Math.min(sent.length - 1, results.length - 1)]; },
    interrupt: async () => undefined, cancelled: () => false,
    hooks: { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: () => undefined }, log: () => undefined,
  }, { model: rt.model, effort: rt.reasoning_effort });
  return { res: await exec.run(), budget, sent };
}
const TASK = 'add a CRUD endpoint for products with validation';

describe('budget enforcement in the stage engine (boundaries only)', () => {
  it('single-stage task: one stage, provider tokens counted (input / cached / output separately)', async () => {
    const { res, budget } = await run(TASK, [ok([tests(0)], usage(1000, 800, 50))]);
    expect([res.status, res.stopped, budget.stages]).toEqual(['completed', undefined, 1]);
    expect(budget.usage).toEqual({ inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50 });
    expect(budget.format().join('\n')).toContain('Tokens (provider-reported): input 1,000 (cached 800) · output 50');
  });
  it('multi-stage task within budget: the fix stage runs', async () => {
    const { res, budget } = await run(TASK, [ok([tests(1)]), ok([tests(0)])]);
    expect([res.status, res.stages.length, budget.stages]).toEqual(['completed', 2, 2]);
  });
  it('token threshold reached: no additional stage; stops at the boundary, progress kept, unfinished reported (never "completed")', async () => {
    const { res, budget, sent } = await run(TASK, [ok([tests(1)], usage(5000, 1000, 100)), ok([tests(0)])], cfgOf({ budget: { max_input_tokens: 4000 } }));
    expect(sent).toHaveLength(1);
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/^stopped: budget exhausted \(input token threshold: 5,000 of 4,000 \(provider-reported\)\)/);
    expect(res.stopped).toEqual({ reason: 'input token threshold: 5,000 of 4,000 (provider-reported)', unfinished: ['fix the failing tests'] });
    expect(res.stages[0].status).toBe('done'); // the work that was done stays done
    expect(budget.format().join('\n')).toMatch(/Stopped: input token threshold[\s\S]*unfinished: fix the failing tests[\s\S]*\/continue/);
  });
  it('time budget: the next stage is not started when it would not fit', async () => {
    let t = 0;
    const clock = () => t;
    const results = [ok([tests(1)]), ok([tests(0)])];
    const rt = route({ task: TASK, repository: '/nonexistent' }, cfgOf(), CAT);
    const cfg = cfgOf({ budget: { max_duration_ms: 60_000 } });
    const plan = planExecution(TASK, rt, cfg, { model: rt.model, effort: rt.reasoning_effort });
    const budget = new Budget(limitsFrom(cfg), false, clock);
    const exec = new StagedExecution(TASK, plan, { cfg, catalog: CAT, budget, send: async () => { t += 40_000; return results.shift()!; }, interrupt: async () => undefined, cancelled: () => false, hooks: { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: () => undefined }, log: () => undefined }, { model: rt.model, effort: rt.reasoning_effort });
    const res = await exec.run();
    expect(res.stopped?.reason).toMatch(/^time budget: 40s used of 60s, and another stage takes about \d+s$/);
  });
  it('missing token data: thresholds cannot be enforced and are not estimated; work continues', async () => {
    const { res, budget } = await run(TASK, [ok([tests(1)]), ok([tests(0)])], cfgOf({ budget: { max_input_tokens: 10 } }));
    expect([res.status, res.stopped]).toEqual(['completed', undefined]);
    expect(budget.format().join('\n')).toContain('Tokens: not reported by Codex — token thresholds cannot be enforced for this request');
  });
  it('escalation limit (existing stages.max_escalations) still bounds fix stages', async () => {
    const { res } = await run(TASK, [ok([tests(1)])], cfgOf({ stages: { max_escalations: 0 } }));
    expect([res.status, res.stages.length]).toEqual(['failed', 1]);
  });
  it('low-benefit work is declined late in the budget, except for critical (security-sensitive) work', () => {
    let t = 0;
    const lim = limitsFrom(cfgOf({ budget: { max_duration_ms: 100_000 } }));
    const b = new Budget(lim, false, () => t);
    t = 80_000;
    expect(b.allow('stage', 'low')).toEqual({ ok: false, reason: 'low expected benefit with 80% of the budget used' });
    expect(b.allow('stage', 'high')).toEqual({ ok: true });
    expect(new Budget(lim, true, () => t).allow('stage', 'low')).toEqual({ ok: true });
  });
});

describe('self-healing respects the budget', () => {
  const check: Check = { kind: 'related', label: 'related tests', argv: [], command: 'npm test -- a.test.ts', forms: [] };
  const failed: CheckResult = { check, status: 'failed', source: 'ran', ms: 1, exitCode: 1, failure: 'test failure', output: 'not ok 1' };
  const v: Verification = { level: 'quick', reason: '', stack: '', skipped: [], results: [failed], impact: { changes: [{ path: 'src/a.ts', kind: 'modified' }], modules: [], tests: [], packages: [], importers: 0, importerFiles: [], reasons: [], flags: { critical: false, migration: false, shared: false, deps: false, config: false, docsOnly: false, testsOnly: false } } };
  it('repair limit and budget exhaustion stop safely with the reason; repairs and their tokens are counted', async () => {
    const cfg = cfgOf({ budget: { max_output_tokens: 100 } });
    const budget = new Budget(limitsFrom(cfg));
    const turns: string[] = [];
    const res = await selfHeal(v, {
      cfg, catalog: CAT, root: '/r', request: 'x', changes: v.impact.changes, budget,
      stage: { send: async (p) => { turns.push(p); return { status: 'completed', items: [], usage: usage(2000, 0, 150) }; }, interrupt: async () => undefined, cancelled: () => false },
      hooks: { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: () => undefined },
      verify: async () => v, ui: { attempt: () => undefined, repairEnd: () => undefined, notice: () => undefined },
    });
    expect(turns).toHaveLength(1); // the first repair used up the output threshold
    expect([res.status, res.reason]).toEqual(['stopped', 'budget exhausted (output token threshold: 150 of 100 (provider-reported))']);
    expect([budget.repairs, budget.usage.outputTokens, budget.stopped?.unfinished]).toEqual([1, 150, ['repair: related tests']]);
  });
});

describe('limits view', () => {
  it('shows the existing limits and the optional ones; safety statement; no billing claims', () => {
    const t = formatLimits(limitsFrom(cfgOf())).join('\n');
    expect(t).toContain('Stages: 3 planned, + up to 2 escalation stages · retries per stage: 2 · model switches: 4');
    expect(t).toContain('Self-healing: 2 repair attempts · 2 escalations');
    expect(t).toContain('Duration: no limit · Input tokens: no threshold · Output tokens: no threshold');
    expect(t).toContain('Verification and safety checks are never skipped to stay within budget. Tokens are provider-reported counts, not billing.');
  });
});
