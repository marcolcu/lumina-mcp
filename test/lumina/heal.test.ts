import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { HealDeps, errorLocations, healClass, selfHeal, signature } from '../../src/lumina/heal.js';
import { analyzeStage } from '../../src/lumina/stages.js';
import type { Check, CheckResult, FailureClass, Impact, Verification } from '../../src/lumina/verify.js';

const ROOT = '/repo';
const CAT = [{ slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }, { slug: 'gpt-6-sol', efforts: ['low', 'medium', 'high'] }, { slug: 'gpt-6-astra', efforts: ['low', 'medium', 'high'] }];
const cfg = (o: Record<string, unknown> = {}) => ConfigSchema.parse({ stages: { tiers: { fast: 'gpt-6-luna', balanced: 'gpt-6-sol', advanced: 'gpt-6-astra' } }, analytics: { enabled: false }, self_healing: o });
const impact = (o: Partial<Impact['flags']> = {}): Impact => ({
  changes: [{ path: 'src/math.ts', kind: 'modified' }], modules: ['src'], tests: ['test/math.test.ts'], packages: [], importers: 1, importerFiles: ['src/app.ts'], reasons: [],
  flags: { critical: false, migration: false, shared: false, deps: false, config: false, docsOnly: false, testsOnly: false, ...o },
});
const check = (kind: Check['kind'] = 'typecheck', command = 'npm run typecheck'): Check => ({ kind, label: kind, argv: command.split(' '), command, forms: [] });
const fail = (output: string, failure: FailureClass = 'compilation error', c = check()): CheckResult => ({ check: c, status: 'failed', source: 'ran', ms: 1, exitCode: 1, failure, output, tail: output });
const pass = (c = check()): CheckResult => ({ check: c, status: 'passed', source: 'ran', ms: 1, exitCode: 0 });
const ver = (results: CheckResult[], im = impact()): Verification => ({ level: 'standard', reason: '', stack: 'TypeScript', impact: im, results, skipped: [] });
const TS = (n = 1) => `src/math.ts(3,${n}): error TS2322: Type 'string' is not assignable to type 'number'.`;

describe('failure classification', () => {
  it.each([
    ['TypeScript error in a changed file', fail(TS()), 'CODE_FAILURE'],
    ['compile error in an importer of a changed file', fail("src/app.ts(9,1): error TS2345: Argument of type 'string'"), 'CODE_FAILURE'],
    ['lint error in a changed file', fail(`${ROOT}/src/math.ts\n  3:1  error  no-unused-vars`, 'lint error', check('lint', 'npm run lint')), 'CODE_FAILURE'],
    ['build failure in a changed file', fail('src/math.ts:3:1: ERROR: Expected ";"', 'compilation error', check('build', 'npm run build')), 'CODE_FAILURE'],
    ['related tests failing (no location)', fail('not ok 1 - add\n# fail 1', 'test failure', check('related', 'npm test -- test/math.test.ts')), 'CODE_FAILURE'],
    ['errors only in untouched files', fail("src/legacy/old.ts(1,1): error TS2304: Cannot find name 'x'."), 'PRE_EXISTING_FAILURE'],
    ['unrelated failing tests', fail('FAIL test/csv.test.ts', 'unrelated test failure (possibly pre-existing)', check('tests', 'npm test')), 'PRE_EXISTING_FAILURE'],
    ['missing dependency', fail("Error: Cannot find module 'vitest'", 'missing dependency', check('tests', 'npm test')), 'ENVIRONMENT_FAILURE'],
    ['database not running', fail('connect ECONNREFUSED 127.0.0.1:5432', 'external service unavailable', check('tests', 'npm test')), 'ENVIRONMENT_FAILURE'],
    ['network blip', fail('Error: socket hang up\nECONNRESET', 'test failure', check('tests', 'npm test')), 'TRANSIENT_FAILURE'],
    ['timeout', fail('timed out after 600s', 'environment problem', check('tests', 'npm test')), 'UNKNOWN_FAILURE'],
    ['full suite failing without locations', fail('1 test failed', 'test failure', check('tests', 'npm test')), 'UNKNOWN_FAILURE'],
  ] as const)('%s → %s', (_n, r, cls) => {
    expect(healClass(r, impact(), ROOT).cls).toBe(cls);
  });
  it('locations: repository-relative, absolute inside root, file:// URLs; outside paths and node_modules ignored', () => {
    expect(errorLocations(`file://${ROOT}/test/a.test.ts:3:1\n/usr/lib/node/x.js:1\nnode_modules/v/x.js:1\n./src/b.go:3: undefined: x`, ROOT)).toEqual(['test/a.test.ts', 'src/b.go']);
  });
  it('false-positive command failures never reach self-healing: rg exit 1 in a chain is not a test failure', () => {
    expect(analyzeStage([{ type: 'commandExecution', command: "/bin/zsh -lc 'npm test && rg -n TODO'", exitCode: 1 }]).testsFailed).toBe(false);
    expect(analyzeStage([{ type: 'commandExecution', command: 'rg foo', exitCode: 1 }]).testsFailed).toBe(false);
  });
  it('signature ignores positions and timings, changes with the error', () => {
    expect(signature([fail(`${TS(1)}\nfail in 3.2s`)])).toBe(signature([fail(`${TS(7)}\nfail in 9s`)]));
    expect(signature([fail(TS())])).not.toBe(signature([fail("src/math.ts(3,1): error TS2339: Property 'x' does not exist")]));
  });
});

