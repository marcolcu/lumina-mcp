import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../smart-codex/config.js';
import { readHead } from '../smart-codex/context.js';

/**
 * Repository map: a small, deterministic summary of the project (stack, modules, entry points) built from the file
 * list and a few manifest heads — source files are never read, nothing is ever written to the repository, no model
 * is called. Cached under the state dir and rebuilt only when the repository's structure changes.
 */
export interface RepoMap {
  version: 1;
  root: string;
  name: string;
  languages: { name: string; files: number }[];
  frameworks: string[];
  packageManagers: string[];
  workspace?: { kind: string; packages: string[] };
  modules: string[];
  entryPoints: string[];
  directories: { path: string; files: number }[];
  configFiles: string[];
  testDirs: string[];
  stats: { files: number; dirs: number; truncated: boolean };
  indexedAt: number;
  stamp: string;
}

const MAX_FILES = 200_000; // beyond this the map is built from the first files only (stats say so)
const MANIFEST_BYTES = 64 * 1024;
const IGNORED = /(^|\/)(node_modules|vendor|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.venv|venv|\.git)(\/|$)/;
const GENERATED = /(^|\/)(generated|__generated__|gen)\/|\.(gen|generated|pb|min)\.[a-z]+$|_gen\.go$|\.pb\.go$/i;
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tgz|tar|7z|jar|war|exe|dll|so|dylib|a|o|class|wasm|woff2?|ttf|eot|otf|mp[34]|mov|avi|webm|db|sqlite3?|bin|lockb)$/i;
const SECRET = /(^|\/)(\.env(\.[^/]*)?|[^/]*\.(pem|key|p12|pfx|keystore)|id_(rsa|ed25519|ecdsa)[^/]*|\.npmrc|\.netrc|credentials[^/]*|secrets?\.[a-z]+)$/i;

const LANG: Record<string, string> = {
  go: 'Go', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby', php: 'PHP', cs: 'C#', swift: 'Swift', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++',
  vue: 'Vue', svelte: 'Svelte', dart: 'Dart', scala: 'Scala', ex: 'Elixir', exs: 'Elixir', sql: 'SQL', sh: 'Shell',
};
const LOCKS: [RegExp, string][] = [
  [/^package-lock\.json$/, 'npm'], [/^pnpm-lock\.yaml$/, 'pnpm'], [/^yarn\.lock$/, 'yarn'], [/^bun\.lockb?$/, 'bun'],
  [/^go\.mod$/, 'Go modules'], [/^Cargo\.toml$/, 'Cargo'], [/^poetry\.lock$/, 'Poetry'], [/^uv\.lock$/, 'uv'], [/^Pipfile$/, 'Pipenv'], [/^requirements[^/]*\.txt$/, 'pip'],
];
// dependency name → display name, per ecosystem (checked against manifest text, never source files)
const NPM: [string, string][] = [['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['nuxt', 'Nuxt'], ['@angular/core', 'Angular'], ['svelte', 'Svelte'], ['@nestjs/core', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['vite', 'Vite'], ['prisma', 'Prisma'], ['typeorm', 'TypeORM'], ['drizzle-orm', 'Drizzle'], ['mongoose', 'MongoDB'], ['mysql2', 'MySQL'], ['pg', 'PostgreSQL'], ['tailwindcss', 'Tailwind'], ['vitest', 'Vitest'], ['jest', 'Jest'], ['@playwright/test', 'Playwright']];
const GO: [RegExp, string][] = [[/gofiber\/fiber/, 'Fiber'], [/gin-gonic\/gin/, 'Gin'], [/labstack\/echo/, 'Echo'], [/go-chi\/chi/, 'Chi'], [/gorilla\/mux/, 'Gorilla'], [/gorm\.io\/gorm/, 'GORM'], [/go-sql-driver\/mysql|gorm\.io\/driver\/mysql/, 'MySQL'], [/jackc\/pgx|lib\/pq|gorm\.io\/driver\/postgres/, 'PostgreSQL'], [/go-redis|redis\/go-redis/, 'Redis'], [/mongo-driver/, 'MongoDB'], [/grpc/, 'gRPC']];
const PY: [RegExp, string][] = [[/\bdjango\b/i, 'Django'], [/\bfastapi\b/i, 'FastAPI'], [/\bflask\b/i, 'Flask'], [/\bsqlalchemy\b/i, 'SQLAlchemy'], [/\bpytest\b/i, 'pytest']];
const RUST: [RegExp, string][] = [[/^\s*axum\b/m, 'Axum'], [/^\s*actix-web\b/m, 'Actix Web'], [/^\s*rocket\b/m, 'Rocket'], [/^\s*tokio\b/m, 'Tokio'], [/^\s*sqlx\b/m, 'SQLx'], [/^\s*diesel\b/m, 'Diesel']];
const CONFIG = /^(package\.json|tsconfig[^/]*\.json|go\.(mod|work)|Cargo\.toml|pyproject\.toml|setup\.py|requirements[^/]*\.txt|Dockerfile|docker-compose[^/]*\.ya?ml|compose\.ya?ml|Makefile|pnpm-workspace\.yaml|turbo\.json|nx\.json|lerna\.json|(next|vite|vitest|jest|webpack|tailwind|playwright)\.config\.[a-z]+|eslint\.config\.[a-z]+|\.eslintrc[^/]*|\.prettierrc[^/]*|\.golangci\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml)$/;
const ENTRY = /^(main\.go|cmd\/[^/]+\/main\.go|src\/main\.rs|src\/lib\.rs|(src\/)?(index|main|server|app)\.(ts|tsx|js|mjs)|src\/bin\/[^/]+\.rs|manage\.py|(src\/)?(main|app|wsgi|asgi)\.py|(src\/)?app\/layout\.(tsx|jsx|ts|js)|(src\/)?pages\/_app\.(tsx|jsx|ts|js))$/;
const LAYER_DIRS = /^(internal|src|app|pkg)\/(handlers?|controllers?|services?|repositor(y|ies)|routes?|api|models?|domain|usecases?|middlewares?)$/;
const MODULE_PARENTS = /^(.*\/)?(modules?|features?|domains?|apps|packages|services|internal\/app)$/;
const TEST_DIR = /(^|\/)(tests?|__tests__|specs?|e2e|integration)$/;
const TEST_FILE = /(_test\.go|\.(test|spec)\.[a-z]+|(^|\/)test_[^/]+\.py|_test\.py)$/;

const run = (cwd: string, args: string[]) => new Promise<string | null>((resolve) => {
  execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }, (err, out) => resolve(err ? null : out));
});

