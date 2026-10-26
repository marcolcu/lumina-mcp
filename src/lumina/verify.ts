import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RouterConfig } from '../smart-codex/config.js';
import { readHead, resolveImports } from '../smart-codex/context.js';
import { redact } from '../smart-codex/run.js';
import { unwrap } from './approval/policy.js';
import { listFiles } from './repomap.js';
import { TEST_CMD } from './stages.js';
import { API_RELEVANT, ContractReport } from './apicontract.js';
import type { TurnItem } from './tui/chat.js';

/**
 * Smart verification: after a turn changed files, pick the checks that matter for THOSE changes (related tests,
 * type check, lint, full suite, build) from the commands the project already defines, reuse results Codex already
 * produced on the same code, run the rest locally (argv only, never a shell built from data) and classify failures.
 * Deterministic: no model call. Never runs scripts that look like migrations, seeding, deployments or e2e suites.
 */
export type Level = 'quick' | 'standard' | 'full';
export type Mode = Level | 'auto' | 'off';
export type CheckKind = 'related' | 'typecheck' | 'lint' | 'tests' | 'build' | 'api';
export interface Change { path: string; kind: 'added' | 'modified' | 'deleted' }
export interface Check { kind: CheckKind; label: string; argv: string[]; /** Normalised command line (for reuse matching and display). */ command: string; /** Other spellings of the same check (e.g. the package script's own body). */ forms: string[]; /** What the approval policy judges: the script without the test-file arguments Lumina itself added (repository paths, passed as argv, never through a shell). */ approval?: string }
export interface Toolchain {
  stack: string;
  checks: Partial<Record<CheckKind, Check>>;
  /** Builds the related-tests check for given test files / packages; undefined when the runner cannot target files. */
  related?: (targets: string[]) => Check;
  /** What related tests are expressed as: test files (JS/Python) or Go packages. */
  targets: 'files' | 'packages' | 'none';
  skipped: { label: string; reason: string }[];
}
export interface Impact {
  changes: Change[]; modules: string[]; tests: string[]; packages: string[]; importers: number; /** Files importing a changed file (bounded). */ importerFiles: string[];
  flags: { critical: boolean; migration: boolean; shared: boolean; deps: boolean; config: boolean; docsOnly: boolean; testsOnly: boolean };
  reasons: string[];
  /** Dependency-graph prediction merged in (counts only). */
  prediction?: { risk: 'low' | 'medium' | 'high'; confirmed: number; predicted: number; breaking: number; tests: number };
}
export type FailureClass = 'contract mismatch' | 'test failure' | 'compilation error' | 'lint error' | 'environment problem' | 'missing dependency' | 'external service unavailable' | 'unrelated test failure (possibly pre-existing)';
export interface CheckResult { check: Check; status: 'passed' | 'failed' | 'skipped'; source: 'ran' | 'codex' | 'cache'; ms: number; exitCode?: number | null; failure?: FailureClass; tail?: string; /** Redacted end of the output (≤ 6000 chars), for diagnosis. */ output?: string; note?: string }

export const TEST_FILE = /(_test\.go|\.(test|spec)\.[cm]?[jt]sx?|(^|\/)test_[^/]+\.py|_test\.py)$/;
const JS = /\.[cm]?[jt]sx?$/;
const DOCS = /\.(md|mdx|txt|rst|adoc|png|jpe?g|gif|svg|ico|webp)$|(^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$/i;
export const CRITICAL = /(^|[/_.-])(auth\w*|login|logout|session|jwt|oauth|sso|password|passwd|permissions?|rbac|acl|security|crypto|credentials?|tokens?|payments?|billing|checkout)([/_.-]|$)/i;
const MIGRATION = /(^|\/)(migrations?|migrate|alembic\/versions|db\/migrate)\/|(^|\/)schema\.prisma$|\.sql$/i;
export const SHARED_DIR = /(^|\/)(lib|libs|shared|common|utils?|core|pkg)\//;
const DEPS = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|pyproject\.toml|requirements[^/]*\.txt|poetry\.lock|uv\.lock)$/;
const CONFIG = /(^|\/)(tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[a-z]+|(vite|vitest|jest|next|webpack|babel)\.config\.[a-z]+|\.babelrc|setup\.cfg|pytest\.ini|tox\.ini|\.golangci\.ya?ml)$/;
/** Scripts that may change a database, deploy, or need external services: never run automatically. */
const DANGEROUS = /\b(migrat\w*|seed\w*|prisma\s+(migrate|db)|db:\w+|knex|sequelize|typeorm|docker|compose|deploy\w*|terraform|kubectl|e2e|playwright|cypress|integration|drop|truncate)\b/i;
const RUNNER = /^(?:npx\s+|pnpm\s+exec\s+|yarn\s+|bunx\s+)?(vitest(?:\s+run)?|jest|mocha|ava|node\s+--test|tap|uvu)(?:\s|$)/;

