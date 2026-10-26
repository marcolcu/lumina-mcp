import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { checkContracts, formatContracts, parseYaml } from '../../src/lumina/apicontract.js';

let root: string;
const w = (f: string, c: string) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
const find = (r: Awaited<ReturnType<typeof checkContracts>>, kind: string, field?: string) => r.findings.filter((f) => f.kind === kind && (field === undefined || f.field === field));

const SPEC = `openapi: 3.0.3
info:
  title: Shop
  version: "1"
servers:
  - url: https://api.example.com/api/v1
security:
  - bearerAuth: []
paths:
  /orders:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Order'
    post:
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateOrder'
      responses:
        "201":
          description: created
  /orders/{id}:
    parameters:
      - in: path
        name: id
        required: true
        schema: { type: string }
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderDetail'
  /articles:
    get:
      security: []
      responses:
        "200":
          description: JSON:API list
          content:
            application/vnd.api+json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items:
                      type: object
                      required: [id, type, attributes]
                      properties:
                        id: { type: string }
                        type: { type: string }
                        attributes:
                          type: object
                          required: [title]
                          properties:
                            title: { type: string }
                            body: { type: string }
components:
  schemas:
    Order:
      type: object
      required: [order_uuid, total]
      properties:
        order_uuid: { type: string }
        total: { type: number }
        note:
          type: string
          nullable: true
    OrderDetail:
      allOf:
        - $ref: '#/components/schemas/Order'
        - type: object
          required: [items]
          properties:
            items:
              type: array
              items: { type: string }
    CreateOrder:
      type: object
      required: [customer_id, items]
      properties:
        customer_id: { type: integer }
        items:
          type: array
          items: { type: string }
`;

beforeEach(() => {
  process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-ahome-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-a-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
});

describe('YAML subset', () => {
  it('parses block maps, sequences of maps, flow collections, quotes and block strings', () => {
    expect(parseYaml('a: 1\nb:\n  - x: "1"\n    y: [1, two]\n  - plain\nc: { d: true, e: null }\nf: |\n  line1\n  line2\n# comment\ng: \'it\'\'s\'\n')).toEqual({ a: 1, b: [{ x: '1', y: [1, 'two'] }, 'plain'], c: { d: true, e: null }, f: 'line1\nline2', g: "it's" });
  });
});

