import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLuminaMcpServer } from '../../src/lumina/mcp/mcp_server.js';

type Result = { isError?: boolean; content: { type: string; text: string }[] };
let client: Client;
const call = async (name: string, args: Record<string, unknown>): Promise<Result> => {
  try { return (await client.callTool({ name, arguments: args })) as Result; } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e) }] }; }
};

beforeAll(async () => {
  process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-mcp-'));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createLuminaMcpServer().connect(a);
  client = new Client({ name: 't', version: '0' });
  await client.connect(b);
});
afterAll(async () => { await client.close(); });

describe('router MCP tools', () => {
  it('are discoverable with valid schemas alongside existing tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['route_task', 'explain_route', 'get_router_config', 'get_router_stats', 'execute_mysql_query', 'search_code']));
    const rt = tools.find((t) => t.name === 'route_task')!;
    expect(rt.inputSchema.required).toContain('task');
    expect(rt.description).toMatch(/\bUse before\b/);
  });
  it('route_task returns valid, complete JSON', async () => {
    const res = await call('route_task', { task: 'Fix payment webhook signature verification', repository: os.tmpdir() });
    expect(res.isError).toBeFalsy();
    const out = JSON.parse(res.content[0].text);
    expect(out).toMatchObject({ tier: 'critical', risk: 'high', agent_strategy: expect.any(String), escalation_allowed: true });
    for (const k of ['model', 'reasoning_effort', 'complexity_score', 'confidence', 'relevant_files', 'require_review', 'reason']) expect(out).toHaveProperty(k);
  });
  it('honors preferences and reports errors without throwing the server', async () => {
    const ok = JSON.parse((await call('route_task', { task: 'update button text', repository: os.tmpdir(), preferences: { tier: 'hard' } })).content[0].text);
    expect(ok.tier).toBe('hard');
    expect((await call('route_task', { task: '' })).isError).toBe(true);
    expect((await call('route_task', { task: 'x', preferences: { tier: 'bogus' } })).isError).toBe(true);
    const bad = await call('route_task', { task: 'x', repository: os.tmpdir(), preferences: { model: 'not-a-model' } });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/Unsupported model|Invalid/);
    expect((await call('route_task', { task: 'update button text', repository: os.tmpdir() })).isError).toBeFalsy();
  });
  it('explain_route, get_router_config, get_router_stats work without an LLM', async () => {
    expect((await call('explain_route', { task: 'update button text', repository: os.tmpdir() })).content[0].text).toMatch(/^Tier fast/);
    expect(JSON.parse((await call('get_router_config', {})).content[0].text)).toHaveProperty('routing.max_attempts', 3);
    expect(JSON.parse((await call('get_router_stats', {})).content[0].text)).toMatchObject({ total_tasks: 0, token_usage: 'unavailable' });
  });
  it('route_task does not persist the task text', async () => {
    await call('route_task', { task: 'update button text SECRET-ABC', repository: os.tmpdir() });
    const dir = process.env.SMART_CODEX_HOME!;
    const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    expect(all).not.toContain('SECRET-ABC');
  });
});