/** Files worth mapping: git's view (honours .gitignore, includes untracked), or a bounded walk outside git. */
export async function listFiles(root: string, opts: { includeGenerated?: boolean } = {}): Promise<{ files: string[]; truncated: boolean }> {
  const out = await run(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  let files = out !== null ? out.split('\0').filter(Boolean) : await walk(root);
  files = files.filter((f) => !IGNORED.test(f) && (opts.includeGenerated || !GENERATED.test(f)) && !BINARY.test(f) && !SECRET.test(f));
  const truncated = files.length > MAX_FILES;
  return { files: truncated ? files.slice(0, MAX_FILES) : files, truncated };
}

/** Outside git: breadth-first, never follows symlinks, skips hidden and dependency/build directories. */
async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [''];
  while (queue.length && files.length <= MAX_FILES) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = await fs.promises.readdir(path.join(root, dir), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !IGNORED.test(rel)) queue.push(rel); } else if (e.isFile()) files.push(rel);
    }
  }
  return files;
}

/**
 * Structure fingerprint: mtimes of the root, its first two directory levels, manifests and the git index. Adding,
 * removing or renaming entries there (or changing dependencies) changes it; editing file contents does not.
 */
async function structureStamp(root: string): Promise<string> {
  const h = createHash('sha1');
  const add = async (rel: string) => { try { const st = await fs.promises.lstat(path.join(root, rel)); h.update(`${rel}:${st.mtimeMs}:${st.size}\n`); } catch { h.update(`${rel}:-\n`); } };
  await add('.');
  await add('.git/index');
  const dirs = async (rel: string) => {
    try { return (await fs.promises.readdir(path.join(root, rel), { withFileTypes: true })).filter((e) => e.isDirectory() && !e.isSymbolicLink() && !IGNORED.test(e.name) && e.name !== '.git').map((e) => (rel === '.' ? e.name : `${rel}/${e.name}`)); } catch { return []; }
  };
  const level1 = await dirs('.');
  const level2 = (await Promise.all(level1.slice(0, 100).map(dirs))).flat().slice(0, 400);
  for (const d of [...level1, ...level2]) await add(d);
  for (const m of ['package.json', 'go.mod', 'go.work', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'pnpm-workspace.yaml']) await add(m);
  return h.digest('hex');
}

const title = (s: string) => s.replace(/[-_.]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
const json = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; } };
const uniq = <T>(a: T[]) => [...new Set(a)];

