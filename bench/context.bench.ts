/**
 * Smart context benchmark: the same task on identical fresh fixture repos, run through the real Codex App Server,
 * A = retrieval disabled (prompt as typed), B = retrieval enabled (smart context hints prepended). Same model and effort for both.
 * Each fixture holds only its own scenario's bug, so "tests pass" means the task was done (and nothing else needed).
 * Tokens are the provider-reported usage of the turn (not prompt length). Uses your Codex subscription quota.
 *
 *   npx tsx bench/context.bench.ts [--scenarios 1,2,3,4] [--repeat 2]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema } from '../src/smart-codex/config.js';
import { loadCatalog } from '../src/smart-codex/models.js';
import { route } from '../src/smart-codex/router.js';
import { Chat, TokenBreakdown } from '../src/lumina/tui/chat.js';
import { AppServerClient } from '../src/lumina/appserver/client.js';
import { Retriever } from '../src/lumina/retrieval.js';
import { filesRead } from '../src/lumina/metrics.js';

interface Scenario { id: number; name: string; task: string; relevant: string[] }
export const SCENARIOS: Scenario[] = [
  { id: 1, name: 'single-file fix', task: 'The order total ignores the discount percentage. Fix it so the tests pass.', relevant: ['src/orders/orderService.js'] },
  { id: 2, name: 'multi-file change', task: 'Add an optional status filter to the order list: listOrders should accept a status and the orders HTTP handler should read it from the ?status= query parameter. Keep the tests passing.', relevant: ['src/orders/orderService.js', 'src/orders/orderHandler.js'] },
  { id: 3, name: 'similar module names', task: 'Reordering a past purchase loses the item quantities (always 1). Fix the reorder logic so the tests pass.', relevant: ['src/reorder/reorderService.js'] },
  { id: 4, name: 'trivial, file named', task: 'Rename the function formatPrice to formatMoney in src/lib/money.js and update all usages; keep the tests passing.', relevant: ['src/lib/money.js'] },
];
const MODULES = ['users', 'products', 'inventory', 'payments', 'shipping', 'invoices', 'reviews', 'coupons', 'notifications', 'analytics', 'wishlist', 'cart'];

export function fixture(scenario: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-ctx-bench-'));
  const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); };
  w('package.json', JSON.stringify({ name: 'shop-api', type: 'module', scripts: { test: 'node --test' } }, null, 2));
  w('src/lib/money.js', "export function formatPrice(cents) {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n");
  w('src/lib/http.js', 'export function json(res, status, body) {\n  return { status, body };\n}\n');
  for (const m of MODULES) {
    const C = m[0].toUpperCase() + m.slice(1);
    w(`src/${m}/${m}Service.js`, `const store = [];\nexport function list${C}() {\n  return store.slice();\n}\nexport function add${C}(x) {\n  store.push(x);\n  return x;\n}\n`);
    w(`src/${m}/${m}Handler.js`, `import { json } from '../lib/http.js';\nimport { list${C} } from './${m}Service.js';\nexport function handleList${C}(req) {\n  return json(null, 200, list${C}());\n}\n`);
    w(`test/${m}.test.js`, `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add${C}, list${C} } from '../src/${m}/${m}Service.js';\ntest('${m}', () => { add${C}({ id: 1 }); assert.equal(list${C}().length, 1); });\n`);
  }
  w('src/orders/orderService.js', `import { formatPrice } from '../lib/money.js';\nconst orders = [\n  { id: 1, status: 'paid', items: [{ price: 1000, qty: 2 }], discount: 10 },\n  { id: 2, status: 'pending', items: [{ price: 500, qty: 1 }], discount: 0 },\n];\nexport function listOrders() {\n  return orders.slice();\n}\nexport function orderTotal(order) {\n  return order.items.reduce((s, i) => s + i.price * i.qty, 0)${scenario === 1 ? '' : ' * (1 - order.discount / 100)'};\n}\nexport function describeOrder(order) {\n  return \`#\${order.id} \${formatPrice(orderTotal(order))}\`;\n}\n`);
  w('src/orders/orderHandler.js', "import { json } from '../lib/http.js';\nimport { listOrders } from './orderService.js';\nexport function handleListOrders(req) {\n  return json(null, 200, listOrders());\n}\n");
  w('test/orders.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { listOrders, orderTotal } from '../src/orders/orderService.js';\ntest('total applies discount', () => assert.equal(orderTotal(listOrders()[0]), 1800));\ntest('lists orders', () => assert.equal(listOrders().length, 2));\n");
  w('src/reorder/reorderService.js', `export function reorder(pastOrder) {\n  return { items: pastOrder.items.map((i) => ({ price: i.price, qty: ${scenario === 3 ? '1' : 'i.qty'} })) };\n}\n`);
  w('test/reorder.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { reorder } from '../src/reorder/reorderService.js';\ntest('keeps quantities', () => assert.equal(reorder({ items: [{ price: 1, qty: 3 }] }).items[0].qty, 3));\n");
  w('test/money.test.js', "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport * as money from '../src/lib/money.js';\ntest('formats', () => assert.equal((money.formatMoney ?? money.formatPrice)(1234), '$12.34'));\n");
  w('README.md', '# shop-api\n\nSmall order management API used for benchmarks.\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  return dir;
}

interface Run { scenario: number; variant: 'A' | 'B'; usage?: TokenBreakdown; ms: number; retrievalMs: number; hintFiles: string[]; relevantFound: number; inspected: string[]; unnecessary: string[]; commands: number; status: string; testsPass: boolean }

async function runOne(s: Scenario, variant: Run['variant']): Promise<Run> {
  const dir = fixture(s.id);
  const cfg = ConfigSchema.parse({ analytics: { enabled: false } });
  const rt = route({ task: s.task, repository: dir }, cfg, loadCatalog());
  const sel = { model: rt.model, effort: rt.reasoning_effort };
  const client = new AppServerClient({ cwd: dir });
  await client.start();
  const chat = new Chat(client, { cwd: dir, onDelta: () => undefined, policy: { approvalPolicy: 'never', sandbox: 'workspace-write' } });
  try {
    const t0 = Date.now();
    let hintFiles: string[] = [];
    let retrievalMs = 0;
    if (variant === 'B') {
      process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-ctx-home-'));
      const r = await new Retriever(dir, cfg.retrieval).retrieve(s.task);
      retrievalMs = r.ms;
      if (r.block) { chat.queueContext(r.block); hintFiles = r.hints.map((h) => h.path); }
    }
    const res = await chat.send(s.task, sel);
    const ms = Date.now() - t0;
    const files = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).split('\n').filter((f) => f.startsWith('src/'));
    const cmds = (res.items ?? []).filter((i) => i.type === 'commandExecution').map((i) => i.command ?? '');
    // files Codex reported reading (commandActions), plus files named in other commands (an approximation, e.g. rg/grep)
    const reported = filesRead(res.items ?? [], fs.realpathSync(dir));
    const inspected = files.filter((f) => reported.includes(f) || cmds.some((c) => c.includes(f) || c.includes(path.basename(f))));
    let testsPass = false;
    try { execFileSync('node', ['--test'], { cwd: dir, stdio: 'ignore', timeout: 60000 }); testsPass = true; } catch { /* failed */ }
    return { scenario: s.id, variant, usage: res.usage, ms, retrievalMs, hintFiles, relevantFound: s.relevant.filter((f) => hintFiles.includes(f)).length, inspected, unnecessary: inspected.filter((f) => !s.relevant.includes(f)), commands: cmds.length, status: res.status, testsPass };
  } finally { await client.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function main(): Promise<void> {
if (process.env.LUMINA_BENCH_DRY) {
  const { ConfigSchema: C } = await import('../src/smart-codex/config.js');
  for (const s of SCENARIOS) { const dir = fixture(s.id); const r = await new Retriever(dir, C.parse({}).retrieval).retrieve(s.task); console.log(s.id, r.skipped ?? '', r.ms + 'ms\n' + (r.block ?? '')); fs.rmSync(dir, { recursive: true, force: true }); }
  return;
}
const args = process.argv.slice(2);
const pick = (flag: string, d: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : d; };
const ids = pick('--scenarios', '1,2,3,4').split(',').map(Number);
const repeat = Number(pick('--repeat', '1'));
const runs: Run[] = [];
for (let k = 0; k < repeat; k++) for (const s of SCENARIOS.filter((x) => ids.includes(x.id))) for (const v of ['A', 'B'] as const) {
  process.stderr.write(`scenario ${s.id} (${s.name}) · ${v} · run ${k + 1}…\n`);
  runs.push(await runOne(s, v));
}
const rows = runs.map((r) => {
  const s = SCENARIOS.find((x) => x.id === r.scenario)!;
  const tok = r.usage ? `${r.usage.inputTokens} / ${r.usage.cachedInputTokens} / ${r.usage.outputTokens}` : 'not reported';
  return `| ${r.scenario}. ${s.name} | ${r.variant} | ${tok} | ${Math.round(r.ms / 1000)}s | ${r.retrievalMs}ms | ${r.variant === 'B' ? `${r.relevantFound}/${s.relevant.length} (${r.hintFiles.length} hinted)` : '-'} | ${r.commands} | ${r.inspected.length} | ${r.unnecessary.length} | ${r.status}, tests ${r.testsPass ? 'pass' : 'FAIL'} |`;
});
console.log(['| scenario | variant | tokens in / cached / out | time | retrieval | relevant hinted | commands | files inspected | unnecessary | result |', '|---|---|---|---|---|---|---|---|---|---|', ...rows].join('\n'));
const file = path.join('bench', 'results', `context-real-${ids.join('_')}-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(file, JSON.stringify({ date: new Date().toISOString(), runs }, null, 2));
console.log(`\nwritten: ${file}`);
}
if (!process.env.LUMINA_BENCH_IMPORT) await main();
