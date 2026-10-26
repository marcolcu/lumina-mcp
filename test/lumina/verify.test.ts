import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { Change, Check, Verifier, analyzeImpact, chooseLevel, classifyFailure, discoverToolchain, failureContext, formatFooter, planChecks, reusedFromTurn } from '../../src/lumina/verify.js';
import type { TurnItem } from '../../src/lumina/tui/chat.js';

let root: string;
const w = (f: string, c = '') => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
const cfg = (o: Record<string, unknown> = {}) => ConfigSchema.parse({ verification: o }).verification;
const mod = (...p: string[]): Change[] => p.map((x) => ({ path: x, kind: 'modified' }));
const yes = { approved: () => true, confirm: async () => true };
/** Node project with a node --test suite: math (imported by app), csv, auth, lib/format shared by 5 modules. */
const nodeRepo = () => {
  execFileSync('git', ['init', '-q'], { cwd: root });
  w('package.json', JSON.stringify({ name: 'x', type: 'module', scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"', build: 'node -e "process.exit(0)"', 'db:migrate': 'knex migrate:latest' } }));
  w('src/math.js', 'export const add = (a, b) => a + b;\n');
  w('src/app.js', "import { add } from './math.js';\nexport const total = (xs) => xs.reduce(add, 0);\n");
  w('test/math.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/math.js';\ntest('add', () => assert.equal(add(2, 3), 5));\n");
  w('test/app.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { total } from '../src/app.js';\ntest('total', () => assert.equal(total([1, 2]), 3));\n");
  w('src/csv.js', 'export const split = (l) => l.split(",");\n');
  w('test/csv.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { split } from '../src/csv.js';\ntest('csv', () => assert.deepEqual(split('a,b'), ['a', 'b']));\n");
  w('src/auth/session.js', 'export const valid = (s) => Boolean(s);\n');
  w('src/lib/format.js', 'export const fmt = (x) => String(x);\n');
  for (const m of ['a', 'b', 'c', 'd', 'e']) w(`src/${m}/index.js`, "import { fmt } from '../lib/format.js';\nexport const v = fmt(1);\n");
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: root });
};

beforeEach(() => {
  process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-vhome-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-v-')));
});

describe('change impact and level', () => {
  it('single-file change: quick, the matching test and the tests importing it', async () => {
    nodeRepo();
    const i = await analyzeImpact(root, mod('src/math.js'));
    expect(i.tests).toEqual(['test/math.test.js']); // app.test imports app.js, not math.js
    expect(chooseLevel(i, 'auto').level).toBe('quick');
    expect(i.importers).toBe(1);
  });
  it('multi-module change: standard', async () => {
    nodeRepo();
    expect(chooseLevel(await analyzeImpact(root, mod('src/math.js', 'src/csv.js', 'src/a/index.js')), 'auto').level).toBe('standard');
  });
  it('shared dependency: lib file imported by 5 modules is shared → standard', async () => {
    nodeRepo();
    const i = await analyzeImpact(root, mod('src/lib/format.js'));
    expect([i.flags.shared, i.importers]).toEqual([true, 5]);
    expect(chooseLevel(i, 'auto')).toEqual({ level: 'standard', reason: 'shared code (5 importers)' });
  });
  it('authentication change: standard (full when wide); database migration: full; deps: full; docs: off', async () => {
    nodeRepo();
    expect(chooseLevel(await analyzeImpact(root, mod('src/auth/session.js')), 'auto')).toEqual({ level: 'standard', reason: 'security-sensitive code' });
    expect(chooseLevel(await analyzeImpact(root, mod('src/auth/session.js', 'src/a/index.js', 'src/b/index.js', 'src/c/index.js')), 'auto').level).toBe('full');
    expect(chooseLevel(await analyzeImpact(root, [{ path: 'migrations/2026_add_orders.sql', kind: 'added' }]), 'auto')).toEqual({ level: 'full', reason: 'database migration' });
    expect(chooseLevel(await analyzeImpact(root, mod('package.json')), 'auto').level).toBe('full');
    expect(chooseLevel(await analyzeImpact(root, mod('README.md', 'docs/x.png')), 'auto')).toEqual({ level: 'off', reason: 'documentation only' });
  });
  it('user instructions win over the change and the configured mode (English and Indonesian)', async () => {
    nodeRepo();
    const i = await analyzeImpact(root, mod('src/math.js'));
    expect(chooseLevel(i, 'quick', 'fix it and run all tests').level).toBe('full');
    expect(chooseLevel(i, 'auto', 'tolong jalankan semua test').level).toBe('full');
    expect(chooseLevel(i, 'full', "rename it, don't run the tests")).toEqual({ level: 'off', reason: 'you asked to skip verification' });
    expect(chooseLevel(i, 'standard').level).toBe('standard');
  });
});

describe('test command discovery (nothing invented)', () => {
  it('node: package scripts with the lockfile\'s package manager; targeted runs only for a single runner; dangerous scripts skipped', () => {
    w('package.json', JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'next build' }, devDependencies: { typescript: '5' } }));
    w('pnpm-lock.yaml');
    const t = discoverToolchain(root);
    expect([t.stack, t.checks.tests!.command, t.checks.typecheck!.command, t.checks.lint!.label, t.checks.build!.command]).toEqual(['TypeScript', 'pnpm test', 'pnpm run typecheck', 'ESLint', 'pnpm run build']);
    expect(t.related!(['a.test.ts']).command).toBe('pnpm test a.test.ts');
    w('package.json', JSON.stringify({ scripts: { test: 'npm run db:migrate && vitest run' } }));
    fs.rmSync(path.join(root, 'pnpm-lock.yaml'));
    const u = discoverToolchain(root);
    expect(u.checks.tests).toBeUndefined();
    expect(u.skipped[0].reason).toMatch(/database or external services \(db:migrate\)/);
    w('package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(discoverToolchain(root).checks).toEqual({});
  });
  it('npm passes files after --, yarn directly', () => {
    w('package.json', JSON.stringify({ scripts: { test: 'jest' } }));
    expect(discoverToolchain(root).related!(['x.test.js']).argv).toEqual(['npm', 'test', '--', 'x.test.js']);
    w('yarn.lock');
    expect(discoverToolchain(root).related!(['x.test.js']).argv).toEqual(['yarn', 'test', 'x.test.js']);
  });
  it('Go, Rust, Python (uv + pytest + ruff), and no configuration', async () => {
    w('go.mod', 'module m\n');
    w('internal/auth/auth.go', 'package auth'); w('internal/auth/auth_test.go', 'package auth');
    let t = discoverToolchain(root);
    const i = await analyzeImpact(root, mod('internal/auth/auth.go'));
    expect([t.stack, i.packages, planChecks('quick', t, i).checks.map((c) => c.command)]).toEqual(['Go', ['./internal/auth'], ['go test ./internal/auth']]);
    expect(planChecks('full', t, i).checks.map((c) => c.command)).toEqual(['go vet ./...', 'go test ./...', 'go build ./...']);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-v-')));
    w('Cargo.toml', '[package]\nname = "x"\n');
    t = discoverToolchain(root);
    expect(planChecks('quick', t, await analyzeImpact(root, mod('src/main.rs'))).checks.map((c) => c.command)).toEqual(['cargo test']);
    expect(planChecks('standard', t, await analyzeImpact(root, mod('src/main.rs'))).checks.map((c) => c.command)).toEqual(['cargo check', 'cargo test']);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-v-')));
    w('pyproject.toml', '[project]\nname="x"\ndependencies=["pytest"]\n[tool.ruff]\n'); w('uv.lock');
    w('app/orders.py'); w('tests/test_orders.py');
    t = discoverToolchain(root);
    const p = planChecks('standard', t, await analyzeImpact(root, mod('app/orders.py')));
    expect(p.checks.map((c) => c.command)).toEqual(['uv run ruff check .', 'uv run pytest tests/test_orders.py']);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-v-')));
    w('main.c');
    expect(discoverToolchain(root).checks).toEqual({});
  });
});

describe('verification runs and reuse', () => {
  it('runs the related tests (really), and skips what the level does not need', async () => {
    nodeRepo();
    w('src/math.js', 'export const add = (a, b) => a + b; // changed\n');
    const v = await new Verifier(root, cfg()).verify(mod('src/math.js'), { hooks: yes });
    expect(v.level).toBe('quick');
    expect(v.results.map((r) => [r.check.command, r.status, r.source])).toEqual([['npm test -- test/math.test.js', 'passed', 'ran']]);
    expect(v.skipped.map((s) => s.label)).toEqual(expect.arrayContaining(['Lint', 'Full test suite', 'Build']));
  });
  it('a real failure is reported as a test failure and handed to the next turn; nothing is run without consent', async () => {
    nodeRepo();
    w('src/math.js', 'export const add = (a, b) => a - b;\n');
    let asked = 0;
    const declined = await new Verifier(root, cfg()).verify(mod('src/math.js'), { hooks: { approved: () => false, confirm: async () => { asked++; return false; } } });
    expect([asked, declined.declined, declined.results[0].status]).toEqual([1, true, 'skipped']);
    const v = await new Verifier(root, cfg()).verify(mod('src/math.js'), { hooks: yes });
    expect([v.results[0].status, v.results[0].failure]).toEqual(['failed', 'test failure']);
    expect(failureContext(v)).toMatch(/^\[Lumina verification after your last change: `npm test -- test\/math\.test\.js` failed \(test failure, exit 1\)/);
    expect(formatFooter(v).join('\n')).toContain('say "fix it"');
  });
  it('reuses a passing Codex run on the current code; a later edit or a pipe makes it stale', () => {
    const check: Check = { kind: 'tests', label: 'Full test suite', argv: ['npm', 'test'], command: 'npm test', forms: ['node --test'] };
    const ran = (command: string, exitCode = 0, extra: Partial<TurnItem> = {}): TurnItem => ({ type: 'commandExecution', command, exitCode, actions: ['unknown'], cwd: root, ...extra });
    expect(reusedFromTurn(check, [{ type: 'fileChange', files: ['a'] }, ran("/bin/zsh -lc 'npm test'")], root)).toBeTruthy();
    expect(reusedFromTurn(check, [ran('node --test')], root)).toBeTruthy(); // the script's own body
    expect(reusedFromTurn(check, [ran('npm test'), { type: 'fileChange', files: ['a'] }], root)).toBeUndefined();
    expect(reusedFromTurn(check, [ran('npm test'), ran('sed -i s/a/b/ src/x.js')], root)).toBeUndefined();
    expect(reusedFromTurn(check, [ran('npm test'), ran('cat src/x.js', 0, { actions: ['read'] })], root)).toBeTruthy();
    expect(reusedFromTurn(check, [ran('npm test 2>&1 | tail -5')], root)).toBeUndefined();
    expect(reusedFromTurn(check, [ran('npm test', 1)], root)).toBeUndefined();
    expect(reusedFromTurn(check, [ran('npm test', 0, { cwd: '/elsewhere' })], root)).toBeUndefined();
    expect(reusedFromTurn(check, [ran('cd packages/x && npm test')], root)).toBeUndefined();
    const related: Check = { kind: 'related', label: '1 relevant test file', argv: ['npm', 'test', '--', 'test/a.test.js'], command: 'npm test -- test/a.test.js', forms: ['node --test test/a.test.js'] };
    expect(reusedFromTurn(related, [ran('npm test')], root, check)).toBeTruthy(); // the full suite covers the related tests
    expect(reusedFromTurn(related, [ran('node --test test/a.test.js test/b.test.js')], root, check)).toBeTruthy();
    expect(reusedFromTurn(related, [ran('node --test test/b.test.js')], root, check)).toBeUndefined();
  });
  it('does not rerun a check that passed on the same revision; reruns after a file changes (never a stale pass)', async () => {
    nodeRepo();
    w('src/math.js', 'export const add = (a, b) => a + b; // v2\n');
    const ver = new Verifier(root, cfg());
    expect((await ver.verify(mod('src/math.js'), { hooks: yes })).results[0].source).toBe('ran');
    const again = await ver.verify(mod('src/math.js'), { hooks: yes });
    expect([again.results[0].source, again.results[0].note]).toEqual(['cache', 'unchanged since it last passed']);
    w('src/math.js', 'export const add = (a, b) => a - b; // broken\n');
    const after = await ver.verify(mod('src/math.js'), { hooks: yes });
    expect([after.results[0].source, after.results[0].status]).toEqual(['ran', 'failed']);
    // Codex already ran the exact check after its last edit: not rerun
    w('src/math.js', 'export const add = (a, b) => a + b; // v3\n');
    const reused = await new Verifier(root, cfg()).verify(mod('src/math.js'), { hooks: yes, items: [{ type: 'fileChange', files: ['src/math.js'] }, { type: 'commandExecution', command: 'npm test', exitCode: 0, durationMs: 900 }] });
    expect([reused.results[0].source, reused.results[0].ms]).toEqual(['codex', 900]);
  });
  it('no test configuration: says so instead of passing', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    w('main.c', 'int main(){}');
    const v = await new Verifier(root, cfg()).verify(mod('main.c'), { hooks: yes });
    expect([v.results, v.skipped]).toEqual([[], [{ label: 'Verification', reason: 'no test, type-check, lint or build configuration found' }]]);
  });
  it('user-requested full verification runs typecheck/lint/suite/build but never the migration script', async () => {
    nodeRepo();
    w('src/math.js', 'export const add = (a, b) => a + b; // v4\n');
    const v = await new Verifier(root, cfg()).verify(mod('src/math.js'), { hooks: yes, request: 'make add faster, then run the full test suite' });
    expect(v.level).toBe('full');
    expect(v.results.map((r) => `${r.check.command}:${r.status}`)).toEqual(['npm run lint:passed', 'npm test:passed', 'npm run build:passed']);
    expect(JSON.stringify(v)).not.toContain('migrate:latest');
  });
});

describe('failure classification', () => {
  const t: Check = { kind: 'tests', label: 'Tests', argv: ['npm', 'test'], command: 'npm test', forms: [] };
  const tc: Check = { ...t, kind: 'typecheck', label: 'TypeScript' };
  const lint: Check = { ...t, kind: 'lint', label: 'ESLint' };
  it.each([
    [t, 127, 'sh: vitest: command not found', 'missing dependency'],
    [t, 1, "Error: Cannot find module 'vitest'", 'missing dependency'],
    [t, 1, 'ModuleNotFoundError: No module named "fastapi"', 'missing dependency'],
    [t, 1, 'connect ECONNREFUSED 127.0.0.1:5432', 'external service unavailable'],
    [t, 1, 'Error: EACCES: permission denied, open /var/x', 'environment problem'],
    [t, null, 'timed out after 600s', 'environment problem'],
    [tc, 2, "src/a.ts(3,1): error TS2307: Cannot find module './b' or its corresponding type declarations.", 'compilation error'],
    [lint, 1, '  3:1  error  no-unused-vars', 'lint error'],
    [t, 1, 'src/a.test.ts: SyntaxError: Unexpected token', 'compilation error'],
    [t, 1, 'FAIL  test/a.test.js > adds\nAssertionError: expected 1 to be 2', 'test failure'],
  ] as const)('%#: %s', (check, code, tail, kind) => {
    expect(classifyFailure(check as Check, code, tail)).toBe(kind);
  });
  it('failures only in tests unrelated to the change are flagged as possibly pre-existing, never sent to Codex', async () => {
    nodeRepo();
    const i = await analyzeImpact(root, mod('src/math.js'));
    expect(classifyFailure(t, 1, 'FAIL  test/csv.test.js > csv', i)).toBe('unrelated test failure (possibly pre-existing)');
    expect(classifyFailure(t, 1, 'FAIL  test/math.test.js > add', i)).toBe('test failure');
    const v = { level: 'full' as const, reason: '', stack: '', impact: i, skipped: [], results: [{ check: t, status: 'failed' as const, source: 'ran' as const, ms: 1, failure: 'missing dependency' as const, tail: 'x' }] };
    expect(failureContext(v)).toBeUndefined(); // environment problems are not "fixed" by editing code
    expect(formatFooter(v).join('\n')).toMatch(/Environment issue/);
  });
});
