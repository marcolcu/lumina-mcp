import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { DependencyGraph } from '../../src/lumina/graph.js';
import { ImpactReport, analyzeChanges, formatImpact, predictImpact } from '../../src/lumina/impact.js';
import { Verifier, analyzeImpact, chooseLevel, mergePrediction } from '../../src/lumina/verify.js';

let root: string;
const w = (f: string, c = '') => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
const commit = () => { execFileSync('git', ['add', '-A'], { cwd: root }); execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: root }); };
const graph = () => new DependencyGraph(root).update();
const report = (r: ImpactReport | string) => { if (typeof r === 'string') throw new Error(r); return r; };
const files = (xs: { file: string }[]) => xs.map((x) => x.file).sort();

/** Orders app: service used by handler + controller (other module); a shared lib used by 5 modules; tests. */
const app = () => {
  w('package.json', JSON.stringify({ type: 'module', scripts: { test: 'node --test' } }));
  w('src/orders/types.ts', 'export interface Order {\n  id: string;\n  total: number;\n}\n');
  w('src/orders/repository.ts', "import type { Order } from './types';\nexport class OrderRepository { find(id: string): Order | undefined { return undefined; } }\n");
  w('src/orders/service.ts', "import { OrderRepository } from './repository';\nimport type { Order } from './types';\nexport class OrderService {\n  repo = new OrderRepository();\n  get(id: string): Order | undefined { return this.repo.find(id); }\n}\nexport function totalOf(o: Order): number {\n  return o.total;\n}\nfunction internalHelper() { return 1; }\n");
  w('src/http/handler.ts', "import { OrderService } from '../orders/service';\nexport function OrderHandler() { return new OrderService(); }\n");
  w('src/http/controller.ts', "import { OrderService, totalOf } from '../orders/service';\nexport class OrderController { svc = new OrderService(); t = totalOf; }\n");
  w('src/app.ts', "import { OrderHandler } from './http/handler';\nexport const app = () => OrderHandler();\n");
  w('src/server.ts', "import { app } from './app';\nexport const start = () => app();\n");
  w('test/orders/service.test.ts', "import { OrderService } from '../../src/orders/service';\nnew OrderService();\n");
  w('test/http/handler.test.ts', "import { OrderHandler } from '../../src/http/handler';\nOrderHandler();\n");
  w('src/lib/format.ts', 'export function fmt(x: number): string { return String(x); }\n');
  for (const m of ['a', 'b', 'c', 'd', 'e']) w(`src/${m}/index.ts`, `import { fmt } from '../lib/format';\nexport const ${m} = fmt(1);\n`);
  w('src/local/util.ts', 'export function onlyHere() { return 1; }\n');
  w('src/local/user.ts', "import { onlyHere } from './util';\nexport const u = onlyHere();\n");
  w('src/other/service.ts', 'export class OtherService {}\n'); // same file name, unrelated module
  execFileSync('git', ['init', '-q'], { cwd: root });
  commit();
};

beforeEach(() => {
  process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-ihome-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-i-')));
  app();
});

