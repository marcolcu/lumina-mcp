import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { route } from '../../src/smart-codex/router.js';
import { Diagnostic, DiagnosticsHistory, categorize, commandName, formatDiagnostics, formatWhy, sanitize } from '../../src/lumina/diagnostics.js';
import type { Verification, Check } from '../../src/lumina/verify.js';

const CAT = [{ slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high'] }, { slug: 'gpt-6-sol', efforts: ['low', 'medium', 'high'] }];
const cfg = ConfigSchema.parse({ models: { fast: 'gpt-6-luna', normal: 'gpt-6-luna', hard: 'gpt-6-sol', critical: 'gpt-6-sol' }, optimization: { minimal_context: false } });
const check = (label: string, command: string): Check => ({ kind: 'related', label, argv: command.split(' '), command, forms: [] });
const verification = (failed: boolean): Verification => ({
  level: 'standard', reason: 'security-sensitive code', stack: 'TypeScript', skipped: [],
  impact: { changes: [], modules: [], tests: [], packages: [], importers: 0, importerFiles: [], reasons: [], flags: { critical: true, migration: false, shared: false, deps: false, config: false, docsOnly: false, testsOnly: false } },
  results: [{ check: check('TypeScript', 'npm run typecheck'), status: 'passed', source: 'codex', ms: 900, exitCode: 0 }, { check: check('2 relevant test files', 'npm test -- a.test.ts'), status: failed ? 'failed' : 'passed', source: 'ran', ms: 1200, exitCode: failed ? 1 : 0, failure: failed ? 'test failure' : undefined }],
});

beforeEach(() => { process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-diaghome-')); });

describe('routing explanation (/why) uses the recorded decision', () => {
  it('shows the router\'s own reasons, model, effort, strategy and stages', () => {
    const r = route({ task: 'Update the authentication middleware to verify JWT signatures', repository: '/nonexistent' }, cfg, CAT);
    const d = new Diagnostic('critical task (high risk)');
    d.routed(r, { model: r.model, effort: r.reasoning_effort }, 'automatic routing', 'direct');
    d.stage({ type: 'task', title: 'Execute request', model: r.model, effort: r.reasoning_effort, status: 'done' });
    const t = formatWhy(d.rec, (m) => (m === 'gpt-6-sol' ? 'GPT-6 Sol' : m));
    expect(t).toMatch(/^Routing Decision\n\nTask: critical task \(high risk\)\nClassification: critical · complexity \d+\/10/);
    expect(t).toContain('Model: GPT-6 Sol');
    expect(t).toContain(`Reasoning: ${r.reasoning_effort[0].toUpperCase()}${r.reasoning_effort.slice(1)}`);
    for (const reason of r.reason.split('; ')) expect(t).toContain(`- ${reason}`); // exactly the router's recorded reasons
    expect(t).toMatch(/Strategy: Direct\nStages: 1/);
    expect(formatWhy(undefined)).toContain('No request has been routed');
  });
});

describe('execution trace', () => {
  it('multi-stage trace with escalation and switch, correlated stage-engine events, tool events by name only', () => {
    const d = new Diagnostic('t');
    d.event('execution_started');
    d.fromLog({ level: 'info', event: 'stage_started', request_id: d.id, execution_id: 'x', routing_strategy: 'adaptive', stage_type: 'task', selected_model: 'gpt-6-luna' });
    d.onServerEvent('item/completed', { item: { type: 'commandExecution', command: "/bin/zsh -lc 'curl -H \"Authorization: Bearer abcdefghijklmnop123\" https://x'", exitCode: 0, status: 'completed' } });
    d.onServerEvent('item/completed', { item: { type: 'commandExecution', command: 'npm test', exitCode: 1, status: 'failed' } });
    d.onServerEvent('item/completed', { item: { type: 'fileChange', changes: [{}, {}], status: 'completed' } });
    d.fromLog({ level: 'warn', event: 'escalated', request_id: d.id, execution_id: 'x', routing_strategy: 'adaptive', selected_model: 'gpt-6-sol', routing_reason: 'tests still failing after previous stage', escalation_level: 1 });
    d.fromLog({ level: 'info', event: 'model_switched', request_id: d.id, execution_id: 'x', routing_strategy: 'adaptive', previous_model: 'gpt-6-luna', selected_model: 'gpt-6-sol', routing_reason: 'tests still failing' });
    d.stage({ type: 'task', title: 'Execute request', model: 'gpt-6-luna', status: 'done', ms: 2000 });
    d.stage({ type: 'fix', title: 'Fix failing checks', model: 'gpt-6-sol', status: 'done', ms: 3000, escalation: 1 });
    const r = d.finish('completed', { usage: { totalTokens: 1300, inputTokens: 1000, cachedInputTokens: 800, outputTokens: 300 } });
    expect(r.trace.map((e) => e.type)).toEqual(['request_received', 'execution_started', 'stage_started', 'tool_executed', 'tool_executed', 'files_changed', 'model_escalated', 'model_switched', 'execution_completed']);
    expect([r.switches, r.escalations, r.tools]).toEqual([1, 1, { commands: 2, failedCommands: 1, fileChanges: 2, mcp: 0, approvals: 0, declined: 0, repeatedTests: 0 }]);
    expect(JSON.stringify(r)).not.toMatch(/abcdefghijklmnop123|Authorization|https:\/\/x/);
    expect(r.trace[3]).toMatchObject({ type: 'tool_executed', tool: 'curl' });
    const t = formatDiagnostics(r, undefined, true);
    expect(t).toContain('Input tokens: 1,000 · Cached: 800 · Output: 300 (provider-reported)');
    expect(t).toMatch(/Trace \(9 events\):\n {2}\+ *\d+ms request_received/);
  });
  it('large traces stay bounded: first events kept, the newest kept, dropped ones counted', () => {
    const d = new Diagnostic('t', 50);
    for (let i = 0; i < 5000; i++) d.event('tool_executed', { i });
    const r = d.finish('completed');
    expect(r.trace.length).toBe(50);
    expect(r.droppedEvents).toBe(4952); // 5002 events, 50 kept
    expect(r.trace[0].type).toBe('request_received');
    expect(r.trace.at(-1)!.type).toBe('execution_completed');
    expect(r.trace.at(-2)!.i).toBe(4999);
  });
});

describe('verification, self-healing and failures', () => {
  it('verification and self-healing diagnostics; a repaired request is completed', () => {
    const d = new Diagnostic('t');
    d.verified(verification(true), ['npm test -- a.test.ts']);
    d.healed({ status: 'repaired', attempts: 1, escalations: 0, models: ['gpt-6-luna'], reason: 'verification passed', classes: [] });
    d.verified(verification(false));
    const r = d.finish('completed');
    expect(r.status).toBe('completed');
    const t = formatDiagnostics(r);
    expect(t).toMatch(/Verification:\n {2}Level: Standard \(security-sensitive code\)\n {2}3 passed \(2 reused\) · 1 failed · 0 skipped/);
    expect(t).toMatch(/Self-Healing:\n {2}1 repair attempt · repaired · gpt-6-luna/);
    expect(t).toContain('1 verification check(s) re-ran a command Codex had already run');
  });
  it('unresolved verification makes the request failed with an actionable application diagnosis', () => {
    const d = new Diagnostic('t');
    d.stage({ type: 'task', title: 'Execute request', status: 'done' });
    d.verified(verification(true));
    d.healed({ status: 'exhausted', attempts: 2, escalations: 1, models: ['gpt-6-luna', 'gpt-6-sol'], reason: '2 attempts used', classes: [{ check: '2 relevant test files', cls: 'CODE_FAILURE', reason: '' }] });
    const r = d.finish('completed');
    expect(r.status).toBe('failed');
    expect(r.failure).toMatchObject({ category: 'application', operation: 'verification', lastStage: 'Execute request', unresolved: ['2 relevant test files: test failure'] });
    expect(r.insights).toContain('2 repair attempts without a passing result');
    expect(formatDiagnostics(r)).toMatch(/Failure:\n {2}Category: application\n {2}Failed operation: verification[\s\S]*Repair attempts: 2[\s\S]*Next steps:\n {4}- Review the failing checks/);
  });
  it.each([
    ['The model gpt-9 is not supported for your account', 'model unavailable'],
    ['context_length_exceeded: prompt is too long', 'context'],
    ['Not logged in. Please log in.', 'permission'],
    ['sandbox denied: operation not permitted', 'permission'],
    ['429 Too Many Requests: usage limit', 'model unavailable'],
    ['getaddrinfo ENOTFOUND api.openai.com', 'environment'],
    ['MCP tool call failed: server crashed', 'tool'],
    ['something odd happened', 'application'],
  ])('failure category: %s → %s', (error, cat) => {
    expect(categorize(error, { status: 'failed', tools: { commands: 0, failedCommands: 0, fileChanges: 0, mcp: 0, approvals: 0, declined: 0, repeatedTests: 0 } }).category).toBe(cat);
  });
  it('cancellation and environment failures from verification', () => {
    expect(new Diagnostic('t').finish('cancelled').failure?.category).toBe('cancellation');
    const d = new Diagnostic('t');
    d.verified({ ...verification(true), results: [{ check: check('Tests', 'npm test'), status: 'failed', source: 'ran', ms: 1, exitCode: 127, failure: 'missing dependency' }] });
    d.healed({ status: 'skipped', attempts: 0, escalations: 0, models: [], reason: 'no failure this change caused', classes: [{ check: 'Tests', cls: 'ENVIRONMENT_FAILURE', reason: '' }] });
    const r = d.finish('completed');
    expect(r.failure?.category).toBe('environment');
    expect(r.failure?.next[0]).toMatch(/Fix the environment for "Tests"/);
  });
  it('missing metrics are shown as missing, never invented', () => {
    const r = new Diagnostic('t').finish('completed');
    const t = formatDiagnostics(r);
    expect(t).toContain('Tokens: not reported for this request');
    expect(t).not.toMatch(/Routing:|Verification:|Self-Healing:|Input tokens/);
  });
  it('performance insights only from measured events', () => {
    const d = new Diagnostic('t');
    for (const m of ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-luna']) d.stage({ type: 'task', title: 's', model: m, status: 'done' });
    d.rec.compactions = 2;
    for (let i = 0; i < 3; i++) d.onServerEvent('item/completed', { item: { type: 'commandExecution', command: 'npm test', exitCode: 1, status: 'failed' } });
    d.rec.context = { hinted: 3, filesRead: 4, hintsRead: 0 };
    const r = d.finish('completed', { usage: { totalTokens: 0, inputTokens: 300_000, cachedInputTokens: 290_000, outputTokens: 10 } });
    expect(r.insights).toEqual([
      'model switched back and forth (gpt-6-luna → gpt-6-sol → gpt-6-luna): each switch starts without the prompt cache',
      'context compacted 2 times in one request: consider /new for unrelated work',
      'none of the 3 hinted files were read by Codex (it read 4 others)',
      'the same test command ran 3+ times during the turn (1 command)',
      'large conversation history: 290,000 cached input tokens re-read (provider-reported); /new starts fresh',
    ]);
    expect(new Diagnostic('t').finish('completed').insights).toEqual([]);
  });
});

describe('privacy and history', () => {
  it('secrets are redacted from every stored field; command arguments are never kept', () => {
    expect(sanitize('token=ghp_abcdefghijklmnopqrstu and key sk-abcdefghijklmnop123')).not.toMatch(/ghp_|sk-abc/);
    expect(sanitize('postgres://admin:s3cret@db/prod failed')).not.toContain('s3cret');
    expect(sanitize(`${os.homedir()}/work/app`)).toBe('~/work/app');
    expect(commandName("/bin/zsh -lc 'mysql -u root -pS3cretPass db'")).toBe('mysql');
    expect(commandName('npm test -- src/a.test.ts')).toBe('npm test');
    const d = new Diagnostic('password = hunter2hunter2');
    const r = d.finish('failed', { error: 'auth failed for Bearer abcdefghijklmnopqrstuvwx' });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|abcdefghijklmnopqrstuvwx/);
  });
  it('history persists across restarts, newest first, bounded by retention; corrupt lines skipped', () => {
    const h = new DiagnosticsHistory('/repo/a', 3);
    for (let i = 0; i < 10; i++) { const d = new Diagnostic(`req ${i}`); h.append(d.finish('completed')); }
    fs.appendFileSync(h.file, 'not json\n');
    const again = new DiagnosticsHistory('/repo/a', 3); // a new session
    expect(again.list().map((r) => r.title)).toEqual(['req 9', 'req 8']); // the corrupt last line is skipped
    expect(fs.readFileSync(h.file, 'utf8').trim().split('\n').length).toBeLessThanOrEqual(7);
    expect(new DiagnosticsHistory('/repo/b', 3).list()).toEqual([]); // per project
    expect((fs.statSync(h.file).mode & 0o077)).toBe(0);
    const none = new DiagnosticsHistory('/repo/c', 0);
    none.append(new Diagnostic('x').finish('completed'));
    expect(fs.existsSync(none.file)).toBe(false);
  });
});
