import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { ModelInfo } from '../../src/smart-codex/models.js';
import { RealDeps, SCENARIOS, StoredRun, aggregate, formatRun, loadRuns, regressions, resultsFile, runMock, runReal, saveRun } from '../../src/lumina/benchmark.js';

const CAT: ModelInfo[] = [{ slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh'] }, { slug: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh'] }];
const cfg = (o: Record<string, unknown> = {}) => ConfigSchema.parse({ analytics: { enabled: false }, models: { fast: 'gpt-6-luna', normal: 'gpt-6-luna', hard: 'gpt-6-sol', critical: 'gpt-6-sol' }, stages: { tiers: { fast: 'gpt-6-luna', balanced: 'gpt-6-sol', advanced: 'gpt-6-sol' } }, ...o });
beforeEach(() => { process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-bench-home-')); });

describe('mock suite (no model calls)', () => {
  it('covers the required scenarios and passes its policy expectations', async () => {
    expect(SCENARIOS.map((s) => s.id)).toEqual(['rename', 'endpoint', 'pasted-docs', 'security-review', 'auth-impl', 'migration', 'refactor', 'debug', 'ticket-understand', 'ticket-implement', 'long-conversation', 'escalation', 'compaction']);
    const r = await runMock(cfg(), CAT);
    const failed = r.flatMap((x) => x.checks.filter((c) => !c.ok).map((c) => `${x.id}: ${c.name}`));
    expect(failed).toEqual([]);
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect([by.rename.route.model, by.rename.route.effort]).toEqual(['gpt-6-luna', 'low']); // simple: efficient model
    expect([by['auth-impl'].route.risk, by['auth-impl'].route.effort]).toEqual(['high', 'high']); // risky stays risky
    expect([by['security-review'].route.model, by['security-review'].route.effort]).toEqual(['gpt-6-sol', 'medium']);
    expect([by.debug.stages, by.debug.switches]).toEqual([2, 1]);
    expect(by['ticket-understand'].readOnly).toBe(true);
    expect(by.compaction.compaction).toBe(true);
  });
  it('is deterministic: two runs give identical results', async () => {
    expect(JSON.stringify(await runMock(cfg(), CAT))).toBe(JSON.stringify(await runMock(cfg(), CAT)));
  });
  it('detects routing regressions: a changed reasoning default fails its expectation and is reported against the previous run', async () => {
    const before: StoredRun = { at: 1, mode: 'mock', results: await runMock(cfg(), CAT) };
    const after: StoredRun = { at: 2, mode: 'mock', results: await runMock(cfg({ reasoning: { fast: 'high' }, models: { fast: 'gpt-6-sol', normal: 'gpt-6-luna', hard: 'gpt-6-sol', critical: 'gpt-6-sol' } }), CAT) };
    const reg = regressions(before, after);
    expect(reg).toContain('rename: model changed gpt-6-luna → gpt-6-sol');
    expect(reg).toContain('rename: reasoning changed low → high');
    const rename = after.results.find((x) => x.id === 'rename')!;
    expect(rename.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['reasoning']);
    expect(formatRun(after, before)).toMatch(/✗ Simple rename \[rename\][\s\S]*expected reasoning low\|medium, got high[\s\S]*Changes since the previous mock run/);
  });
});

describe('real suite (explicit opt-in only)', () => {
  const fakeDeps = (record: string[], usage = true): RealDeps => ({
    session: async (dir) => {
      record.push(dir);
      return {
        send: async () => {
          // the "model" fixes the code in the temporary repository it was given
          fs.writeFileSync(path.join(dir, 'src/math.js'), 'export function add(a, b) {\n  return a + b;\n}\nexport const sum = add;\n');
          return { status: 'completed', items: [{ type: 'agentMessage', text: 'done' }], usage: usage ? { totalTokens: 1100, inputTokens: 1000, cachedInputTokens: 600, outputTokens: 100 } : undefined };
        },
        context: () => undefined, compact: async () => true, close: async () => undefined,
      };
    },
  });
  it('refuses without explicit confirmation; validates samples and scenario ids', async () => {
    await expect(runReal(cfg(), CAT, fakeDeps([]), { confirmed: false, samples: 1 })).rejects.toThrow(/explicit confirmation/);
    await expect(runReal(cfg(), CAT, fakeDeps([]), { confirmed: true, samples: 0 })).rejects.toThrow(/samples must be/);
    await expect(runReal(cfg(), CAT, fakeDeps([]), { confirmed: true, samples: 1, ids: ['security-review'] })).rejects.toThrow(/no runnable scenario among security-review; runnable: rename, refactor, debug/);
  });
  it('runs in isolated temporary repositories (removed afterwards; this repository untouched) and aggregates provider-reported tokens', async () => {
    const dirs: string[] = [];
    const statusBefore = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' });
    const r = await runReal(cfg(), CAT, fakeDeps(dirs), { confirmed: true, samples: 3, ids: ['rename'] });
    expect(dirs).toHaveLength(3);
    for (const d of dirs) { expect(d.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true); expect(fs.existsSync(d)).toBe(false); }
    expect(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })).toBe(statusBefore);
    const a = aggregate(r[0].samples!);
    expect(a).toMatchObject({ samples: 3, reported: 3, input: 1000, cached: 600, output: 100, verified: 3, stages: 1 });
    expect(r[0].mode).toBe('real');
    expect(formatRun({ at: 1, mode: 'real', results: r }, undefined)).toMatch(/REAL \(Codex executions; observed, provider-reported\)[\s\S]*3 samples · verified 3\/3 · median \d+s · stages 1 · switches 0 · median tokens in 1,000 \/ cached 600 \/ out 100 \(3\/3 reported\)/);
  });
  it('missing token usage is reported as such, never estimated', async () => {
    const r = await runReal(cfg(), CAT, fakeDeps([], false), { confirmed: true, samples: 1, ids: ['rename'] });
    expect(aggregate(r[0].samples!)).toMatchObject({ reported: 0, input: undefined });
    expect(formatRun({ at: 1, mode: 'real', results: r }, undefined)).toContain('tokens not reported');
  });
  it('real regressions need 3+ samples per side and clear differences', () => {
    const s = (input: number, verified: boolean) => ({ usage: { totalTokens: input, inputTokens: input, cachedInputTokens: 0, outputTokens: 10 }, ms: 1000, status: 'completed', verified, stages: 1, switches: 0 });
    const base = { id: 'rename', name: 'r', mode: 'real' as const, route: { tier: 'fast', model: 'm', effort: 'low', complexity: 1, risk: 'low', referenceChars: 0 }, strategy: 'adaptive', plannedStages: 1, stages: 1, switches: 0, escalations: 0, models: [], readOnly: false, sticky: false, checks: [] };
    const prev: StoredRun = { at: 1, mode: 'real', results: [{ ...base, samples: [s(1000, true), s(1000, true), s(1000, true)] }] };
    const cur: StoredRun = { at: 2, mode: 'real', results: [{ ...base, samples: [s(1600, false), s(1500, false), s(1700, true)] }] };
    expect(regressions(prev, cur)).toEqual(['rename: median input tokens 1,000 → 1,600 (provider-reported)', 'rename: verified results 3/3 → 1/3']);
    const few: StoredRun = { at: 3, mode: 'real', results: [{ ...base, samples: [s(5000, false)] }] };
    expect(regressions(prev, few)).toEqual([]); // one sample is not evidence
  });
});

describe('result storage', () => {
  it('bounded local history; corrupted lines skipped', async () => {
    const r = await runMock(cfg(), CAT, ['rename']);
    for (let i = 0; i < 40; i++) saveRun({ at: i, mode: 'mock', results: r });
    expect(loadRuns()).toHaveLength(30);
    fs.appendFileSync(resultsFile(), 'not json\n');
    expect(loadRuns()).toHaveLength(30);
    expect(resultsFile().startsWith(process.env.SMART_CODEX_HOME!)).toBe(true);
  });
});