describe('planned changes (/impact <file-or-symbol>)', () => {
  it('symbol: confirmed users with evidence, predicted reach, related tests, medium risk; unrelated same-name files excluded', async () => {
    const r = report(predictImpact(await graph(), 'OrderService'));
    expect(files(r.confirmed)).toEqual(['src/http/controller.ts', 'src/http/handler.ts', 'test/orders/service.test.ts']);
    expect(r.confirmed.find((a) => a.file === 'src/http/handler.ts')).toMatchObject({ by: 'OrderHandler', evidence: 'imports OrderService (L1) at src/http/handler.ts:2' });
    expect(files(r.predicted)).toEqual(['src/app.ts', 'src/server.ts', 'test/http/handler.test.ts']);
    expect(r.predicted.find((a) => a.file === 'src/server.ts')!.via).toEqual(['src/http/handler.ts', 'src/app.ts', 'src/server.ts']);
    expect(r.tests).toEqual(['test/http/handler.test.ts', 'test/orders/service.test.ts']);
    expect(r.risk).toBe('medium');
    expect(JSON.stringify(r)).not.toContain('src/other/service.ts');
    const t = formatImpact(r);
    expect(t).toMatch(/^Target: OrderService {2}\(src\/orders\/service\.ts\)\n\nRisk: Medium/);
    expect(t).toContain('Confirmed dependents (graph edges): 3');
    expect(t).toContain('Potential impact (reachable through imports, not confirmed): 3');
    expect(t).toContain('not what will fail');
  });
  it('local change: low risk', async () => {
    const r = report(predictImpact(await graph(), 'src/local/util.ts'));
    expect([r.risk, files(r.confirmed), r.predicted]).toEqual(['low', ['src/local/user.ts'], []]);
  });
  it('shared library: high risk with the reason', async () => {
    const r = report(predictImpact(await graph(), 'src/lib/format.ts'));
    expect(r.confirmed).toHaveLength(5);
    expect(r.risk).toBe('high');
    expect(r.reasons[0]).toBe('shared library code used by 5 files');
  });
  it('shared interface used across modules: high; type-only edges are labelled', async () => {
    const r = report(predictImpact(await graph(), 'src/orders/types.ts'));
    expect(r.risk).toBe('high');
    expect(r.reasons[0]).toMatch(/shared contract \(interface Order\) used by 2 files/);
    expect(r.confirmed.every((a) => a.typeOnly)).toBe(true);
    expect(formatImpact(r)).toContain('src/orders/repository.ts (type only)');
  });
  it('missing graph information degrades with explicit blind spots', async () => {
    w('scripts/build.py', 'print(1)\n');
    w('src/loader.ts', "export const load = (n: string) => import(`./pages/${n}`);\n");
    w('src/broken.ts', "import { x } from '../orders/service';\n");
    const g = await graph();
    expect(predictImpact(g, 'scripts/build.py')).toMatch(/No file or symbol "scripts\/build\.py" in the dependency graph/);
    const r = report(predictImpact(g, 'src/orders/service.ts'));
    expect(r.notes.join('\n')).toMatch(/1 file use dynamic imports with computed paths/);
    expect(r.notes.join('\n')).toMatch(/unresolved import '\.\.\/orders\/service' in src\/broken\.ts:1 may refer to the target/);
  });
  it('dependency cycles terminate; long chains are bounded (depth 3) and flagged', async () => {
    w('src/cyc/a.ts', "import { b } from './b';\nexport const a = () => b();\n");
    w('src/cyc/b.ts', "import { a } from './a';\nexport const b = () => a();\n");
    for (let i = 0; i < 60; i++) w(`src/chain/c${i}.ts`, i === 0 ? 'export const c0 = 0;\n' : `import { c${i - 1} } from './c${i - 1}';\nexport const c${i} = c${i - 1};\n`);
    const g = await graph();
    const cyc = report(predictImpact(g, 'src/cyc/a.ts'));
    expect(files(cyc.confirmed)).toEqual(['src/cyc/b.ts']);
    expect(cyc.predicted).toEqual([]);
    const chain = report(predictImpact(g, 'src/chain/c0.ts'));
    expect([files(chain.confirmed), files(chain.predicted), chain.truncated]).toEqual([['src/chain/c1.ts'], ['src/chain/c2.ts', 'src/chain/c3.ts'], true]);
    expect(formatImpact(chain)).toContain('(search bounded; more may exist)');
  });
});