/** Fake deps: scripted verification results; records repair turns (model, prompt). */
const harness = (results: Verification[], o: { cancelAfter?: number; cfg?: ReturnType<typeof cfg>; startModel?: string; checkpoint?: boolean } = {}) => {
  const turns: { model?: string; effort?: string; prompt: string }[] = [];
  const log: string[] = [];
  const checkpoints: string[] = [];
  let i = 0;
  let cancelled = false;
  const d: HealDeps = {
    cfg: o.cfg ?? cfg(), catalog: CAT, root: ROOT, request: 'make add faster', changes: [{ path: 'src/math.ts', kind: 'modified' }], startModel: o.startModel ?? 'gpt-6-luna',
    stage: {
      send: async (prompt, sel) => { turns.push({ model: sel.model, effort: sel.effort, prompt }); if (o.cancelAfter && turns.length >= o.cancelAfter) cancelled = true; return { status: cancelled ? 'interrupted' : 'completed', items: [{ type: 'fileChange', files: ['src/math.ts'] }] }; },
      interrupt: async () => undefined, cancelled: () => cancelled,
    },
    hooks: { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: (t) => log.push(t) },
    verify: async () => results[i++] ?? results.at(-1),
    ...(o.checkpoint === false ? {} : { checkpoint: { begin: async (t) => { checkpoints.push(`begin:${t}`); }, finish: async (c) => { checkpoints.push(`finish:${c}`); return [{ path: 'src/math.ts', kind: 'modified' as const }]; } } }),
    ui: { attempt: (n, max, sel, reason) => log.push(`attempt ${n}/${max} ${sel.model} ${reason}`), repairEnd: (ok) => log.push(`end ${ok}`), notice: (t) => log.push(t) },
  };
  return { d, turns, log, checkpoints };
};