/** Builds the map from a file list (pure apart from reading a few manifest heads inside the repository). */
export function buildMap(root: string, files: string[], truncated: boolean, stamp: string): RepoMap {
  const read = (rel: string) => readHead(root, rel, MANIFEST_BYTES);
  const set = new Set(files);
  const dirs = new Set<string>();
  for (const f of files) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) { if (dirs.has(d)) break; dirs.add(d); }

  // languages, top-level directories
  const langs = new Map<string, number>();
  const top = new Map<string, number>();
  for (const f of files) {
    const lang = LANG[path.posix.extname(f).slice(1).toLowerCase()];
    if (!lang) continue;
    langs.set(lang, (langs.get(lang) ?? 0) + 1);
    const seg = f.split('/');
    const key = seg.length > 1 ? (['src', 'internal', 'apps', 'packages', 'pkg', 'cmd'].includes(seg[0]) && seg.length > 2 ? `${seg[0]}/${seg[1]}` : seg[0]) : '.';
    top.set(key, (top.get(key) ?? 0) + 1);
  }

  // manifests: root first, then workspace packages (bounded)
  const manifests = files.filter((f) => /(^|\/)(package\.json|go\.mod|Cargo\.toml|pyproject\.toml|requirements[^/]*\.txt)$/.test(f) && f.split('/').length <= 4)
    .sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 40);
  const frameworks: string[] = [];
  let name = '';
  for (const m of manifests) {
    const text = read(m);
    const base = path.posix.basename(m);
    const atRoot = !m.includes('/');
    if (base === 'package.json') {
      const pj = json(text);
      const deps = { ...(pj.dependencies as object), ...(pj.devDependencies as object), ...(pj.peerDependencies as object) } as Record<string, string>;
      for (const [dep, label] of NPM) if (dep in deps) frameworks.push(label);
      if (atRoot && typeof pj.name === 'string') name = pj.name;
    } else if (base === 'go.mod') {
      for (const [re, label] of GO) if (re.test(text)) frameworks.push(label);
      const mod = /^module\s+(\S+)/m.exec(text)?.[1];
      if (atRoot && mod && !name) name = mod.split('/').pop()!;
    } else if (base === 'Cargo.toml') {
      const deps = text.split(/^\[(?:dev-)?dependencies\]$/m).slice(1).join('\n').split(/^\[/m)[0] ?? '';
      for (const [re, label] of RUST) if (re.test(deps)) frameworks.push(label);
      const n = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(text)?.[1];
      if (atRoot && n && !name) name = n;
    } else {
      for (const [re, label] of PY) if (re.test(text)) frameworks.push(label);
      const n = /^\[project\][^[]*?^name\s*=\s*"([^"]+)"/ms.exec(text)?.[1];
      if (atRoot && n && !name) name = n;
    }
  }

  // workspace / monorepo
  const rootPj = set.has('package.json') ? json(read('package.json')) : {};
  const kind = set.has('pnpm-workspace.yaml') ? 'pnpm workspace' : rootPj.workspaces ? 'npm/yarn workspaces' : set.has('go.work') ? 'Go workspace'
    : set.has('Cargo.toml') && /^\[workspace\]/m.test(read('Cargo.toml')) ? 'Cargo workspace' : set.has('nx.json') ? 'Nx' : set.has('turbo.json') ? 'Turborepo' : set.has('lerna.json') ? 'Lerna' : '';
  const packages = uniq(manifests.filter((m) => m.includes('/') && /(^|\/)(package\.json|go\.mod|Cargo\.toml|pyproject\.toml)$/.test(m)).map((m) => path.posix.dirname(m)));
  const workspace = kind ? { kind, packages: packages.slice(0, 30) } : packages.length >= 2 ? { kind: 'multiple projects', packages: packages.slice(0, 30) } : undefined;

  // modules: children of a module-like parent; else the layered handler/service names; else src/ children
  const childDirs = (parent: string) => [...dirs].filter((d) => path.posix.dirname(d) === parent);
  let modules: string[] = [];
  const parents = [...dirs].filter((d) => MODULE_PARENTS.test(d) && childDirs(d).length >= 2).sort((a, b) => childDirs(b).length - childDirs(a).length);
  if (parents.length) modules = childDirs(parents[0]).map((d) => path.posix.basename(d));
  else {
    const layer = [...dirs].find((d) => /^(internal|src|app|pkg)\/(handlers?|controllers?|services?)$/.test(d));
    if (layer) modules = uniq(files.filter((f) => path.posix.dirname(f) === layer && !TEST_FILE.test(f)).map((f) => path.posix.basename(f).replace(/\.[^.]+$/, '').replace(/[-_.]?(handler|controller|service)s?$/i, '')).filter(Boolean));
    else if (dirs.has('src')) modules = childDirs('src').map((d) => path.posix.basename(d));
  }

  const testDirs = uniq([
    ...[...dirs].filter((d) => TEST_DIR.test(d) && !TEST_DIR.test(path.posix.dirname(d))),
    ...files.filter((f) => TEST_FILE.test(f)).map((f) => f.split('/').slice(0, 2).join('/')).filter((d) => dirs.has(d)),
  ]).sort();
  const pjMain = [rootPj.main, ...(typeof rootPj.bin === 'string' ? [rootPj.bin] : Object.values((rootPj.bin as object) ?? {}))].filter((x): x is string => typeof x === 'string').map((x) => x.replace(/^\.\//, ''));
  const entryPoints = uniq([...files.filter((f) => ENTRY.test(f)), ...pjMain.filter((x) => set.has(x)), ...[...dirs].filter((d) => LAYER_DIRS.test(d)).sort().map((d) => `${d}/`)]);

  return {
    version: 1, root,
    name: name || path.basename(root),
    languages: [...langs].sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ name: n, files: c })),
    frameworks: uniq(frameworks).filter((f) => f !== 'React' || !frameworks.includes('Next.js')), // Next.js implies React
    packageManagers: uniq(files.filter((f) => !f.includes('/')).flatMap((f) => LOCKS.filter(([re]) => re.test(f)).map(([, n]) => n))),
    workspace,
    modules: uniq(modules.map(title)).slice(0, 15),
    entryPoints: entryPoints.slice(0, 15),
    directories: [...top].filter(([d]) => d !== '.').sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, n]) => ({ path: p, files: n })),
    configFiles: files.filter((f) => CONFIG.test(f)).slice(0, 20),
    testDirs: testDirs.slice(0, 10),
    stats: { files: files.length, dirs: dirs.size, truncated },
    indexedAt: Date.now(),
    stamp,
  };
}

