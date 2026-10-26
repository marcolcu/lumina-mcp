import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DependencyGraph, formatGraph, mask, parseGo, parseTs } from '../../src/lumina/graph.js';

let root: string;
const w = (f: string, c = '') => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
const build = () => new DependencyGraph(root).update();
const targets = (g: DependencyGraph, f: string) => (g.deps.get(f) ?? []).map((e) => `${e.to}:${e.kind}`).sort();

beforeEach(() => {
  process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-ghome-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-g-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
});

describe('parsing (static, evidence-based)', () => {
  it('TypeScript: named, default, namespace, type, side-effect, re-export, require, dynamic imports; exports; comments/strings ignored', () => {
    const src = [
      "import Def, { A, B as Bee, type C } from './a';",
      "import * as ns from './ns';",
      "import type { T } from './types';",
      "import './polyfill';",
      "export { X, Y as Z } from './x';",
      "export * from './all';",
      "const { r1, r2: rr } = require('./req');",
      "const lazy = await import('./lazy');",
      'const dyn = await import(modName);',
      "// import { Fake } from './commented';",
      "const s = \"import { InString } from './str'\";",
      "const t = `import x from './tpl' ${ns.helper(`nested ${A}`)}`;",
      'export class OrderService { run() { return Bee(A); } }',
      'export const make = (o = {}) => { return ns.helper(o); };',
      'export default function main() {}',
    ].join('\n');
    const f = parseTs(src);
    expect(f.imports.map((i) => `${i.kind}:${i.spec}`)).toEqual(['static:./a', 'static:./ns', 'type:./types', 'side-effect:./polyfill', 'reexport:./x', 'reexport:./all', 'require:./req', 'dynamic:./lazy']);
    expect(f.imports[0].names).toEqual([{ imported: 'default', local: 'Def' }, { imported: 'A', local: 'A' }, { imported: 'B', local: 'Bee' }, { imported: 'C', local: 'C' }]);
    expect(f.imports[1].ns).toBe('ns');
    expect(f.imports[6].names).toEqual([{ imported: 'r1', local: 'r1' }, { imported: 'r2', local: 'rr' }]);
    expect(f.dynamicUnresolved).toBe(1);
    expect(f.decls.filter((d) => d.exported).map((d) => `${d.kind}:${d.name}`)).toEqual(['class:OrderService', 'const:make', 'function:main']);
    expect(f.decls.find((d) => d.name === 'make')).toMatchObject({ start: 14, end: 14 });
    expect(f.uses['ns.helper']).toEqual([12, 14]); // in the template expression and in make, not in comments
    expect(f.uses.InString).toBeUndefined();
    expect(f.partial).toBeUndefined();
  });
  it('Go: package, grouped/aliased imports, funcs, methods, grouped types and consts', () => {
    const f = parseGo(['package service', '', 'import (', '\t"context"', '\trepo "example.com/app/internal/repository"', '\t"example.com/app/internal/validator"', ')', '', '// OrderService handles orders', 'type OrderService struct {', '\tRepo repo.OrderRepository', '}', '', 'func (s *OrderService) Create(ctx context.Context) error {', '\treturn validator.Validate(s.Repo.Find(ctx))', '}', '', 'func NewOrderService() *OrderService { return &OrderService{} }', '', 'const (', '\tMaxItems = 10', '\tminItems = 1', ')', 'var s = "func Fake() {}"'].join('\n'));
    expect(f.pkg).toBe('service');
    expect(f.imports.map((i) => `${i.ns}=${i.spec}`)).toEqual(['context=context', 'repo=example.com/app/internal/repository', 'validator=example.com/app/internal/validator']);
    expect(f.decls.map((d) => `${d.name}:${d.kind}:${d.exported}`)).toEqual(['OrderService:type:true', 'OrderService.Create:method:true', 'NewOrderService:func:true', 'MaxItems:const:true', 'minItems:const:false', 's:var:false']);
    expect(f.uses['validator.Validate']).toEqual([15]);
    expect(f.uses['repo.OrderRepository']).toEqual([11]);
  });
  it('invalid syntax degrades: partial flag, no throw', () => {
    expect(parseTs("import { A } from './a';\nexport function broken( {\n  const x = 'unterminated\n").partial).toBe(true);
    expect(parseGo('package x\nfunc Broken( {\n').partial).toBe(true);
    expect(mask('a /* never closed', 'ts').balanced).toBe(false);
  });
});