const norm = (c: string) => unwrap(c).replace(/\s+/g, ' ').trim();
const strip = (c: string) => c.replace(/^(npx|bunx|pnpm exec|yarn exec) /, '').replace(/^node_modules\/\.bin\//, '');
const mk = (kind: CheckKind, label: string, argv: string[], forms: string[] = []): Check => ({ kind, label, argv, command: argv.join(' '), forms: forms.map(norm) });
const json = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };

/** The project's own verification commands. Nothing is invented: package scripts, or tools the project configures. */
export function discoverToolchain(root: string): Toolchain {
  const has = (f: string) => { try { return fs.lstatSync(path.join(root, f)).isFile(); } catch { return false; } };
  const read = (f: string) => readHead(root, f, 64 * 1024);
  const t: Toolchain = { stack: '', checks: {}, targets: 'none', skipped: [] };
  const safe = (label: string, body: string): boolean => {
    if (!DANGEROUS.test(body)) return true;
    t.skipped.push({ label, reason: `script may touch a database or external services (${DANGEROUS.exec(body)![0]})` });
    return false;
  };

  if (has('package.json')) {
    const pj = json(read('package.json'));
    const scripts = (pj.scripts ?? {}) as Record<string, string>;
    const deps = { ...(pj.dependencies as object), ...(pj.devDependencies as object) } as Record<string, string>;
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const run = (name: string) => (name === 'test' ? (pm === 'bun' ? ['bun', 'run', 'test'] : [pm, 'test']) : pm === 'yarn' ? ['yarn', name] : [pm, 'run', name]);
    t.stack = 'typescript' in deps || has('tsconfig.json') ? 'TypeScript' : 'Node.js';
    const script = (names: string[]) => names.find((n) => typeof scripts[n] === 'string' && scripts[n].trim());
    const testName = script(['test']);
    if (testName && !/no test specified/.test(scripts.test) && safe('Test suite', scripts.test)) {
      t.checks.tests = mk('tests', 'Full test suite', run('test'), [scripts.test]);
      const body = norm(scripts.test);
      // the runner can be given files only when the script IS a single runner invocation
      if (RUNNER.test(body) && !/[;&|]/.test(body)) {
        t.targets = 'files';
        t.related = (files) => ({ ...mk('related', `${files.length} relevant test file${files.length === 1 ? '' : 's'}`, [...run('test'), ...(pm === 'npm' ? ['--'] : []), ...files], [`${body} ${files.join(' ')}`]), approval: run('test').join(' ') });
      }
    }
    const tc = script(['typecheck', 'type-check', 'check-types', 'types', 'tsc']);
    if (tc) { if (safe('Type check', scripts[tc])) t.checks.typecheck = mk('typecheck', 'TypeScript', run(tc), [scripts[tc]]); }
    else if (has('tsconfig.json') && has('node_modules/.bin/tsc')) t.checks.typecheck = mk('typecheck', 'TypeScript', ['node_modules/.bin/tsc', '--noEmit'], ['tsc --noEmit']);
    const lint = script(['lint']);
    if (lint) { if (safe('Lint', scripts[lint])) t.checks.lint = mk('lint', /eslint/.test(scripts[lint]) ? 'ESLint' : 'Lint', run(lint), [scripts[lint]]); }
    const build = script(['build']);
    if (build && safe('Build', scripts[build])) t.checks.build = mk('build', 'Build', run(build), [scripts[build]]);
    return t;
  }
  if (has('go.mod')) {
    t.stack = 'Go';
    t.targets = 'packages';
    t.related = (pkgs) => mk('related', `tests of ${pkgs.length} package${pkgs.length === 1 ? '' : 's'}`, ['go', 'test', ...pkgs]);
    t.checks.tests = mk('tests', 'Full test suite', ['go', 'test', './...']);
    t.checks.lint = mk('lint', 'go vet', ['go', 'vet', './...']);
    t.checks.build = mk('build', 'Build', ['go', 'build', './...']);
    return t;
  }
  if (has('Cargo.toml')) {
    t.stack = 'Rust';
    t.checks.typecheck = mk('typecheck', 'cargo check', ['cargo', 'check']);
    t.checks.tests = mk('tests', 'Full test suite', ['cargo', 'test']);
    t.checks.build = mk('build', 'Build', ['cargo', 'build']);
    return t;
  }
  const py = has('pyproject.toml') ? read('pyproject.toml') : '';
  const reqs = ['requirements.txt', 'requirements-dev.txt'].filter(has).map(read).join('\n');
  if (py || reqs || has('setup.py')) {
    t.stack = 'Python';
    const pre = has('uv.lock') ? ['uv', 'run'] : has('poetry.lock') ? ['poetry', 'run'] : [];
    if (/\bpytest\b/i.test(py + reqs) || has('pytest.ini') || has('conftest.py') || has('tests/conftest.py')) {
      t.checks.tests = mk('tests', 'Full test suite', [...pre, 'pytest'], ['pytest']);
      t.targets = 'files';
      t.related = (files) => ({ ...mk('related', `${files.length} relevant test file${files.length === 1 ? '' : 's'}`, [...pre, 'pytest', ...files], [`pytest ${files.join(' ')}`]), approval: [...pre, 'pytest'].join(' ') });
    }
    if (/^\[tool\.ruff/m.test(py) || has('ruff.toml') || has('.ruff.toml')) t.checks.lint = mk('lint', 'Ruff', [...pre, 'ruff', 'check', '.'], ['ruff check .']);
    if (/^\[tool\.mypy/m.test(py) || has('mypy.ini')) t.checks.typecheck = mk('typecheck', 'mypy', [...pre, 'mypy', '.'], ['mypy .']);
  }
  return t;
}

/** What the changes touch: modules, related tests, importers and risk signals. Reads at most a few KB per file. */
export async function analyzeImpact(root: string, changes: Change[]): Promise<Impact> {
  const changed = changes.map((c) => c.path);
  const files = (await listFiles(root).catch(() => ({ files: [] as string[] }))).files;
  const known = new Set(files);
  const stem = (f: string) => path.posix.basename(f).replace(/(_test)?\.[^.]+$/, '').replace(/\.(test|spec)$/, '').replace(/^test_/, '').toLowerCase();
  const changedSet = new Set(changed);
  const stems = new Set(changed.filter((f) => !TEST_FILE.test(f)).map(stem));
  const testFiles = files.filter((f) => TEST_FILE.test(f));
  const tests = new Set(changed.filter((f) => TEST_FILE.test(f) && known.has(f)));
  for (const f of testFiles) if (stems.has(stem(f))) tests.add(f);
  // JS/TS: tests and modules that import a changed file (bounded scan of file heads)
  let importers = 0;
  const importerFiles: string[] = [];
  const importerModules = new Set<string>();
  const jsChanged = changed.filter((f) => JS.test(f));
  if (jsChanged.length) {
    const scan = files.filter((f) => JS.test(f) && !changedSet.has(f)).slice(0, 3000);
    for (const f of scan) {
      const deps = resolveImports(f, readHead(root, f, 8192), known);
      if (!deps.some((d) => changedSet.has(d))) continue;
      if (TEST_FILE.test(f)) tests.add(f);
      else { importers++; if (importerFiles.length < 200) importerFiles.push(f); importerModules.add(f.split('/').slice(0, 2).join('/')); }
    }
  }
  const packages = [...new Set(changed.filter((f) => f.endsWith('.go')).map((f) => path.posix.dirname(f)).filter((d) => files.some((x) => x.endsWith('.go') && path.posix.dirname(x) === d)).map((d) => (d === '.' ? '.' : `./${d}`)))];
  const modules = [...new Set(changed.map((f) => (f.includes('/') ? f.split('/').slice(0, f.startsWith('src/') || f.startsWith('internal/') || f.startsWith('apps/') || f.startsWith('packages/') ? 2 : 1).join('/') : '.')))];
  const code = changed.filter((f) => !DOCS.test(f));
  const flags = {
    critical: code.some((f) => CRITICAL.test(f)),
    migration: changed.some((f) => MIGRATION.test(f)),
    shared: code.some((f) => SHARED_DIR.test(f)) || importers >= 5 || importerModules.size >= 3,
    deps: changed.some((f) => DEPS.test(f)),
    config: changed.some((f) => CONFIG.test(f)),
    docsOnly: changed.length > 0 && !code.length,
    testsOnly: code.length > 0 && code.every((f) => TEST_FILE.test(f)),
  };
  const reasons: string[] = [];
  if (flags.migration) reasons.push('database migration');
  if (flags.deps) reasons.push('dependencies changed');
  if (flags.critical) reasons.push('security-sensitive code');
  if (flags.shared) reasons.push(importers ? `shared code (${importers} importer${importers === 1 ? '' : 's'})` : 'shared code');
  if (flags.config) reasons.push('tool configuration');
  if (modules.length >= 3) reasons.push(`${modules.length} modules`);
  return { changes, modules, tests: [...tests].sort(), packages, importers, importerFiles, flags, reasons };
}

/** The part of an impact prediction verification uses (kept structural to avoid a dependency cycle). */
export interface PredictedImpact { risk: 'low' | 'medium' | 'high'; reasons: string[]; tests: string[]; confirmed: { file: string }[]; predicted: { file: string }[]; breaking: { symbol: string; change: string; users: number }[] }

/** Graph-confirmed dependents become importers (and their tests related tests); high risk is treated like shared code. */
export function mergePrediction(impact: Impact, p: PredictedImpact): void {
  const tests = new Set(impact.tests);
  for (const t of p.tests) tests.add(t);
  impact.tests = [...tests].sort();
  for (const a of p.confirmed) if (!impact.importerFiles.includes(a.file)) impact.importerFiles.push(a.file);
  for (const t of p.tests) if (t.endsWith('_test.go')) { const d = path.posix.dirname(t); const pkg = d === '.' ? '.' : `./${d}`; if (!impact.packages.includes(pkg)) impact.packages.push(pkg); }
  impact.prediction = { risk: p.risk, confirmed: p.confirmed.length, predicted: p.predicted.length, breaking: p.breaking.filter((b) => b.users > 0).length, tests: p.tests.length };
  if (p.risk === 'high') { impact.flags.shared = true; impact.reasons.unshift(`impact: ${p.reasons[0] ?? 'high'}`); }
  else if (p.risk === 'medium' && p.confirmed.length) impact.reasons.push(`impact: ${p.confirmed.length} dependent file${p.confirmed.length === 1 ? '' : 's'}`);
}

const ASK_FULL = /\b(full verification|verify (everything|all)|run (all|every|the (full|whole|entire)) (the )?tests?|full (test )?suite|(all|every) tests?|verifikasi (penuh|lengkap|semua)|(jalankan|run) semua (test|tes)|semua (test|tes))\b/i;
const ASK_NONE = /\b(skip|don'?t run|do not run|no) (the )?(tests?|verification|checks?)\b|\b(jangan|tanpa|ga usah|gak usah|nggak usah|tidak usah) (jalankan |run )?(test|tes|verifikasi)\b/i;
const ASK_QUICK = /\b(quick (check|verification|verify)|verify quickly|cek cepat|verifikasi cepat)\b/i;

/** Level: an explicit user instruction, then the configured mode, then the change itself. */
export function chooseLevel(impact: Impact, mode: Mode, request = ''): { level: Level | 'off'; reason: string } {
  if (ASK_NONE.test(request)) return { level: 'off', reason: 'you asked to skip verification' };
  if (ASK_FULL.test(request)) return { level: 'full', reason: 'you asked for full verification' };
  if (ASK_QUICK.test(request)) return { level: 'quick', reason: 'you asked for a quick check' };
  if (mode !== 'auto') return { level: mode, reason: `verification.mode = ${mode}` };
  const f = impact.flags;
  const why = impact.reasons.join(', ');
  if (f.docsOnly) return { level: 'off', reason: 'documentation only' };
  if (f.migration || f.deps) return { level: 'full', reason: why };
  if (f.critical) return { level: impact.changes.length >= 10 || impact.modules.length >= 3 ? 'full' : 'standard', reason: why };
  if (f.shared || f.config || impact.modules.length >= 3 || impact.changes.length >= 8) return { level: 'standard', reason: why || `${impact.changes.length} files` };
  return { level: 'quick', reason: `${impact.changes.length} file${impact.changes.length === 1 ? '' : 's'} in ${impact.modules.join(', ') || 'the project'}` };
}

/** Checks for a level; everything available but not needed is listed as skipped with the reason. */
export function planChecks(level: Level, t: Toolchain, impact: Impact): { checks: Check[]; skipped: { label: string; reason: string }[] } {
  const c = t.checks;
  const checks: Check[] = [];
  const targets = t.targets === 'packages' ? impact.packages : t.targets === 'files' ? impact.tests : [];
  const related = t.related && targets.length ? t.related(targets) : undefined;
  if (level === 'full') checks.push(...[c.typecheck, c.lint, c.tests, c.build].filter((x): x is Check => Boolean(x)));
  else {
    if (level === 'standard') checks.push(...[c.typecheck, c.lint].filter((x): x is Check => Boolean(x)));
    // relevant tests: targeted when the runner allows it; otherwise the suite is the only way to run them
    if (related) checks.push(related);
    else if (c.tests && (level === 'standard' || t.targets === 'none')) checks.push(c.tests);
    if (level === 'quick' && !checks.length && c.typecheck) checks.push(c.typecheck); // a compile check at least
  }
  const skipped = [...t.skipped];
  for (const x of [c.typecheck, c.lint, c.tests, c.build]) if (x && !checks.includes(x)) skipped.push({ label: x.label, reason: 'not required for this change' });
  if (!related && t.related && level !== 'full' && !checks.some((x) => x.kind === 'tests')) skipped.push({ label: 'Related tests', reason: 'no tests found for the changed files' });
  return { checks, skipped };
}

/** Revision of the working tree: HEAD state, the diff, and untracked files' contents. null outside git. */
export async function revision(root: string): Promise<string | null> {
  const git = (args: string[]) => new Promise<string | null>((resolve) => { execFile('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }, (err, out) => resolve(err ? null : out)); });
  const [head, status, diff, untracked] = await Promise.all([git(['rev-parse', '-q', '--verify', 'HEAD']), git(['status', '--porcelain', '-z']), git(['diff', 'HEAD', '--binary']), git(['ls-files', '-z', '--others', '--exclude-standard'])]);
  if (status === null) return null;
  const h = createHash('sha1').update(head ?? '').update(status).update(diff ?? '');
  for (const f of (untracked ?? '').split('\0').filter(Boolean).slice(0, 500)) {
    try { const st = fs.lstatSync(path.join(root, f)); if (st.isFile() && st.size < 2 << 20) h.update(f).update(fs.readFileSync(path.join(root, f))); else h.update(`${f}:${st.size}:${st.mtimeMs}`); } catch { /* gone */ }
  }
  return h.digest('hex');
}

/** Candidate commands a turn item stands for: exit code reflects them (no pipes; last `;` segment; any `&&` part). */
function commandsOf(it: TurnItem): string[] {
  const c = norm(it.command ?? '');
  if (/\|/.test(c)) return []; // a pipe's exit code is the last command's
  const parts = (c.split(';').pop() ?? '').split('&&').map((x) => x.trim());
  const cd = parts.findIndex((p) => /^cd\s/.test(p));
  return cd >= 0 ? parts.slice(0, cd) : parts;
}
const verificationLike = (c: string) => TEST_CMD.test(c) || /\b(tsc|eslint|ruff|mypy|go vet|cargo check|clippy|lint|typecheck)\b/.test(c);

/**
 * A passing Codex run that proves `check` on the code as it is now: same command (or the script it runs, or the full
 * suite for related tests), run in the repository root, and nothing changed files after it in the turn.
 */
export function reusedFromTurn(check: Check, items: TurnItem[], root: string, full?: Check): TurnItem | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.type === 'fileChange') return undefined; // everything before this edit is stale
    if (it.type !== 'commandExecution') continue;
    const readOnly = (it.actions ?? []).length > 0 && it.actions!.every((a) => a === 'read' || a === 'search' || a === 'listFiles');
    const cmds = commandsOf(it);
    const matches = it.exitCode === 0 && (!it.cwd || path.resolve(it.cwd) === root) && cmds.some((c) => covers(check, c, full));
    if (matches) return it;
    if (!readOnly && !cmds.some(verificationLike) && it.command) return undefined; // an unknown command may have changed files
  }
  return undefined;
}

function covers(check: Check, cmd: string, full?: Check): boolean {
  const c = strip(cmd);
  const same = (k: Check) => [k.command, ...k.forms].some((f) => strip(f) === c);
  if (same(check)) return true;
  if (check.kind === 'related' && full && same(full)) return true; // the whole suite includes the related tests
  if (check.kind === 'related' && check.argv[0] === 'go' && /^go test (\.\/\.\.\.)$/.test(c)) return true;
  if (check.kind === 'related') {
    // the same runner given (at least) the same test files
    const runner = RUNNER.exec(strip(check.forms[0] ?? ''))?.[1];
    const files = check.forms[0]?.split(' ').filter((w) => TEST_FILE.test(w)) ?? [];
    return Boolean(runner && RUNNER.exec(c)?.[1] === runner && files.length && files.every((f) => c.split(' ').includes(f)));
  }
  return false;
}

const SIGNS: [FailureClass, RegExp][] = [
  ['external service unavailable', /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b|getaddrinfo|connection refused|could not connect to (the )?(server|database)|Connection reset by peer/i],
  ['missing dependency', /command not found|ERR_MODULE_NOT_FOUND|Cannot find package|Cannot find module '(?!\.)[^']+'(?![^\n]*TS2307)|ModuleNotFoundError|No module named|no required module provides package|missing go\.sum entry|could not find `?[\w-]+`? in (the )?registry|node_modules missing|is not installed|not found: \w+/i],
  ['environment problem', /EACCES|EPERM|ENOSPC|permission denied|JavaScript heap out of memory|out of memory|Killed|timed out after/i],
];
const COMPILE = /error TS\d+|SyntaxError|cannot find symbol|^\S+\.go:\d+:\d+: |error\[E\d+\]|undefined: \w+|IndentationError|compilation failed|Build failed/m;
const FAILING_FILE = /(?:^|\s)(?:FAIL|✗|×|FAILED)\s+([\w./-]+\.(?:[cm]?[jt]sx?|py|go))/gm;

/** Why a check failed. Environment-type failures must not be "fixed" by editing application code. */
export function classifyFailure(check: Check, exitCode: number | null | undefined, tail: string, impact?: Impact): FailureClass {
  if (exitCode === 127 || exitCode === 126) return 'missing dependency';
  const found = SIGNS.find(([, re]) => re.test(tail));
  if (found) return found[0];
  if (check.kind === 'typecheck' || check.kind === 'build') return 'compilation error';
  if (check.kind === 'lint') return 'lint error';
  if (COMPILE.test(tail)) return 'compilation error';
  if (check.kind === 'tests' && impact) {
    const failing = [...tail.matchAll(FAILING_FILE)].map((m) => m[1].replace(/^\.\//, ''));
    const mods = new Set(impact.modules);
    const related = (f: string) => impact.tests.some((t) => t.endsWith(f) || f.endsWith(t)) || mods.has(f.split('/').slice(0, 2).join('/')) || mods.has(f.split('/')[0]);
    if (failing.length && !failing.some(related)) return 'unrelated test failure (possibly pre-existing)';
  }
  return 'test failure';
}
export const isEnvironmental = (f?: FailureClass) => f === 'environment problem' || f === 'missing dependency' || f === 'external service unavailable';

/** Runs one check: argv only, its own process group (killed on timeout/cancel), CI=1 so runners never enter watch mode. */
export function runCheck(check: Check, root: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number | null; tail: string; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let tail = '';
    const keep = (d: Buffer) => { tail = (tail + d.toString()).slice(-6000); };
    let child;
    try {
      child = spawn(check.argv[0], check.argv.slice(1), { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' } });
    } catch (e) { return resolve({ exitCode: 127, tail: String(e), ms: 0 }); }
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(() => { tail += `\ntimed out after ${Math.round(timeoutMs / 1000)}s`; kill(); }, timeoutMs);
    const onAbort = () => { tail += '\ncancelled'; kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e: NodeJS.ErrnoException) => { tail += `\n${e.code === 'ENOENT' ? `command not found: ${check.argv[0]}` : e.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode: code ?? (tail.includes('command not found') ? 127 : null), tail, ms: Date.now() - t0 });
    });
  });
}

export interface VerifyHooks {
  /** Asked once before running checks the approval policy would not auto-approve. */
  confirm(checks: Check[]): Promise<boolean>;
  approved(check: Check): boolean;
  start?(check: Check): void;
  done?(result: CheckResult): void;
}
export interface Verification { level: Level | 'off'; reason: string; stack: string; impact: Impact; results: CheckResult[]; skipped: { label: string; reason: string }[]; declined?: boolean }

/** Session-scoped verifier: remembers passing results per (command, revision) so identical checks are not rerun. */
export class Verifier {
  private passed = new Map<string, { rev: string; ms: number }>();
  /** `predict` (optional): dependency-graph impact of the changes, used to add related tests and raise the level. */
  constructor(private readonly root: string, private readonly cfg: RouterConfig['verification'], private readonly predict?: (changes: Change[]) => Promise<PredictedImpact | undefined>,
    /** API contract check (static, no command run); only findings that involve changed files count. */
    private readonly contracts?: () => Promise<ContractReport | undefined>) {}

  private async contractCheck(changes: Change[]): Promise<CheckResult | undefined> {
    if (!this.contracts || !changes.some((c) => API_RELEVANT.test(c.path))) return undefined;
    const t0 = Date.now();
    const r = await this.contracts().catch(() => undefined);
    if (!r || !r.endpoints.length) return undefined;
    const changed = new Set(changes.map((c) => c.path));
    const mine = r.findings.filter((f) => f.evidence.some((e) => changed.has(e.replace(/^(frontend|backend) /, '').replace(/:\d+.*$/, ''))));
    const verified = mine.filter((f) => f.status === 'verified');
    const check: Check = { kind: 'api', label: 'API contracts', argv: [], command: 'lumina /api-check', forms: [] };
    const lines = mine.map((f) => `${f.status === 'verified' ? 'VERIFIED' : 'possible'} ${f.kind} · ${f.endpoint}${f.field ? ` · ${f.field}` : ''}: ${f.detail} [${f.evidence.join(', ')}]`);
    const note = `${r.endpoints.length} endpoint${r.endpoints.length === 1 ? '' : 's'} · ${mine.length - verified.length} possible mismatch${mine.length - verified.length === 1 ? '' : 'es'} (not verified)`;
    return verified.length
      ? { check, status: 'failed', source: 'ran', ms: Date.now() - t0, exitCode: 1, failure: 'contract mismatch', tail: lines.slice(0, 8).join('\n'), output: lines.join('\n') }
      : { check, status: 'passed', source: 'ran', ms: Date.now() - t0, exitCode: 0, note };
  }

  async verify(changes: Change[], opts: { request?: string; items?: TurnItem[]; mode?: Mode; hooks: VerifyHooks; signal?: AbortSignal }): Promise<Verification> {
    const impact = await analyzeImpact(this.root, changes);
    const p = this.predict ? await this.predict(changes).catch(() => undefined) : undefined;
    if (p) mergePrediction(impact, p);
    const t = discoverToolchain(this.root);
    const { level, reason } = chooseLevel(impact, opts.mode ?? this.cfg.mode, opts.request);
    const base = { level, reason, stack: t.stack, impact, results: [] as CheckResult[] };
    if (level === 'off') return { ...base, skipped: [] };
    const api = await this.contractCheck(changes);
    const withApi = <T extends { results: CheckResult[] }>(v: T): T => { if (api) { v.results.push(api); hooksDone?.(api); } return v; };
    const hooksDone = opts.hooks.done;
    const { checks, skipped } = planChecks(level, t, impact);
    if (!checks.length) return withApi({ ...base, skipped: skipped.length ? skipped : [{ label: 'Verification', reason: 'no test, type-check, lint or build configuration found' }] });
    const rev = this.cfg.reuse ? await revision(this.root) : null;
    // reuse first (Codex's own runs on the current code, then this session's earlier passes on the same revision)
    const pending: Check[] = [];
    for (const c of checks) {
      const fromTurn = this.cfg.reuse ? reusedFromTurn(c, opts.items ?? [], this.root, t.checks.tests) : undefined;
      const cached = rev ? this.passed.get(c.command) : undefined;
      if (fromTurn) base.results.push({ check: c, status: 'passed', source: 'codex', ms: fromTurn.durationMs ?? 0, exitCode: 0, note: `reused Codex's run of \`${norm(fromTurn.command ?? '').slice(0, 80)}\`` });
      else if (cached && cached.rev === rev) base.results.push({ check: c, status: 'passed', source: 'cache', ms: cached.ms, exitCode: 0, note: 'unchanged since it last passed' });
      else { pending.push(c); continue; }
      if (rev) this.passed.set(c.command, { rev, ms: base.results.at(-1)!.ms });
      opts.hooks.done?.(base.results.at(-1)!);
    }
    if (pending.length && pending.some((c) => !opts.hooks.approved(c)) && !(await opts.hooks.confirm(pending))) {
      for (const c of pending) base.results.push({ check: c, status: 'skipped', source: 'ran', ms: 0, note: 'not run (declined)' });
      return withApi({ ...base, skipped, declined: true });
    }
    for (const c of pending) {
      if (opts.signal?.aborted) { base.results.push({ check: c, status: 'skipped', source: 'ran', ms: 0, note: 'cancelled' }); continue; }
      opts.hooks.start?.(c);
      const r = await runCheck(c, this.root, this.cfg.timeout_ms, opts.signal);
      const ok = r.exitCode === 0;
      const res: CheckResult = { check: c, status: ok ? 'passed' : 'failed', source: 'ran', ms: r.ms, exitCode: r.exitCode, ...(ok ? {} : { failure: classifyFailure(c, r.exitCode, r.tail, impact), tail: redact(r.tail.trim().split('\n').slice(-12).join('\n')).slice(-1200), output: redact(r.tail) }) };
      if (ok && rev && rev === (await revision(this.root))) this.passed.set(c.command, { rev, ms: r.ms }); // the check itself must not have changed files
      base.results.push(res);
      opts.hooks.done?.(res);
    }
    return withApi({ ...base, skipped });
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);

/** One line per check, as it finishes. */
export function formatResult(r: CheckResult): string {
  const mark = r.status === 'passed' ? '✓' : r.status === 'failed' ? '✗' : '–';
  const extra = r.status === 'failed' ? ` — ${r.failure}` : r.note ? ` · ${r.note}` : '';
  return `  ${mark} ${r.check.label}${r.source === 'ran' && r.status !== 'skipped' ? ` (${r.check.command}) ${secs(r.ms)}` : ''}${extra}`;
}

export function formatHeader(v: Pick<Verification, 'level' | 'reason'>): string {
  return v.level === 'off' ? `Verification: off (${v.reason})` : `Verification: ${cap(v.level)}${v.reason ? ` · ${v.reason}` : ''}`;
}

export function formatFooter(v: Verification): string[] {
  const out: string[] = [];
  for (const r of v.results.filter((x) => x.status === 'failed')) {
    if (r.tail) out.push(...r.tail.split('\n').slice(-6).map((l) => `      ${l.slice(0, 160)}`));
    out.push(`    ${isEnvironmental(r.failure) ? 'Environment issue: fix the setup and run /verify again (application code was not changed for it).' : r.failure?.startsWith('unrelated') ? 'Failing tests look unrelated to this change; check whether they fail without it.' : 'Failure details were added to the next request; say "fix it" to let Codex fix it.'}`);
  }
  if (v.skipped.length) out.push('  Skipped:', ...v.skipped.map((s) => `    ${s.label} (${s.reason})`));
  return out;
}

/** Short summary of application failures for the next turn (redacted, bounded); environment failures are excluded. */
export function failureContext(v: Verification): string | undefined {
  const fails = v.results.filter((r) => r.status === 'failed' && !isEnvironmental(r.failure) && !r.failure?.startsWith('unrelated'));
  if (!fails.length) return undefined;
  return `[Lumina verification after your last change: ${fails.map((r) => `\`${r.check.command}\` failed (${r.failure}, exit ${r.exitCode}):\n${r.tail ?? ''}`).join('\n')}]`.slice(0, 2500);
}
