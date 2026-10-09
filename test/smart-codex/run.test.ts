import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { ModelInfo } from '../../src/smart-codex/models.js';
import { Route, route } from '../../src/smart-codex/router.js';
import { Runner, classifyFailure, codexRunner, execute, readRuns, stats } from '../../src/smart-codex/run.js';

const cat: ModelInfo[] = [
  { slug: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { slug: 'gpt-6-sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
];
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-empty-'));
const cfg = ConfigSchema.parse({});
const mk = (task: string, c = cfg): Route => route({ task, repository: empty }, c, cat);

beforeEach(() => { process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-')); });

const scripted = (results: { code: number; tail?: string; interrupted?: boolean; usage?: { input_tokens: number; output_tokens: number } }[]) => {
  const prompts: string[] = [];
  const runner: Runner = async (_s, p) => { const r = results[Math.min(prompts.length, results.length - 1)]; prompts.push(p); return { tail: '', interrupted: false, ...r }; };
  return { runner, prompts };
};

describe('failure classification', () => {
  it.each([
    ['Error: not logged in', 'auth'], ['HTTP 429 Too Many Requests', 'rate_limit'], ['getaddrinfo ENOTFOUND x', 'network'],
    ['unknown field `foo` in config', 'config'], ['sh: pnpm: command not found', 'dependency'], ['EACCES: permission denied', 'tool'],
    ['AssertionError: expected 1 to be 2', 'coding'],
  ])('%s -> %s', (tail, kind) => expect(classifyFailure(tail)).toBe(kind));
  it('exit 127 is a dependency problem', () => expect(classifyFailure('', 127)).toBe('dependency'));
});

describe('escalation safety', () => {
  const fastTask = 'update the button text';
  const ctx = (snap: () => string | null) => ({ catalog: cat, snapshot: snap });

  it('never retries success', async () => {
    const { runner, prompts } = scripted([{ code: 0 }]);
    const { record } = await execute(fastTask, mk(fastTask), cfg, runner, 'exec', ctx(() => 'a'));
    expect(prompts).toHaveLength(1);
    expect(record.escalated).toBe(false);
  });

  it.each(['not logged in', 'HTTP 429', 'ECONNRESET', 'command not found', 'EACCES'])('stops with a diagnostic on environment failure (%s)', async (tail) => {
    const { runner, prompts } = scripted([{ code: 1, tail }]);
    const { diagnostic, code } = await execute(fastTask, mk(fastTask), cfg, runner, 'exec', ctx(() => 'a'));
    expect(prompts).toHaveLength(1);
    expect(diagnostic).toMatch(/not a coding error/);
    expect(code).toBe(1);
  });

  it('escalates coding failures when the tree is untouched, with failure context and redaction', async () => {
    const { runner, prompts } = scripted([{ code: 1, tail: 'AssertionError token Bearer abcdefghijkl123' }, { code: 0 }]);
    const { record, code } = await execute(fastTask, mk(fastTask), cfg, runner, 'exec', ctx(() => 'same'));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Previous attempt failed');
    expect(prompts[1]).toContain('AssertionError');
    expect(prompts[1]).not.toContain('abcdefghijkl123');
    expect(record.attempts.map((a) => a.effort)).toEqual(['low', 'medium']);
    expect(code).toBe(0);
  });

  it('refuses to retry a file-modifying task whose attempt changed the working tree', async () => {
    let n = 0;
    const { runner, prompts } = scripted([{ code: 1, tail: 'tests failed' }]);
    const { diagnostic, record } = await execute('implement user CRUD', mk('implement user CRUD'), cfg, runner, 'exec', ctx(() => `tree${n++}`));
    expect(prompts).toHaveLength(1);
    expect(diagnostic).toMatch(/modified the working tree/);
    expect(record.stopped_reason).toBeTruthy();
  });

  it('refuses to retry when the tree cannot be assessed', async () => {
    const { runner, prompts } = scripted([{ code: 1, tail: 'tests failed' }]);
    const { diagnostic } = await execute('implement user CRUD', mk('implement user CRUD'), cfg, runner, 'exec', ctx(() => null));
    expect(prompts).toHaveLength(1);
    expect(diagnostic).toMatch(/could not be assessed/);
  });

  it('opt-in retry after changes tells Codex to continue, not redo', async () => {
    let n = 0;
    const c = ConfigSchema.parse({ escalation: { retry_after_file_changes: true } });
    const { runner, prompts } = scripted([{ code: 1, tail: 'tests failed' }, { code: 0 }]);
    await execute('implement user CRUD', mk('implement user CRUD', c), c, runner, 'exec', ctx(() => `tree${n++}`));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/do not re-apply or duplicate/);
  });

  it('read-only tasks may retry without a tree check', async () => {
    const { runner, prompts } = scripted([{ code: 1, tail: 'oops' }, { code: 0 }]);
    await execute('explain how the router works', mk('explain how the router works'), cfg, runner, 'exec', ctx(() => { throw new Error('should not snapshot'); }));
    expect(prompts).toHaveLength(2);
  });

  it('never retries destructive tasks, bounds attempts, and preserves the last exit code', async () => {
    const d = scripted([{ code: 4, tail: 'x' }]);
    await execute('drop the legacy table', mk('drop the legacy table'), cfg, d.runner, 'exec', ctx(() => 'a'));
    expect(d.prompts).toHaveLength(1);
    const b = scripted([{ code: 1, tail: 'a' }, { code: 1, tail: 'b' }, { code: 7, tail: 'c' }, { code: 9, tail: 'd' }]);
    const out = await execute(fastTask, mk(fastTask), cfg, b.runner, 'exec', ctx(() => 'a'));
    expect(b.prompts).toHaveLength(3);
    expect(out.code).toBe(7);
  });

  it('stops on interruption', async () => {
    const { runner, prompts } = scripted([{ code: 130, interrupted: true }]);
    const { code } = await execute(fastTask, mk(fastTask), cfg, runner, 'exec', ctx(() => 'a'));
    expect(prompts).toHaveLength(1);
    expect(code).toBe(130);
  });
});

describe('analytics', () => {
  it('aggregates real recorded values and keeps unavailable tokens distinct', async () => {
    const ctx = { catalog: cat, snapshot: () => 'a' };
    const t = 'update the button text';
    await execute(t, mk(t), cfg, scripted([{ code: 0, usage: { input_tokens: 100, output_tokens: 10 } }]).runner, 'exec', ctx);
    await execute(t, mk(t), cfg, scripted([{ code: 1, tail: 'bad' }, { code: 0, usage: { input_tokens: 50, output_tokens: 5 } }]).runner, 'exec', ctx);
    await execute('implement user CRUD', mk('implement user CRUD'), cfg, scripted([{ code: 0 }]).runner, 'interactive', ctx);
    const s = stats(readRuns());
    expect(s).toMatchObject({
      total_tasks: 3, succeeded: 3, failed: 0, escalated_tasks: 1, runs_with_tokens: 2, runs_without_tokens: 1,
      input_tokens: 150, output_tokens: 15, total_tokens: 165, token_usage: 'available',
    });
    expect(s.by_tier).toMatchObject({ fast: 2, normal: 1 });
    expect(s.by_model['gpt-6-luna']).toBe(3);
    expect(s.by_reasoning).toMatchObject({ low: 1, medium: 2 });
    expect(stats([]).token_usage).toBe('unavailable');
    expect(stats([]).total_tokens).toBeNull();
  });
  it('does not store prompts by default and honors analytics.enabled=false', async () => {
    const t = 'update the button text secret-xyz';
    await execute(t, mk(t), cfg, scripted([{ code: 0 }]).runner, 'exec', { catalog: cat });
    expect(JSON.stringify(readRuns())).not.toContain('secret-xyz');
    const off = ConfigSchema.parse({ analytics: { enabled: false } });
    await execute(t, mk(t, off), off, scripted([{ code: 0 }]).runner, 'exec', { catalog: cat });
    expect(readRuns()).toHaveLength(1);
  });
});

describe('codexRunner (fake codex binary)', () => {
  const fake = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-bin-'));
    const bin = path.join(dir, 'codex');
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { bin, out: path.join(dir, 'args.txt') };
  };
  it('passes the task as a single argv element after "--" (no shell interpretation) and preserves exit code', async () => {
    const f = fake('printf "%s\\n" "$@" > "$(dirname "$0")/args.txt"; exit 3');
    const evil = '--dangerous; touch /tmp/sc-pwn2 $(id) `id`';
    const runner = codexRunner('exec', empty, f.bin);
    const r = await runner({ model: 'gpt-6-luna', effort: 'low' }, evil);
    runner.dispose();
    expect(r.code).toBe(3);
    const lines = fs.readFileSync(f.out, 'utf8').split('\n');
    expect(lines.slice(0, 7)).toEqual(['exec', '--json', '-m', 'gpt-6-luna', '-c', 'model_reasoning_effort="low"', '--']);
    expect(lines[7]).toBe(evil);
    expect(fs.existsSync('/tmp/sc-pwn2')).toBe(false);
  });
  it('captures usage from JSON events', async () => {
    const f = fake(`echo '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":2}}'`);
    const runner = codexRunner('exec', empty, f.bin);
    const r = await runner({ model: 'm', effort: 'low' }, 'x');
    runner.dispose();
    expect(r.usage).toMatchObject({ input_tokens: 7, output_tokens: 2 });
  });
  it('SIGINT stops the child, reports 130, blocks further attempts, and cleans up listeners', async () => {
    const f = fake('exec sleep 30');
    const before = process.listenerCount('SIGINT');
    const runner = codexRunner('exec', empty, f.bin, 50);
    const pending = runner({ model: 'm', effort: 'low' }, 'x');
    await new Promise((res) => setTimeout(res, 150));
    process.emit('SIGINT', 'SIGINT');
    const r = await pending;
    expect([r.code, r.interrupted]).toEqual([130, true]);
    expect((await runner({ model: 'm', effort: 'low' }, 'y')).interrupted).toBe(true);
    runner.dispose();
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
  it('missing codex binary reports 127', async () => {
    const runner = codexRunner('exec', empty, '/nonexistent/codex');
    expect((await runner({ model: 'm', effort: 'low' }, 'x')).code).toBe(127);
    runner.dispose();
  });
});
