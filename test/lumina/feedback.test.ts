import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { ModelInfo } from '../../src/smart-codex/models.js';
import { route } from '../../src/smart-codex/router.js';
import { Diagnostic, formatWhy } from '../../src/lumina/diagnostics.js';
import { OutcomeRecord, RoutingFeedback, categoryOf, outcomeOf, recordFrom } from '../../src/lumina/feedback.js';
import { TurnRouter } from '../../src/lumina/tui/routing.js';
import type { Verification } from '../../src/lumina/verify.js';

const CAT: ModelInfo[] = [{ slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh'] }, { slug: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh'] }];
const cfg = (fb: Record<string, unknown> = {}) => ConfigSchema.parse({ analytics: { enabled: false }, feedback: fb, models: { fast: 'gpt-6-luna', normal: 'gpt-6-luna', hard: 'gpt-6-sol', critical: 'gpt-6-sol' } });
const TASK = 'add a CRUD endpoint for products with validation';
let home: string;
beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-fb-')); process.env.SMART_CODEX_HOME = home; });

const rt = (task = TASK) => route({ task, repository: '/nonexistent' }, cfg(), CAT);
const rec = (o: Partial<OutcomeRecord> = {}, task = TASK): OutcomeRecord => {
  const r = rt(task);
  return { at: Date.now(), category: categoryOf(r), tier: r.tier, complexity: r.complexity_score, risk: r.risk, model: r.model, effort: r.reasoning_effort, source: 'automatic routing', outcome: 'verified-success', repairs: 0, escalations: 0, switches: 0, ...o };
};
const seed = (fb: RoutingFeedback, xs: OutcomeRecord[]) => { for (const x of xs) fb.record(x); };
const times = <T>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

describe('recording outcomes', () => {
  const verification = (failed: boolean, declined = false): Verification => ({
    level: 'standard', reason: '', stack: '', skipped: [], declined, impact: { changes: [], modules: [], tests: [], packages: [], importers: 0, importerFiles: [], reasons: [], flags: { critical: false, migration: false, shared: false, deps: false, config: false, docsOnly: false, testsOnly: false } },
    results: [{ check: { kind: 'related', label: 't', argv: [], command: 'npm test', forms: [] }, status: failed ? 'failed' : 'passed', source: 'ran', ms: 1, failure: failed ? 'test failure' : undefined }],
  });
  const diag = (f: (d: Diagnostic) => void, status: 'completed' | 'failed' | 'cancelled' = 'completed', error?: string) => {
    const r = rt();
    const d = new Diagnostic('normal task');
    d.routed(r, { model: r.model, effort: r.reasoning_effort }, 'automatic routing', 'direct');
    f(d);
    return d.finish(status, { error, usage: { totalTokens: 1300, inputTokens: 1000, cachedInputTokens: 800, outputTokens: 300 } });
  };
  it('verified success vs model-reported success vs failures; repairs and escalations kept; no prompt text', () => {
    const ok = diag((d) => d.verified(verification(false)));
    expect(outcomeOf(ok)).toBe('verified-success');
    expect(outcomeOf(diag(() => undefined))).toBe('unverified'); // completed, but nothing checked it
    expect(outcomeOf(diag((d) => d.verified(verification(false, true))))).toBe('unverified'); // checks declined
    expect(outcomeOf(diag((d) => d.verified(verification(true))))).toBe('verified-failure');
    expect(outcomeOf(diag(() => undefined, 'failed', 'boom'))).toBe('failure');
    expect(outcomeOf(diag(() => undefined, 'cancelled'))).toBe('cancelled');
    const repaired = diag((d) => { d.verified(verification(true)); d.healed({ status: 'repaired', attempts: 1, escalations: 1, models: ['gpt-6-luna'], efforts: ['high'], reason: '', classes: [] }); d.verified(verification(false)); });
    const o = recordFrom(repaired, repaired.routing!.category!)!;
    expect(o).toMatchObject({ outcome: 'verified-success', repairs: 1, escalations: 1, model: 'gpt-6-luna', effort: 'medium', input: 1000, cached: 800, output: 300, category: 'normal · standard implementation' });
    const fb = new RoutingFeedback(cfg().feedback);
    fb.record(o); fb.record(recordFrom(diag(() => undefined, 'cancelled'), 'x'));
    const raw = fs.readFileSync(fb.file, 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1); // cancelled requests are not evidence
    expect(raw).not.toMatch(/CRUD|products|validation/);
  });
  it('history is bounded; corrupted lines are skipped; reset deletes it', () => {
    const fb = new RoutingFeedback(cfg({ max_records: 50 }).feedback);
    seed(fb, times(120, () => rec()));
    expect(fb.load().length).toBeLessThanOrEqual(75);
    fs.appendFileSync(fb.file, 'garbage\n{"half": true}\n');
    expect(fb.load().length).toBeGreaterThan(0);
    expect(fb.recovered).toBe(2);
    expect(fb.format()).toContain('2 unreadable lines skipped');
    expect(fb.reset()).toBeGreaterThan(0);
    expect(fb.load()).toEqual([]);
  });
});

