import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildMap, formatRepoMap, repoMap } from '../../src/lumina/repomap.js';

let root: string;
const w = (f: string, c = '') => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
const gitInit = () => execFileSync('git', ['init', '-q'], { cwd: root });
const status = () => execFileSync('git', ['status', '--porcelain', '--ignored'], { cwd: root, encoding: 'utf8' });

beforeEach(() => {
  process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-rmhome-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-rm-')));
});

describe('repository map', () => {
  it('Go service: name, stack, modules from the handler layer, entry points, tests; no files written to the repo', async () => {
    gitInit();
    w('go.mod', 'module github.com/acme/wucher-backend\n\ngo 1.22\n\nrequire (\n\tgithub.com/gofiber/fiber/v2 v2.52.0\n\tgorm.io/gorm v1.25.0\n\tgorm.io/driver/mysql v1.5.0\n)\n');
    w('go.sum'); w('cmd/api/main.go', 'package main'); w('Makefile'); w('Dockerfile');
    for (const h of ['auth_handler.go', 'flight_management_handler.go', 'mission_handler.go', 'crew_handler.go', 'file_manager_handler.go', 'mission_handler_test.go']) w(`internal/handler/${h}`, 'package handler');
    w('internal/service/auth_service.go'); w('internal/repository/crew_repository.go');
    const before = status();
    const m = await repoMap(root);
    expect(m.name).toBe('wucher-backend');
    expect(m.frameworks).toEqual(['Fiber', 'GORM', 'MySQL']);
    expect(m.packageManagers).toEqual(['Go modules']);
    expect(m.modules).toEqual(['Auth', 'Crew', 'File Manager', 'Flight Management', 'Mission']);
    expect(m.entryPoints).toEqual(['cmd/api/main.go', 'internal/handler/', 'internal/repository/', 'internal/service/']);
    expect(m.configFiles).toEqual(expect.arrayContaining(['go.mod', 'Makefile', 'Dockerfile']));
    expect(m.testDirs).toEqual(['internal/handler']);
    const text = formatRepoMap(m);
    expect(text).toContain('Stack: Go / Fiber / GORM / MySQL');
    expect(text).toMatch(/Modules:\n- Auth\n- Crew/);
    expect(text).toMatch(/Indexed: just now · \/repo refresh/);
    expect(status()).toBe(before); // observational only
  });
  it('Next.js app: Next implies React, app router entry, npm, TypeScript', async () => {
    gitInit();
    w('package.json', JSON.stringify({ name: 'shop-web', dependencies: { next: '15', react: '19' }, devDependencies: { typescript: '5', vitest: '3' } }));
    w('package-lock.json', '{}'); w('tsconfig.json', '{}'); w('next.config.ts');
    w('src/app/layout.tsx'); w('src/app/page.tsx'); w('src/components/Button.tsx'); w('src/components/Button.test.tsx');
    w('src/features/cart/index.ts'); w('src/features/checkout/index.ts'); w('src/features/user-profile/index.ts');
    const m = await repoMap(root);
    expect([m.name, m.frameworks, m.packageManagers]).toEqual(['shop-web', ['Next.js', 'Vitest'], ['npm']]);
    expect(m.modules).toEqual(['Cart', 'Checkout', 'User Profile']);
    expect(m.entryPoints).toContain('src/app/layout.tsx');
    expect(m.languages[0]).toEqual({ name: 'TypeScript', files: 8 });
    expect(formatRepoMap(m)).toContain('Stack: TypeScript / Next.js / Vitest');
  });
  it('monorepo: pnpm workspace packages, frameworks from every package', async () => {
    gitInit();
    w('package.json', JSON.stringify({ name: 'platform', private: true }));
    w('pnpm-workspace.yaml', 'packages:\n  - apps/*\n  - packages/*\n'); w('pnpm-lock.yaml');
    w('apps/web/package.json', JSON.stringify({ dependencies: { next: '15' } })); w('apps/web/app/page.tsx');
    w('apps/api/package.json', JSON.stringify({ dependencies: { '@nestjs/core': '10' } })); w('apps/api/src/main.ts');
    w('packages/ui/package.json', JSON.stringify({ dependencies: { react: '19' } })); w('packages/ui/src/index.ts');
    w('services/billing/go.mod', 'module billing\nrequire github.com/gin-gonic/gin v1\n'); w('services/billing/main.go');
    const m = await repoMap(root);
    expect(m.workspace).toEqual({ kind: 'pnpm workspace', packages: expect.arrayContaining(['apps/web', 'apps/api', 'packages/ui', 'services/billing']) });
    expect(m.frameworks).toEqual(expect.arrayContaining(['Next.js', 'NestJS', 'Gin']));
    expect(m.packageManagers).toEqual(['pnpm']);
    expect(m.modules).toEqual(['Api', 'Web']); // apps/* (packages/ has one child)
  });
  it('Python and Rust projects', async () => {
    w('pyproject.toml', '[project]\nname = "ml-svc"\ndependencies = ["fastapi", "sqlalchemy"]\n'); w('uv.lock'); w('app/main.py'); w('tests/test_api.py');
    let m = await repoMap(root);
    expect([m.name, m.frameworks, m.packageManagers, m.testDirs]).toEqual(['ml-svc', ['FastAPI', 'SQLAlchemy'], ['uv'], ['tests']]);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-rm-')));
    w('Cargo.toml', '[package]\nname = "edge"\n\n[dependencies]\naxum = "0.7"\ntokio = { version = "1" }\n'); w('src/main.rs');
    m = await repoMap(root);
    expect([m.name, m.frameworks, m.packageManagers, m.entryPoints]).toEqual(['edge', ['Axum', 'Tokio'], ['Cargo'], ['src/main.rs']]);
  });
  it('empty repository: a valid map with zero files', async () => {
    gitInit();
    const m = await repoMap(root);
    expect(m.stats).toEqual({ files: 0, dirs: 0, truncated: false });
    expect(m.name).toBe(path.basename(root));
    expect(formatRepoMap(m)).toContain('Stack: unknown');
  });
  it('.gitignore, dependency/build dirs, generated, binary and secret files are never mapped (nor read)', async () => {
    gitInit();
    w('.gitignore', 'private/\n*.log\n');
    w('src/index.ts'); w('private/hidden-notes.ts'); w('debug.log'); w('node_modules/x/index.js'); w('vendor/a/b.go'); w('dist/out.js');
    w('build/x.js'); w('api/gen/client.gen.ts'); w('proto/x.pb.go'); w('logo.png'); w('.env', 'SECRET=1'); w('certs/server.pem');
    const m = await repoMap(root);
    const t = JSON.stringify({ ...m, root: '' });
    for (const bad of ['hidden-notes', 'debug.log', 'node_modules', 'vendor', 'dist', 'out.js', 'gen', 'pb.go', 'logo', '.env', 'pem']) expect(t).not.toContain(bad);
    expect(m.stats.files).toBe(2); // .gitignore + src/index.ts
  });
  it('symlinks are never followed out of the repository (git and non-git)', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-out-')));
    fs.writeFileSync(path.join(outside, 'package.json'), JSON.stringify({ name: 'evil', dependencies: { next: '1' } }));
    fs.mkdirSync(path.join(outside, 'deep')); fs.writeFileSync(path.join(outside, 'deep', 'x.ts'), '');
    w('main.go');
    fs.symlinkSync(path.join(outside, 'package.json'), path.join(root, 'package.json'));
    fs.symlinkSync(outside, path.join(root, 'linked'));
    for (const git of [false, true]) {
      if (git) gitInit();
      const m = await repoMap(root, { refresh: true });
      expect(m.name).not.toBe('evil');
      expect(m.frameworks).toEqual([]);
      expect(JSON.stringify(m)).not.toContain('deep');
    }
  });
  it('cache: served while the structure is unchanged; content edits keep it; new dirs, files and dependencies refresh it', async () => {
    gitInit();
    w('package.json', JSON.stringify({ name: 'a' })); w('src/a/x.ts');
    expect((await repoMap(root)).cached).toBe(false);
    expect((await repoMap(root)).cached).toBe(true);
    w('src/a/x.ts', 'edited content'); // same structure
    expect((await repoMap(root)).cached).toBe(true);
    w('src/b/y.ts'); // new module directory
    const m = await repoMap(root);
    expect([m.cached, m.modules]).toEqual([false, ['A', 'B']]);
    await new Promise((r) => setTimeout(r, 20));
    w('package.json', JSON.stringify({ name: 'a', dependencies: { react: '19' } }));
    const m2 = await repoMap(root);
    expect([m2.cached, m2.frameworks]).toEqual([false, ['React']]);
    expect((await repoMap(root, { refresh: true })).cached).toBe(false);
    expect(fs.readdirSync(path.join(process.env.SMART_CODEX_HOME!, 'repomap'))).toHaveLength(1); // stored outside the repo
  });
  it('large repositories: 150k paths map quickly with bounded output', () => {
    const files: string[] = [];
    for (let i = 0; i < 150_000; i++) files.push(`src/mod${i % 300}/sub${i % 7}/file${i}.ts`);
    const t0 = Date.now();
    const m = buildMap(root, files, false, 'x');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(m.stats.files).toBe(150_000);
    expect(m.modules.length).toBeLessThanOrEqual(15);
    expect(m.directories.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(m).length).toBeLessThan(10_000);
  });
});