describe('repository graph', () => {
  const goRepo = () => {
    w('go.mod', 'module example.com/app\n\ngo 1.22\n');
    w('internal/repository/order.go', 'package repository\n\ntype OrderRepository struct{}\n\nfunc (r *OrderRepository) Find() error { return nil }\n');
    w('internal/validator/validator.go', 'package validator\n\nfunc Validate(err error) error { return err }\n');
    w('internal/service/order.go', 'package service\n\nimport (\n\t"github.com/gofiber/fiber/v2"\n\t"example.com/app/internal/repository"\n\t"example.com/app/internal/validator"\n)\n\ntype OrderService struct {\n\tRepo *repository.OrderRepository\n}\n\nfunc (s *OrderService) Create() error {\n\tvar _ fiber.Ctx\n\treturn validator.Validate(s.Repo.Find())\n}\n');
    w('internal/service/helpers.go', 'package service\n\nfunc NewOrderService() *OrderService { return &OrderService{} }\n');
    w('internal/handler/order.go', 'package handler\n\nimport "example.com/app/internal/service"\n\ntype OrderHandler struct{ svc *service.OrderService }\n\nfunc (h *OrderHandler) Post() error { return h.svc.Create() }\n');
    w('cmd/api/main.go', 'package main\n\nimport (\n\t"example.com/app/internal/handler"\n\t"example.com/app/internal/missing"\n)\n\nfunc main() { _ = handler.OrderHandler{} }\n');
  };
  it('Go: package imports resolved through go.mod, external packages kept apart, missing packages reported', async () => {
    goRepo();
    const g = await build();
    expect(targets(g, 'internal/service/order.go')).toEqual(['internal/repository/:package', 'internal/validator/:package']);
    expect([...g.external.get('internal/service/order.go')!]).toEqual(['github.com/gofiber/fiber/v2']);
    expect(g.unresolved).toEqual([{ from: 'cmd/api/main.go', spec: 'example.com/app/internal/missing', line: 5, reason: 'no Go files in that package directory' }]);
    const t = formatGraph(g, 'OrderService');
    expect(t).toMatch(/^OrderService {2}\(type, exported · internal\/service\/order\.go:9\)\n├── Depends on\n│ {3}└── repository\.OrderRepository {2}internal\/repository\/ {2}\(L10\)\n└── Used by\n/);
    expect(t).toMatch(/OrderHandler {2}internal\/handler\/order\.go:5 {2}\(service\.OrderService \(package import L3\)\)/);
    expect(t).toMatch(/NewOrderService {2}internal\/service\/helpers\.go:3 {2}\(same-package reference\)/);
    const m = formatGraph(g, 'OrderService.Create');
    expect(m).toContain('validator.Validate  internal/validator/  (L15)');
    expect(m).toMatch(/Used by\n {4}└── no references found/); // h.svc.Create() is a method call through a field: not claimed
    expect(formatGraph(g, 'internal/handler/order.go')).toMatch(/Depends on\n│ {3}└── internal\/service\/ {2}\(package, L3\)\n├── Used by\n│ {3}└── cmd\/api\/main\.go {2}\(imports the package, L4\)/);
  });
  it('TypeScript: OrderService example — depends on / used by with enclosing symbols; tsconfig paths', async () => {
    w('tsconfig.json', '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] }, }, }');
    w('src/orders/repository.ts', 'export class OrderRepository {}\n');
    w('src/orders/validator.ts', 'export function OrderValidator() {}\n');
    w('src/orders/service.ts', "import { OrderRepository } from './repository';\nimport { OrderValidator } from '@/orders/validator';\nimport { unrelated } from './missing';\n\nexport class OrderService {\n  repo = new OrderRepository();\n  check() { return OrderValidator(); }\n}\n");
    w('src/http/handler.ts', "import { OrderService } from '../orders/service';\n\nexport function OrderHandler() {\n  return new OrderService();\n}\n");
    w('src/http/controller.ts', "import * as orders from '@/orders/service';\n\nexport class OrderController {\n  svc = new orders.OrderService();\n}\n");
    const g = await build();
    expect(formatGraph(g, 'OrderService')).toBe([
      'OrderService  (class, exported · src/orders/service.ts:5)',
      '├── Depends on',
      '│   ├── OrderRepository  src/orders/repository.ts  (L6)',
      '│   └── OrderValidator  src/orders/validator.ts  (L7)',
      '└── Used by',
      '    ├── OrderController  src/http/controller.ts:4  (orders.OrderService (namespace import L1))',
      '    └── OrderHandler  src/http/handler.ts:4  (imports OrderService (L1))',
    ].join('\n'));
    const file = formatGraph(g, 'src/orders/service.ts');
    expect(file).toContain("unresolved './missing' (L3): module not found in the repository");
    expect(file).toMatch(/Used by\n│ {3}├── src\/http\/controller\.ts {2}\(static, L1\)\n│ {3}└── src\/http\/handler\.ts {2}\(static, L1\)/);
  });
  it('circular dependencies are reported with the cycle path (TS files and Go packages)', async () => {
    w('src/a.ts', "import { b } from './b';\nexport const a = () => b();\n");
    w('src/b.ts', "import { c } from './c';\nexport const b = () => c();\n");
    w('src/c.ts', "import { a } from './a';\nimport type { T } from './d';\nexport const c = () => a();\n");
    w('src/d.ts', "import { a } from './a';\nexport type T = number;\n");
    const g = await build();
    expect(g.cycle('src/a.ts')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.ts']);
    expect(g.cycle('src/d.ts')).toBeUndefined(); // reached only through a type-only import
    expect(formatGraph(g, 'src/b.ts')).toContain('import cycle: src/b.ts → src/c.ts → src/a.ts → src/b.ts');
  });
  it('monorepo: workspace packages by name (exports/main → src), several Go modules', async () => {
    w('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*', 'apps/*'] }));
    w('packages/ui/package.json', JSON.stringify({ name: '@acme/ui', main: 'dist/index.js' }));
    w('packages/ui/src/index.ts', "export { Button } from './button';\n");
    w('packages/ui/src/button.ts', 'export function Button() {}\n');
    w('apps/web/package.json', JSON.stringify({ name: 'web' }));
    w('apps/web/src/page.tsx', "import { Button } from '@acme/ui';\nimport { cn } from '@acme/ui/button';\nimport React from 'react';\nexport function Page() { return Button(); }\n");
    w('services/billing/go.mod', 'module acme.dev/billing\n');
    w('services/billing/pkg/invoice/invoice.go', 'package invoice\n\nfunc Total() int { return 1 }\n');
    w('services/billing/cmd/main.go', 'package main\n\nimport "acme.dev/billing/pkg/invoice"\n\nfunc main() { invoice.Total() }\n');
    const g = await build();
    expect(targets(g, 'apps/web/src/page.tsx')).toEqual(['packages/ui/src/button.ts:static', 'packages/ui/src/index.ts:static']);
    expect([...g.external.get('apps/web/src/page.tsx')!]).toEqual(['react']);
    expect(targets(g, 'services/billing/cmd/main.go')).toEqual(['services/billing/pkg/invoice/:package']);
    expect(formatGraph(g, 'Button')).toMatch(/Used by\n {4}├── Page {2}apps\/web\/src\/page\.tsx:4 {2}\(imports Button \(L1\) via a re-export\)\n {4}└── \(top level\) {2}packages\/ui\/src\/index\.ts:1 {2}\(re-exports Button from '\.\/button'\)/);
  });
  it('dynamic imports: literal ones are edges, computed ones are counted and not followed', async () => {
    w('src/router.ts', "export async function load(name: string) {\n  await import('./pages/home');\n  return import(`./pages/${name}`);\n}\n");
    w('src/pages/home.ts', 'export default 1;\n');
    const g = await build();
    expect(targets(g, 'src/router.ts')).toEqual(['src/pages/home.ts:dynamic']);
    expect(formatGraph(g, 'src/router.ts')).toContain('1 dynamic import with a computed path (not followed)');
  });
  it('incremental updates: only changed files are re-parsed (also after a restart); deleted files drop out', async () => {
    w('src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    w('src/b.ts', 'export const b = 1;\n');
    w('src/c.ts', 'export const c = 1;\n');
    let g = await build();
    expect([g.stats.parsed, g.stats.reused]).toEqual([3, 0]);
    expect((await g.update()).stats).toMatchObject({ parsed: 0, reused: 3 });
    await new Promise((r) => setTimeout(r, 15));
    w('src/a.ts', "import { c } from './c';\nexport const a = c;\n");
    fs.rmSync(path.join(root, 'src/b.ts'));
    g = await new DependencyGraph(root).update(); // new session: disk cache
    expect(g.stats).toMatchObject({ files: 2, parsed: 1, reused: 1 });
    expect(targets(g, 'src/a.ts')).toEqual(['src/c.ts:static']);
    expect(g.rdeps.get('src/b.ts')).toBeUndefined();
  });
  it('respects .gitignore, generated, secret and dependency files; never reads through symlinks', async () => {
    w('.gitignore', 'ignored/\n');
    w('src/a.ts', "import { x } from '../ignored/x';\nimport { g } from './gen/api.gen';\n");
    w('ignored/x.ts', 'export const x = 1;\n');
    w('src/gen/api.gen.ts', 'export const g = 1;\n');
    w('node_modules/lib/index.js', 'module.exports = 1;\n');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-gout-'));
    fs.writeFileSync(path.join(outside, 'secret.ts'), "import { s } from '/etc/passwd';\nexport const stolen = 1;\n");
    fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(root, 'src/link.ts'));
    const g = await build();
    expect([...g.files.keys()].sort()).toEqual(['src/a.ts', 'src/link.ts']);
    expect(g.files.get('src/link.ts')!.skipped).toBe('symlink');
    expect(g.findSymbol('stolen')).toEqual([]);
    expect(g.unresolved.map((u) => u.spec).sort()).toEqual(['../ignored/x', './gen/api.gen']);
  });
  it('large repositories: thousands of files, bounded and fast; unknown queries degrade clearly', async () => {
    for (let m = 0; m < 20; m++) for (let i = 0; i < 100; i++) w(`src/m${m}/f${i}.ts`, `import { v${(i + 1) % 100} } from './f${(i + 1) % 100}';\nexport const v${i} = ${i};\n`);
    const t0 = Date.now();
    const g = await build();
    expect(g.stats.files).toBe(2000);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(formatGraph(g, 'src/m3/f5.ts')).toMatch(/Depends on\n│ {3}└── src\/m3\/f6\.ts/);
    expect(formatGraph(g, 'NoSuchThing')).toMatch(/No file or symbol "NoSuchThing"/);
    expect(formatGraph(g, "f1.ts")).toMatch(/matches 20 files/);
    const t1 = Date.now();
    await g.update();
    expect(Date.now() - t1).toBeLessThan(Date.now() - t0 + 1);
    expect(g.stats.parsed).toBe(0);
  }, 60000);
});
