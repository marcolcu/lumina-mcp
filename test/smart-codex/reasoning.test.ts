import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { ModelInfo } from '../../src/smart-codex/models.js';
import { route } from '../../src/smart-codex/router.js';
import { StagedExecution, planExecution, raiseEffort } from '../../src/lumina/stages.js';
import type { Selection, TurnItem, TurnResult } from '../../src/lumina/tui/chat.js';
import { Diagnostic, formatWhy } from '../../src/lumina/diagnostics.js';

const cfg = ConfigSchema.parse({ analytics: { enabled: false } });
const CAT: ModelInfo[] = [
  { slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh'] },
  { slug: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
];
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-reason-'));
const r = (task: string, preferences = {}, catalog = CAT) => route({ task, repository: empty, preferences }, cfg, catalog);
const pick = (task: string) => { const x = r(task); return `${x.model}/${x.reasoning_effort}`; };

describe('adaptive reasoning effort (no model call)', () => {
  it('simple UI change: low', () => {
    expect(pick('change the button colour to blue')).toBe('gpt-6-luna/low');
    expect(r('change the button colour to blue').reasoning_reason).toBe('trivial edit');
  });
  it('backend implementation: medium', () => {
    expect(pick('add a CRUD endpoint for products with validation')).toMatch(/\/medium$/);
    expect(r('add a CRUD endpoint for products with validation').reasoning_reason).toBe('standard implementation');
  });
  it('complex debugging: high; a focused bug stays medium', () => {
    const d = r('debug the intermittent race condition that corrupts orders across multiple services');
    expect(d.reasoning_effort).toBe('high');
    expect(d.reasoning_reason).toBe('complex debugging (root cause across several factors)');
    expect(r('investigate why the date picker shows the wrong month').reasoning_effort).toBe('medium');
  });
  it('security: documentation low, review medium (high when wide), implementation high — security words alone never force high', () => {
    const doc = r('update the README section about authentication');
    expect([doc.reasoning_effort, doc.reasoning_reason]).toEqual(['low', 'security documentation/cosmetic change: no logic is touched']);
    const review = r('Review authentication security');
    expect([review.model, review.reasoning_effort, review.reasoning_reason]).toEqual(['gpt-6-sol', 'medium', 'security review (analysis, no implementation)']); // strong model, moderate reasoning
    expect(r('audit security across the whole codebase').reasoning_effort).toBe('high');
    const impl = r('implement JWT refresh token rotation in the auth middleware');
    expect([impl.model, impl.reasoning_effort, impl.reasoning_reason]).toEqual(['gpt-6-sol', 'high', 'security-sensitive implementation']);
  });
  it('reasoning is chosen independently of the model tier', () => {
    const review = r('Review authentication security');
    const impl = r('implement JWT refresh token rotation in the auth middleware');
    expect(review.tier).toBe(impl.tier);
    expect(review.reasoning_effort).not.toBe(impl.reasoning_effort);
  });
  it('user overrides are preserved and recorded as such', () => {
    const x = r('change the button colour', { reasoning: 'high' });
    expect([x.reasoning_effort, x.reasoning_reason]).toEqual(['high', 'explicitly requested (high)']);
    expect(() => r('change the button colour', { reasoning: 'ultra', model: 'gpt-6-luna' })).toThrow(/does not support reasoning "ultra"/);
  });
  it('unsupported levels fall back to the nearest level the Codex catalog offers, and say so', () => {
    const limited: ModelInfo[] = [{ slug: 'gpt-6-luna', efforts: ['medium', 'high'] }, { slug: 'gpt-6-sol', efforts: ['medium', 'high'] }];
    const x = r('change the button colour to blue', {}, limited);
    expect(x.reasoning_effort).toBe('medium');
    expect(x.reasoning_reason).toBe('trivial edit; "low" is not available for gpt-6-luna, using medium');
  });
  it('raiseEffort: one step, at least medium, capped', () => {
    expect([raiseEffort('low'), raiseEffort('medium'), raiseEffort('high'), raiseEffort('high', 'xhigh'), raiseEffort('xhigh', 'xhigh')]).toEqual(['medium', 'high', 'high', 'xhigh', 'xhigh']);
  });
});

describe('multi-stage execution: reasoning changes only between stages, escalates one step when failures justify it', () => {
  const run = async (task: string, results: TurnResult[]) => {
    const calls: Selection[] = [];
    const rt = r(task);
    const plan = planExecution(task, rt, cfg, { model: rt.model, effort: rt.reasoning_effort });
    const exec = new StagedExecution(task, plan, {
      cfg, catalog: CAT,
      send: async (_p, sel) => { calls.push(sel); return results[Math.min(calls.length - 1, results.length - 1)]; },
      interrupt: async () => undefined, cancelled: () => false,
      hooks: { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: () => undefined }, log: () => undefined,
    }, { model: rt.model, effort: rt.reasoning_effort });
    const res = await exec.run();
    return { calls: calls.map((c) => `${c.model}/${c.effort}`), res };
  };
  const ok = (items: TurnItem[] = []): TurnResult => ({ status: 'completed', items: [...items, { type: 'agentMessage', text: 'done' }] });
  const tests = (exit: number): TurnItem => ({ type: 'commandExecution', command: 'npm test', exitCode: exit });
  it('a successful simple task stays on its first selection (no escalation)', async () => {
    expect((await run('add a CRUD endpoint for products with validation', [ok([tests(0)])])).calls).toEqual(['gpt-6-luna/medium']);
  });
  it('failing tests: the fix stage reasons one step above what failed (medium → high), the next one beyond high only if needed', async () => {
    const x = await run('add a CRUD endpoint for products with validation', [ok([tests(1)]), ok([tests(1)]), ok([tests(0)])]);
    expect(x.calls).toEqual(['gpt-6-luna/medium', 'gpt-6-sol/high', 'gpt-6-sol/xhigh']);
    expect(x.res.stages.map((s) => s.effort)).toEqual(['medium', 'high', 'xhigh']); // recorded as actually sent
  });
  it('a low-reasoning task that fails is fixed at medium, not jumped to high', async () => {
    expect((await run('change the button colour to blue', [ok([tests(1)]), ok([tests(0)])])).calls).toEqual(['gpt-6-luna/low', 'gpt-6-sol/medium']);
  });
});

describe('/why explains the recorded reasoning decision', () => {
  it('shows the effort, why, and that reasoning only changes between stages', () => {
    const rt = r('Review authentication security');
    const d = new Diagnostic('critical task (high risk)');
    d.routed(rt, { model: rt.model, effort: rt.reasoning_effort }, 'automatic routing', 'direct');
    d.stage({ type: 'task', title: 'Execute request', model: rt.model, effort: 'medium', status: 'done' });
    d.stage({ type: 'fix', title: 'Fix failing checks', model: 'gpt-6-sol', effort: 'high', status: 'done' });
    const t = formatWhy(d.rec);
    expect(t).toContain('Reasoning: Medium — security review (analysis, no implementation)');
    expect(t).toContain('  2. Fix failing checks · gpt-6-sol · high reasoning · done');
    expect(t).toContain('Reasoning is set per Codex turn and can only change between stages, never during a running turn.');
  });
});