describe('actual changes (working tree vs HEAD)', () => {
  it('removed export still used: confirmed dependents and high risk', async () => {
    w('src/orders/service.ts', "import { OrderRepository } from './repository';\nimport type { Order } from './types';\nexport class OrderService {\n  repo = new OrderRepository();\n  get(id: string): Order | undefined { return this.repo.find(id); }\n}\n");
    const r = await analyzeChanges(await graph(), [{ path: 'src/orders/service.ts', kind: 'modified' }]);
    expect(r.breaking).toEqual([{ file: 'src/orders/service.ts', symbol: 'totalOf', change: 'removed export', users: 1, before: 'function totalOf(o: Order): number' }]);
    expect(files(r.confirmed)).toContain('src/http/controller.ts');
    expect(r.risk).toBe('high');
  });
  it('changed method signature and modified interface are reported with before/after', async () => {
    w('src/orders/service.ts', "import { OrderRepository } from './repository';\nimport type { Order } from './types';\nexport class OrderService {\n  repo = new OrderRepository();\n  get(id: string): Order | undefined { return this.repo.find(id); }\n}\nexport function totalOf(o: Order, currency: string): number {\n  return o.total;\n}\n");
    w('src/orders/types.ts', 'export interface Order {\n  id: string;\n  total: bigint;\n}\n');
    const r = await analyzeChanges(await graph(), [{ path: 'src/orders/service.ts', kind: 'modified' }, { path: 'src/orders/types.ts', kind: 'modified' }]);
    expect(r.breaking.map((b) => `${b.symbol}:${b.change}:${b.users}`).sort()).toEqual(['Order:contract changed:2', 'totalOf:signature changed:1']);
    expect(formatImpact(r)).toMatch(/totalOf \(src\/orders\/service\.ts\): signature changed · still used by 1\n {6}before: function totalOf\(o: Order\): number\n {6}after: {2}function totalOf\(o: Order, currency: string\): number/);
  });
  it('false positives avoided: an implementation-only edit reports no breaking change', async () => {
    w('src/local/util.ts', 'export function onlyHere() { return 2 + 0; }\n');
    w('src/orders/service.ts', fs.readFileSync(path.join(root, 'src/orders/service.ts'), 'utf8').replace('function internalHelper() { return 1; }', 'function internalHelper() { return 42; }'));
    const r = await analyzeChanges(await graph(), [{ path: 'src/local/util.ts', kind: 'modified' }, { path: 'src/orders/service.ts', kind: 'modified' }]);
    expect(r.breaking).toEqual([]);
    expect(r.reasons.join(' ')).not.toMatch(/breaking/);
  });
  it('a deleted file that is still imported is confirmed and high risk', async () => {
    fs.rmSync(path.join(root, 'src/local/util.ts'));
    const r = await analyzeChanges(await graph(), [{ path: 'src/local/util.ts', kind: 'deleted' }]);
    expect(r.confirmed.map((a) => a.evidence)).toEqual(["imports './util' (deleted) at src/local/user.ts:1"]);
    expect(r.risk).toBe('high');
  });
});

describe('Smart Verification integration', () => {
  it('graph dependents add related tests and high impact raises the level', async () => {
    const g = await graph();
    const changes = [{ path: 'src/orders/service.ts', kind: 'modified' as const }];
    const base = await analyzeImpact(root, changes);
    expect(base.tests).toEqual(['test/orders/service.test.ts']); // stem + direct importers only
    mergePrediction(base, report(predictImpact(g, 'src/orders/service.ts')));
    expect(base.tests).toEqual(['test/http/handler.test.ts', 'test/orders/service.test.ts']); // reaches the handler test through the graph
    expect(base.prediction).toMatchObject({ risk: 'medium', confirmed: 3 });
    const lib = await analyzeImpact(root, [{ path: 'src/local/util.ts', kind: 'modified' }]);
    expect(chooseLevel(lib, 'auto').level).toBe('quick');
    mergePrediction(lib, { ...report(predictImpact(g, 'src/local/util.ts')), risk: 'high', reasons: ['removed export still used'] });
    expect(chooseLevel(lib, 'auto')).toEqual({ level: 'standard', reason: 'impact: removed export still used' });
  });
  it('the verifier uses the predictor (no extra stage, no model call) and degrades when it fails', async () => {
    const cfg = ConfigSchema.parse({}).verification;
    const yes = { approved: () => true, confirm: async () => true };
    let called = 0;
    const v = await new Verifier(root, cfg, async (ch) => { called++; return analyzeChanges(await graph(), ch); }).verify([{ path: 'src/orders/service.ts', kind: 'modified' }], { hooks: yes });
    expect(called).toBe(1);
    expect(v.impact.prediction).toBeDefined();
    expect(v.results[0].check.command).toMatch(/test\/http\/handler\.test\.ts/);
    const failing = await new Verifier(root, cfg, async () => { throw new Error('graph broke'); }).verify([{ path: 'src/orders/service.ts', kind: 'modified' }], { hooks: yes });
    expect(failing.impact.prediction).toBeUndefined();
  }, 30000);
});