describe('conservative influence', () => {
  it('sparse evidence never changes the route; deterministic routing stands', () => {
    const fb = new RoutingFeedback(cfg().feedback);
    seed(fb, times(5, () => rec({ outcome: 'verified-failure' })));
    expect(fb.advise(rt(), cfg().models, CAT)).toBeUndefined();
  });
  it('repeated repairs/failures raise reasoning one step, with traceable evidence; unverified runs are not evidence', () => {
    const fb = new RoutingFeedback(cfg().feedback);
    seed(fb, times(20, () => rec({ outcome: 'unverified' }))); // model-reported successes: ignored
    seed(fb, [...times(5, () => rec({ repairs: 1 })), ...times(3, () => rec({ outcome: 'verified-failure' })), ...times(2, () => rec())]);
    const a = fb.advise(rt(), cfg().models, CAT)!;
    expect([a.model, a.effort, a.change]).toEqual(['gpt-6-luna', 'high', 'reasoning medium → high']);
    expect(a.evidence).toMatch(/^8 of 10 verified\/failed runs needed repairs, escalation or failed \(category "normal · standard implementation", gpt-6-luna\/medium, since \d{4}-\d{2}-\d{2}\)$/);
  });
  it('runs that only succeeded after escalating to a stronger model start there next time (if available)', () => {
    const fb = new RoutingFeedback(cfg().feedback);
    seed(fb, times(8, () => rec({ escalations: 1 })));
    expect(fb.advise(rt(), cfg().models, CAT)).toMatchObject({ model: 'gpt-6-sol', effort: 'medium', change: 'model gpt-6-luna → gpt-6-sol' });
    const noSol: ModelInfo[] = [{ slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }];
    expect(fb.advise(rt(), cfg().models, noSol)).toMatchObject({ model: 'gpt-6-luna', effort: 'high' }); // model unavailable: reasoning instead
  });
  it('conflicting (mixed) results leave the route unchanged', () => {
    const fb = new RoutingFeedback(cfg().feedback);
    seed(fb, [...times(6, () => rec()), ...times(3, () => rec({ repairs: 1 }))]);
    expect(fb.advise(rt(), cfg().models, CAT)).toBeUndefined();
  });
  it('lower reasoning only with verified evidence at the lower level, and never for security-sensitive work', () => {
    const fb = new RoutingFeedback(cfg().feedback);
    seed(fb, [...times(10, () => rec()), ...times(5, () => rec({ effort: 'low' }))]);
    expect(fb.advise(rt(), cfg().models, CAT)).toMatchObject({ effort: 'low', change: 'reasoning medium → low' });
    const sec = 'implement JWT refresh token rotation in the auth middleware';
    seed(fb, [...times(10, () => rec({}, sec)), ...times(10, () => rec({ effort: 'medium' }, sec))]);
    expect(fb.advise(rt(sec), cfg().models, CAT)).toBeUndefined(); // successes never lower safety
    const only = new RoutingFeedback({ ...cfg().feedback }, path.join(home, 'other.jsonl'));
    seed(only, times(12, () => rec()));
    expect(only.advise(rt(), cfg().models, CAT)).toBeUndefined(); // no evidence at the lower level: no experiment
  });
  it('disabled influence (config or /feedback off) and user overrides keep the deterministic route; corrupted history falls back', () => {
    const fb = new RoutingFeedback(cfg({ influence: false }).feedback);
    seed(fb, times(10, () => rec({ repairs: 1 })));
    expect(fb.advise(rt(), cfg().models, CAT)).toBeUndefined();
    const on = new RoutingFeedback(cfg().feedback);
    on.influence = false;
    expect(on.advise(rt(), cfg().models, CAT)).toBeUndefined();
    const router = new TurnRouter(cfg(), '/nonexistent', CAT);
    router.feedback = new RoutingFeedback(cfg().feedback);
    expect(router.pick(TASK).sel).toEqual({ model: 'gpt-6-luna', effort: 'high' }); // history applied
    expect(router.pick(TASK).route.feedback?.change).toBe('reasoning medium → high');
    router.setReasoning('low');
    expect(router.pick(TASK).sel).toEqual({ model: 'gpt-6-luna', effort: 'low' }); // override wins
    router.setReasoning('auto');
    fs.writeFileSync(router.feedback.file, '{not json\n');
    expect(router.pick(TASK).sel).toEqual({ model: 'gpt-6-luna', effort: 'medium' }); // corrupted history: deterministic
  });
});

describe('/why', () => {
  it('records whether history influenced the route, with its evidence', () => {
    const router = new TurnRouter(cfg(), '/nonexistent', CAT);
    router.feedback = new RoutingFeedback(cfg().feedback);
    seed(router.feedback, times(8, () => rec({ repairs: 1 })));
    const p = router.pick(TASK);
    const d = new Diagnostic('normal task');
    d.routed(p.route, p.sel, 'automatic routing', 'direct');
    expect(formatWhy(d.rec)).toMatch(/History: reasoning medium → high — 8 of 8 verified\/failed runs needed repairs/);
    expect(formatWhy(d.rec)).toContain('- history: reasoning medium → high');
    router.feedback.reset();
    const q = router.pick(TASK);
    const e = new Diagnostic('normal task');
    e.routed(q.route, q.sel, 'automatic routing', 'direct');
    expect(formatWhy(e.rec)).toContain('History: not used (category "normal · standard implementation") — the deterministic route stands');
  });
});