describe('self-healing loop', () => {
  it('successful repair: one focused fix turn on the same model, then verification passes', async () => {
    const h = harness([ver([pass()])]);
    const r = await selfHeal(ver([fail(TS())]), h.d);
    expect([r.status, r.attempts, r.escalations, r.models]).toEqual(['repaired', 1, 0, ['gpt-6-luna']]);
    expect(h.turns[0].prompt).toMatch(/^\[Lumina stage 1: Fix failing checks\]/);
    expect(h.turns[0].prompt).toContain('error TS2322');
    expect(h.turns[0].prompt).toContain('do not restart the original task');
    expect(h.turns[0].prompt).not.toContain('Strategy'); // no conversation history, only the compact hand-off
    expect(h.checkpoints).toEqual(['begin:self-heal attempt 1: make add faster', 'finish:false']);
  });
  it('failed repair: attempts are bounded (max_repair_attempts) and progress keeps the model', async () => {
    const h = harness([ver([fail(TS(2).replace('TS2322', 'TS2339'))]), ver([fail("src/math.ts(5,1): error TS2554: Expected 2 arguments")])]);
    const r = await selfHeal(ver([fail(TS())]), h.d);
    expect([r.status, r.attempts, r.models]).toEqual(['exhausted', 2, ['gpt-6-luna', 'gpt-6-luna']]);
    expect(h.log).toContain('attempt 2/2 gpt-6-luna previous fix made progress; same model and reasoning');
  });
  it('no progress raises reasoning on the same model first, then the model (Luna medium → Luna high → Sol); Astra only when complex', async () => {
    const same = ver([fail(TS())]);
    let h = harness([same, same, same, same], { cfg: cfg({ max_repair_attempts: 4 }) });
    let r = await selfHeal(same, h.d);
    expect(h.turns.map((t) => `${t.model}/${t.effort}`)).toEqual(['gpt-6-luna/medium', 'gpt-6-luna/high', 'gpt-6-sol/high']);
    expect(h.log).toContain('attempt 2/4 gpt-6-luna the previous fix did not change the failure: more reasoning (high) on the same model');
    expect(r.status).toBe('stopped');
    expect(r.reason).toMatch(/escalation limit/);
    const wide = ver([fail(TS())], impact({ critical: true }));
    h = harness([wide, wide, wide], { cfg: cfg({ max_repair_attempts: 4 }) });
    r = await selfHeal(wide, h.d);
    expect(r.models).toEqual(['gpt-6-sol', 'gpt-6-astra']); // complex: starts one tier up, may reach the top tier
    expect(r.escalations).toBe(1);
  });
  it('escalation limit: max_escalations = 0 never switches model', async () => {
    const same = ver([fail(TS())]);
    const h = harness([same, same], { cfg: cfg({ max_escalations: 0, max_repair_attempts: 3 }) });
    const r = await selfHeal(same, h.d);
    expect([r.models, r.status]).toEqual([['gpt-6-luna'], 'stopped']);
  });
  it('environment and pre-existing failures never trigger code changes', async () => {
    for (const v of [ver([fail("Error: Cannot find module 'vitest'", 'missing dependency', check('tests', 'npm test'))]), ver([fail("src/legacy/old.ts(1,1): error TS2304: Cannot find name 'x'.")]), ver([fail('1 test failed', 'test failure', check('tests', 'npm test'))])]) {
      const h = harness([]);
      const r = await selfHeal(v, h.d);
      expect([r.status, h.turns.length]).toEqual(['skipped', 0]);
    }
  });
  it('transient failure: checks re-run once without touching code', async () => {
    const h = harness([ver([pass(check('tests', 'npm test'))])]);
    const r = await selfHeal(ver([fail('Error: socket hang up', 'test failure', check('tests', 'npm test'))]), h.d);
    expect([r.status, h.turns.length]).toEqual(['not-needed', 0]);
    expect(h.log[0]).toMatch(/Transient failure .* re-running the checks once, code unchanged/);
    const again = harness([ver([fail('Error: socket hang up', 'test failure', check('tests', 'npm test'))])]);
    expect((await selfHeal(ver([fail('ECONNRESET', 'test failure', check('tests', 'npm test'))]), again.d)).status).toBe('skipped');
  });
  it('mixed failures: only the code failure is repaired', async () => {
    const h = harness([ver([pass(), fail("Error: Cannot find module 'x'", 'missing dependency', check('tests', 'npm test'))])]);
    const r = await selfHeal(ver([fail(TS()), fail("Error: Cannot find module 'x'", 'missing dependency', check('tests', 'npm test'))]), h.d);
    expect([r.attempts, r.status]).toEqual([1, 'skipped']);
    expect(h.turns[0].prompt).not.toContain("Cannot find module 'x'");
  });
  it('cancellation stops the loop and keeps the checkpoint record', async () => {
    const h = harness([ver([fail(TS(2))])], { cancelAfter: 1 });
    const r = await selfHeal(ver([fail(TS())]), h.d);
    expect([r.status, h.turns.length]).toEqual(['cancelled', 1]);
    expect(h.checkpoints).toEqual(['begin:self-heal attempt 1: make add faster', 'finish:true']);
  });
  it('disabled: reports, does nothing', async () => {
    const h = harness([], { cfg: cfg({ enabled: false }) });
    expect((await selfHeal(ver([fail(TS())]), h.d)).status).toBe('skipped');
    expect(h.turns).toEqual([]);
  });
});