describe('OpenAPI contracts vs frontend consumers', () => {
  const frontend = () => w('src/api/orders.ts', `export interface Order {
  order_id: number;
  total: number;
  note: string;
  discount?: number;
}
export interface OrderDetail { order_uuid: string; total: string; items: string[]; status: string }
export interface Article { id: string; title: string; author: string }
const API_BASE = '/api/v1';

export async function getOrders(): Promise<Order[]> {
  const res = await fetch('/api/v1/orders');
  return res.json();
}
export async function getOrder(id: string): Promise<OrderDetail> {
  const res = await fetch(\`\${API_BASE}/orders/\${id}\`);
  return res.json();
}
export async function createOrder() {
  return fetch('/api/v1/orders', { method: 'POST', body: JSON.stringify({ customer_id: 1, coupon: 'X' }) });
}
export async function cancelOrder(id: string) {
  return fetch(\`/api/v1/orders/\${id}\`, { method: 'DELETE' });
}
export async function invoices() { return fetch('/api/v1/invoices'); }
export async function articles(): Promise<Article[]> { const r = await fetch('/api/v1/articles'); return r.json(); }
export async function ordersV2(): Promise<Order[]> { const r = await fetch('/api/v2/orders'); return r.json(); }
`);
  it('discovers the spec (servers prefix, $ref, allOf, nullable, security) and consumers', async () => {
    w('openapi.yaml', SPEC);
    frontend();
    const r = await checkContracts(root);
    expect(r.sources).toEqual({ openapi: 4, fiber: 0, next: 0 });
    expect(r.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(['GET /api/v1/orders', 'POST /api/v1/orders', 'GET /api/v1/orders/{id}', 'GET /api/v1/articles']);
    expect(r.endpoints[0].auth).toBe('bearerAuth');
    expect(r.endpoints[3].auth).toBeUndefined(); // security: [] overrides the global requirement
    expect(Object.keys(r.endpoints[2].response!.props!)).toEqual(['order_uuid', 'total', 'note', 'items']);
    expect(r.consumers.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/v1/orders', 'GET /api/v1/orders/{id}', 'POST /api/v1/orders', 'DELETE /api/v1/orders/{id}', 'GET /api/v1/invoices', 'GET /api/v1/articles', 'GET /api/v2/orders']);
  });
  it('renamed field (example: order_uuid vs order_id) is a potential mismatch; optional fields are fine; nullable is flagged', async () => {
    w('openapi.yaml', SPEC);
    frontend();
    const r = await checkContracts(root, 'orders');
    const renamed = find(r, 'renamed field', 'order_id');
    expect(renamed[0]).toMatchObject({ status: 'possible', endpoint: 'GET /api/v1/orders', backend: 'order_uuid: string', frontend: 'order_id: number' });
    expect(find(r, 'missing field', 'discount')).toEqual([]);
    expect(find(r, 'nullable field', 'note')[0]).toMatchObject({ status: 'possible' });
    const t = formatContracts(r);
    expect(t).toContain('Endpoint: GET /api/v1/orders\n  Backend:  order_uuid: string\n  Frontend: order_id: number\n  Status: ? Potential contract mismatch — renamed field');
  });
  it('verified mismatches: type change, missing field, incompatible payload, removed endpoint, changed method', async () => {
    w('openapi.yaml', SPEC);
    frontend();
    const r = await checkContracts(root);
    expect(find(r, 'type mismatch', 'total').find((f) => f.endpoint === 'GET /api/v1/orders/{id}')).toMatchObject({ status: 'verified', backend: 'number', frontend: 'string' });
    expect(find(r, 'missing field', 'status')[0]).toMatchObject({ status: 'verified', endpoint: 'GET /api/v1/orders/{id}' });
    expect(find(r, 'request payload', 'items')[0]).toMatchObject({ status: 'verified', detail: 'request body is missing required field items' });
    expect(find(r, 'request payload', 'coupon')[0]).toMatchObject({ status: 'possible' });
    expect(find(r, 'removed endpoint').map((f) => [f.endpoint, f.status])).toEqual([['GET /api/v1/invoices', 'verified']]);
    expect(find(r, 'method changed')[0]).toMatchObject({ endpoint: 'DELETE /api/v1/orders/{id}', status: 'verified', backend: 'GET' });
  });
  it('JSON:API responses are unwrapped (data[].attributes) before comparing; API versions are matched with a warning', async () => {
    w('openapi.yaml', SPEC);
    frontend();
    const r = await checkContracts(root);
    const author = find(r, 'missing field', 'author')[0];
    expect(author).toMatchObject({ endpoint: 'GET /api/v1/articles', status: 'verified' });
    expect(author.detail).toContain('JSON:API resource (data.attributes)');
    expect(find(r, 'missing field', 'title').filter((f) => f.endpoint.includes('articles'))).toEqual([]);
    expect(find(r, 'version mismatch')[0]).toMatchObject({ status: 'possible', backend: 'v1', frontend: 'v2' });
  });
  it('matching contracts produce no findings', async () => {
    const user = { type: 'object', required: ['id', 'email'], properties: { id: { type: 'integer' }, email: { type: 'string' }, name: { type: ['string', 'null'] } } };
    w('openapi.json', JSON.stringify({ openapi: '3.1.0', paths: { '/api/users': { get: { responses: { 200: { content: { 'application/json': { schema: user } } } } } } } }));
    w('src/users.ts', "interface User { id: number; email: string; name?: string | null }\nexport async function me(): Promise<User> { const r = await fetch('/api/users'); return r.json(); }\n");
    const r = await checkContracts(root);
    expect([r.matched, r.findings]).toEqual([1, []]);
    expect(formatContracts(r)).toContain('no mismatches found');
  });
});

describe('code-derived contracts (no OpenAPI)', () => {
  it('Go Fiber: groups with version prefix, auth middleware, handler structs with json tags; axios baseURL consumers', async () => {
    w('go.mod', 'module example.com/app\n');
    w('internal/models/user.go', 'package models\n\ntype Base struct {\n\tID string `json:"id"`\n}\n\ntype User struct {\n\tBase\n\tEmail string `json:"email"`\n\tPhone *string `json:"phone,omitempty"`\n\tsecret string\n\tSkip string `json:"-"`\n}\n');
    w('internal/handler/user.go', 'package handler\n\nfunc (h *Handler) GetUser(c *fiber.Ctx) error {\n\tif c.Params("id") == "" {\n\t\treturn c.Status(fiber.StatusBadRequest).JSON(fiber.Map{"error": "missing id"})\n\t}\n\tuser := models.User{Email: "a@b.c"}\n\treturn c.JSON(user)\n}\n\nfunc (h *Handler) Health(c *fiber.Ctx) error {\n\treturn c.JSON(fiber.Map{"ok": true, "version": "1"})\n}\n');
    w('cmd/api/main.go', 'package main\n\nfunc main() {\n\tapp := fiber.New()\n\tapi := app.Group("/api")\n\tv1 := api.Group("/v1", middleware.JWTProtected())\n\tv1.Get("/users/:id", h.GetUser)\n\tapp.Get("/health", h.Health)\n\tapp.Get(prefix+"/dyn", h.Health)\n}\n');
    w('web/src/lib/api.ts', "import axios from 'axios';\nconst api = axios.create({ baseURL: '/api/v1' });\nexport interface User { id: string; email: string; name: string; phone: string }\nexport const getUser = (id: string) => api.get<User>(`/users/${id}`);\nexport const health = () => api.get<{ ok: boolean; version: number }>('/health');\n");
    const r = await checkContracts(root);
    expect(r.sources.fiber).toBe(2);
    const user = r.endpoints.find((e) => e.path === '/api/v1/users/{id}')!;
    expect([user.auth, Object.keys(user.response!.props!)]).toEqual(['middleware.JWTProtected()', ['id', 'email', 'phone']]);
    expect(find(r, 'missing field', 'name')[0]).toMatchObject({ status: 'verified', endpoint: 'GET /api/v1/users/{id}' });
    expect(find(r, 'nullable field', 'phone')[0]).toMatchObject({ status: 'possible' });
    expect(find(r, 'type mismatch', 'version')[0]).toMatchObject({ status: 'possible', backend: 'string', frontend: 'number' }); // fiber.Map: inferred, so not verified
    expect(r.unsupported).toEqual(['dynamic Fiber route at cmd/api/main.go:9 (path is not a string literal)']);
  });
  it('Next.js app and pages routes; catch-all routes are reported as not analysed; no spec → explicit fallback note', async () => {
    w('app/api/products/[id]/route.ts', "import { NextResponse } from 'next/server';\nexport async function GET() {\n  return NextResponse.json({ id: '1', price: 10, tags: [] });\n}\n");
    w('pages/api/cart.ts', "export default function handler(req, res) {\n  if (req.method === 'POST') return res.status(201).json({ ok: true });\n}\n");
    w('app/api/files/[...path]/route.ts', 'export async function GET() { return Response.json({}); }\n');
    w('src/client.ts', "interface Product { id: string; price: string }\nexport async function product(id: string): Promise<Product> { const r = await fetch(`/api/products/${id}`); return r.json(); }\nexport const cart = () => fetch('/api/cart');\n");
    const r = await checkContracts(root);
    expect(r.endpoints.map((e) => `${e.source}:${e.method} ${e.path}`)).toEqual(['next:GET /api/products/{id}', 'next:POST /api/cart']);
    expect(find(r, 'type mismatch', 'price')[0]).toMatchObject({ status: 'possible', backend: 'number', frontend: 'string' });
    expect(find(r, 'method changed')[0]).toMatchObject({ endpoint: 'GET /api/cart', status: 'verified' });
    expect(r.unsupported).toEqual(['catch-all API route app/api/files/[...path]/route.ts (dynamic path; not compared)']);
    expect(formatContracts(r)).toContain('No OpenAPI specification found');
  });
  it('unknowns are never verified: env base URLs, external hosts, untyped responses; no backend at all', async () => {
    w('src/a.ts', "const api = axios.create({ baseURL: process.env.API_URL });\nexport const x = () => api.get('/things');\nexport const y = () => fetch('https://other.example.com/v1/stuff');\n");
    let r = await checkContracts(root);
    expect(r.findings).toEqual([]);
    expect(formatContracts(r)).toContain('No backend contract found');
    w('openapi.yaml', SPEC);
    w('src/b.ts', "export const z = () => api.get('/orders');\nconst api = axios.create({ baseURL: process.env.API_URL });\n");
    r = await checkContracts(root);
    expect(r.findings.filter((f) => f.status === 'verified')).toEqual([]); // inexact URLs: at most possible
  });
});

describe('Smart Verification integration', () => {
  it('a verified mismatch involving a changed file fails an "API contracts" check (no command run); others do not count', async () => {
    const { Verifier } = await import('../../src/lumina/verify.js');
    const { ConfigSchema } = await import('../../src/smart-codex/config.js');
    w('openapi.yaml', SPEC);
    w('src/api/orders.ts', "export interface OrderDetail { order_uuid: string; total: number; items: string[]; status: string }\nexport async function getOrder(id: string): Promise<OrderDetail> { const r = await fetch(`/api/v1/orders/${id}`); return r.json(); }\n");
    w('src/api/legacy.ts', "export const legacy = () => fetch('/api/v1/gone');\n");
    const cfg = ConfigSchema.parse({}).verification;
    const hooks = { approved: () => true, confirm: async () => true };
    const v = await new Verifier(root, cfg, undefined, () => checkContracts(root)).verify([{ path: 'src/api/orders.ts', kind: 'modified' }], { hooks });
    const api = v.results.find((r) => r.check.kind === 'api')!;
    expect([api.status, api.failure]).toEqual(['failed', 'contract mismatch']);
    expect(api.output).toContain('VERIFIED missing field · GET /api/v1/orders/{id} · status');
    expect(api.output).not.toContain('/api/v1/gone'); // pre-existing, in a file this change did not touch
    const docs = await new Verifier(root, cfg, undefined, () => checkContracts(root)).verify([{ path: 'README.md', kind: 'modified' }], { hooks, mode: 'quick' });
    expect(docs.results.find((r) => r.check.kind === 'api')).toBeUndefined(); // not API-relevant: not run
    w('src/api/orders.ts', "export interface OrderDetail { order_uuid: string; total: number; items: string[] }\nexport async function getOrder(id: string): Promise<OrderDetail> { const r = await fetch(`/api/v1/orders/${id}`); return r.json(); }\n");
    const fixed = await new Verifier(root, cfg, undefined, () => checkContracts(root)).verify([{ path: 'src/api/orders.ts', kind: 'modified' }], { hooks });
    expect(fixed.results.find((r) => r.check.kind === 'api')).toMatchObject({ status: 'passed', note: '4 endpoints · 0 possible mismatches (not verified)' });
  });
});