const cacheFile = (root: string) => path.join(stateDir(), 'repomap', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);

/**
 * The map for the repository containing `cwd` (or `cwd` itself outside git). Served from cache while the
 * structure fingerprint matches; `refresh` forces a rebuild. Read-only towards the repository.
 */
export async function repoMap(cwd: string, opts: { refresh?: boolean } = {}): Promise<RepoMap & { cached: boolean }> {
  const top = (await run(cwd, ['rev-parse', '--show-toplevel']))?.trim();
  const root = await fs.promises.realpath(top || cwd);
  const stamp = await structureStamp(root);
  const file = cacheFile(root);
  if (!opts.refresh) {
    try {
      const hit = JSON.parse(await fs.promises.readFile(file, 'utf8')) as RepoMap;
      if (hit.version === 1 && hit.root === root && hit.stamp === stamp) return { ...hit, cached: true };
    } catch { /* missing or unreadable: rebuild */ }
  }
  const { files, truncated } = await listFiles(root);
  const map = buildMap(root, files, truncated, stamp);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(`${file}.tmp`, JSON.stringify(map));
    await fs.promises.rename(`${file}.tmp`, file);
  } catch { /* cache is optional */ }
  return { ...map, cached: false };
}

/** Plain-text summary for /repo. */
export function formatRepoMap(m: RepoMap & { cached?: boolean }, now = Date.now()): string {
  const ago = (ms: number) => { const s = Math.round((now - ms) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
  const stack = uniq([...m.languages.filter((l) => ['Go', 'TypeScript', 'JavaScript', 'Python', 'Rust'].includes(l.name) || l.files >= 5).slice(0, 2).map((l) => l.name), ...m.frameworks]);
  const out = [`Project: ${m.name}`, `Root: ${m.root}`, `Stack: ${stack.join(' / ') || 'unknown'}`];
  if (m.packageManagers.length) out.push(`Package managers: ${m.packageManagers.join(', ')}`);
  if (m.workspace) out.push(`Workspace: ${m.workspace.kind}${m.workspace.packages.length ? ` · ${m.workspace.packages.length} package${m.workspace.packages.length === 1 ? '' : 's'}: ${m.workspace.packages.slice(0, 8).join(', ')}${m.workspace.packages.length > 8 ? ', …' : ''}` : ''}`);
  const list = (head: string, items: string[]) => { if (items.length) out.push('', `${head}:`, ...items.map((i) => `- ${i}`)); };
  list('Modules', m.modules);
  list('Entry Points', m.entryPoints);
  list('Main Directories', m.directories.map((d) => `${d.path}/ (${d.files} files)`));
  if (m.configFiles.length) out.push('', `Config: ${m.configFiles.join(', ')}`);
  if (m.testDirs.length) out.push(`Tests: ${m.testDirs.map((d) => `${d}/`).join(', ')}`);
  out.push('', `Stats: ${m.stats.files.toLocaleString('en-US')} files${m.stats.truncated ? '+ (truncated)' : ''} · ${m.stats.dirs.toLocaleString('en-US')} directories${m.languages.length ? ` · ${m.languages.slice(0, 5).map((l) => `${l.name} ${l.files}`).join(', ')}` : ''}`);
  out.push(`Indexed: ${ago(m.indexedAt)}${m.cached ? ' (cached)' : ''} · /repo refresh to re-index`);
  return out.join('\n');
}
