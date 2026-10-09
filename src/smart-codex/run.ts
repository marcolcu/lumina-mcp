import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { RouterConfig, TIERS, Tier, stateDir } from './config.js';
import { ModelInfo, loadCatalog, nextEffort } from './models.js';
import { Route, isReadOnlyTask } from './router.js';

export interface Step { model: string; effort: string; }
export interface Usage { input_tokens?: number; output_tokens?: number; total_tokens?: number; }
export interface AttemptResult { code: number; interrupted: boolean; tail: string; usage?: Usage; }
export type Runner = (step: Step, prompt: string) => Promise<AttemptResult>;
export type FailureKind = 'auth' | 'rate_limit' | 'network' | 'config' | 'dependency' | 'tool' | 'coding';
export interface RunRecord {
  id: string; ts: string; tier: Tier; model: string; reasoning_effort: string; mode: 'interactive' | 'exec';
  duration_ms: number; attempts: { model: string; effort: string; code: number; failure?: FailureKind }[];
  success: boolean; escalated: boolean; tokens: Usage | null; stopped_reason?: string; prompt?: string;
}
export interface ExecuteContext {
  catalog?: ModelInfo[];
  /** Fingerprint of the working tree; null = cannot be assessed. Injectable for tests. */
  snapshot?: () => string | null;
}

// Order matters: first match wins. Only 'coding' is eligible for automatic escalation.
const FAILURES: [FailureKind, RegExp][] = [
  ['auth', /not logged in|login required|unauthori[sz]ed|\b401\b|invalid api key|authentication (failed|required)|token (expired|invalid)|please (log ?in|sign ?in)/i],
  ['rate_limit', /rate.?limit|\b429\b|usage limit|quota|too many requests/i],
  ['network', /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network (is )?unreachable|stream disconnected|connection (reset|refused|closed)|timed? ?out/i],
  ['config', /invalid config|unknown (field|option)|failed to (load|parse) config|unexpected argument|unrecognized option|unsupported model|does not support reasoning/i],
  ['dependency', /command not found|cannot find module|module not found|not installed|ENOENT/i],
  ['tool', /sandbox|EPERM|EACCES|permission denied|operation not permitted|approval (denied|required)|ENOSPC|mcp server.*(fail|error)/i],
];
const HINT: Record<Exclude<FailureKind, 'coding'>, string> = {
  auth: 'Run `codex login` and retry.', rate_limit: 'Wait for the limit to reset, then retry.',
  network: 'Check connectivity, then retry.', config: 'Fix the Codex/smart-codex configuration or flags.',
  dependency: 'Install the missing dependency or command.', tool: 'A sandbox/permission/tool problem blocked the run; review approvals and disk space.',
};

/** Classifies a failed attempt from exit code and the output tail. Unknown → 'coding'. */
export function classifyFailure(tail: string, code = 1): FailureKind {
  if (code === 127 || code === 126) return 'dependency';
  const recent = tail.slice(-1500);
  return FAILURES.find(([, re]) => re.test(recent))?.[0] ?? 'coding';
}

const redact = (s: string) => s.replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|Bearer\s+[A-Za-z0-9._-]{8,})/g, '[redacted]');
const compact = (tail: string) => redact(tail.slice(-500).replace(/\s+/g, ' ').trim());

/** Strictly stronger ladder: same model next effort → hard-tier model at high; deduped. */
export function buildLadder(route: Route, cfg: RouterConfig, catalog: ModelInfo[]): Step[] {
  const start: Step = { model: route.model, effort: route.reasoning_effort };
  const steps = [start];
  const bump = nextEffort(catalog.find((m) => m.slug === start.model), start.effort);
  if (bump) steps.push({ model: start.model, effort: bump });
  const strong = cfg.models.hard;
  const strongInfo = catalog.find((m) => m.slug === strong);
  if (strong !== start.model && (strongInfo || catalog.length === 0)) {
    steps.push({ model: strong, effort: strongInfo && !strongInfo.efforts.includes('high') ? strongInfo.efforts[0] : 'high' });
  }
  const seen = new Set<string>();
  return steps.filter((s) => !seen.has(`${s.model}|${s.effort}`) && seen.add(`${s.model}|${s.effort}`));
}

/** Hash of `git status` + `git diff HEAD` for cwd; null when not a git repo or too large to assess. */
export function gitSnapshot(cwd = process.cwd()): string | null {
  try {
    const git = (...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
    return createHash('sha1').update(git('status', '--porcelain', '-z')).update(git('diff', 'HEAD')).digest('hex');
  } catch {
    return null;
  }
}

export function recordRun(rec: RunRecord, cfg: RouterConfig): void {
  if (!cfg.analytics.enabled) return;
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.appendFileSync(path.join(stateDir(), 'runs.jsonl'), `${JSON.stringify(rec)}\n`);
}

export function readRuns(): RunRecord[] {
  try {
    return fs.readFileSync(path.join(stateDir(), 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
  } catch {
    return [];
  }
}

const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});

export function stats(runs = readRuns()) {
  const withTokens = runs.filter((r) => r.tokens);
  const sum = (f: (u: Usage) => number) => withTokens.reduce((n, r) => n + f(r.tokens as Usage), 0);
  const input = sum((u) => u.input_tokens ?? 0);
  const output = sum((u) => u.output_tokens ?? 0);
  return {
    total_tasks: runs.length,
    by_tier: Object.fromEntries(TIERS.map((t) => [t, runs.filter((r) => r.tier === t).length])) as Record<Tier, number>,
    by_model: tally(runs.map((r) => r.model)),
    by_reasoning: tally(runs.map((r) => r.reasoning_effort)),
    succeeded: runs.filter((r) => r.success).length,
    failed: runs.filter((r) => !r.success).length,
    escalated_tasks: runs.filter((r) => r.escalated).length,
    average_duration_s: runs.length ? Math.round(runs.reduce((s, r) => s + r.duration_ms, 0) / runs.length / 100) / 10 : 0,
    token_usage: withTokens.length ? 'available' : 'unavailable',
    runs_with_tokens: withTokens.length,
    runs_without_tokens: runs.length - withTokens.length,
    input_tokens: withTokens.length ? input : null,
    output_tokens: withTokens.length ? output : null,
    total_tokens: withTokens.length ? sum((u) => u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0)) : null,
  };
}

export function formatStats(s: ReturnType<typeof stats>): string {
  const kv = (o: Record<string, number>) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
  return [
    `Total Tasks: ${s.total_tasks}`, ...TIERS.map((t) => `${t.toUpperCase()}: ${s.by_tier[t]}`), '',
    `Models: ${kv(s.by_model)}`, `Reasoning: ${kv(s.by_reasoning)}`,
    `Succeeded: ${s.succeeded}  Failed: ${s.failed}`, `Escalated Tasks: ${s.escalated_tasks}`, `Average Duration: ${s.average_duration_s}s`,
    s.token_usage === 'available'
      ? `Token Usage: recorded for ${s.runs_with_tokens} run(s) (input ${s.input_tokens}, output ${s.output_tokens}, total ${s.total_tokens}); unavailable for ${s.runs_without_tokens} (interactive runs expose no usage)`
      : 'Token Usage: Unavailable',
  ].join('\n');
}

function buildPrompt(task: string, route: Route, failure: string | undefined, resumeNote: boolean): string {
  const parts = [task];
  if (route.relevant_files.length) parts.push(`Likely relevant files (hint only, verify): ${route.relevant_files.join(', ')}`);
  if (failure) parts.push(`Previous attempt failed: ${failure}\nDo not repeat the same approach.`);
  if (resumeNote) parts.push('The working tree already contains partial changes from the previous attempt. Inspect them with git diff and continue from that state; do not re-apply or duplicate them.');
  return parts.join('\n\n');
}

const addUsage = (a: Usage | undefined, b: Usage | undefined): Usage | undefined => (!a ? b : !b ? a : {
  input_tokens: (a.input_tokens ?? 0) + (b.input_tokens ?? 0), output_tokens: (a.output_tokens ?? 0) + (b.output_tokens ?? 0),
  ...(a.total_tokens !== undefined && b.total_tokens !== undefined ? { total_tokens: a.total_tokens + b.total_tokens } : {}),
});

/**
 * Runs the ladder. Interactive mode is a single attempt (no reliable failure signal).
 * Retries only coding failures, and only when the previous attempt provably left the working tree untouched
 * (or the task is read-only, or the user opted into retry_after_file_changes).
 */
export async function execute(task: string, route: Route, cfg: RouterConfig, runner: Runner, mode: 'interactive' | 'exec', ctx: ExecuteContext = {}): Promise<{ code: number; record: RunRecord; diagnostic?: string }> {
  const t0 = Date.now();
  const snapshot = ctx.snapshot ?? (() => gitSnapshot());
  const max = mode === 'exec' && route.escalation_allowed && cfg.escalation.enabled ? Math.min(cfg.escalation.max_attempts, cfg.routing.max_attempts) : 1;
  const ladder = buildLadder(route, cfg, ctx.catalog ?? loadCatalog()).slice(0, max);
  const readOnly = isReadOnlyTask(task);
  const attempts: RunRecord['attempts'] = [];
  let failure: string | undefined;
  let resumeNote = false;
  let usage: Usage | undefined;
  let code = 1;
  let diagnostic: string | undefined;

  for (const [i, step] of ladder.entries()) {
    const before = ladder.length > 1 && !readOnly ? snapshot() : null;
    const r = await runner(step, buildPrompt(task, route, failure, resumeNote));
    code = r.code;
    usage = addUsage(usage, r.usage);
    const kind = r.code === 0 ? undefined : classifyFailure(r.tail, r.code);
    attempts.push({ ...step, code: r.code, failure: kind });
    if (r.code === 0 || r.interrupted) break;
    if (i === ladder.length - 1) break;
    if (kind !== 'coding' && !cfg.escalation.retry_environment_failures) {
      diagnostic = `Stopped after attempt ${i + 1}: ${kind} failure, not a coding error. ${HINT[kind as Exclude<FailureKind, 'coding'>]}`;
      break;
    }
    if (!readOnly) {
      const after = snapshot();
      const changed = before === null || after === null || before !== after;
      if (changed && !cfg.escalation.retry_after_file_changes) {
        diagnostic = `Stopped after attempt ${i + 1}: ${before === null || after === null ? 'working tree could not be assessed (not a git repo?)' : 'the attempt modified the working tree'}, so an automatic retry could duplicate or conflict with its writes. Review with \`git status\`/\`git diff\`, then rerun manually.`;
        break;
      }
      resumeNote = changed;
    }
    failure = `exit ${r.code} on ${step.model}@${step.effort}: ${compact(r.tail)}`;
  }
  const last = attempts[attempts.length - 1];
  const record: RunRecord = {
    id: randomUUID(), ts: new Date().toISOString(), tier: route.tier, model: last.model, reasoning_effort: last.effort,
    mode, duration_ms: Date.now() - t0, attempts, success: code === 0, escalated: attempts.length > 1, tokens: usage ?? null,
    ...(diagnostic ? { stopped_reason: diagnostic } : {}),
    ...(cfg.analytics.store_prompts ? { prompt: task } : {}),
  };
  recordRun(record, cfg);
  return { code, record, diagnostic };
}

function findUsage(o: unknown): Usage | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const obj = o as Record<string, unknown>;
  if (typeof obj.input_tokens === 'number' || typeof obj.output_tokens === 'number') return obj as Usage;
  for (const v of Object.values(obj)) { const u = findUsage(v); if (u) return u; }
  return undefined;
}

export type CodexRunner = Runner & { dispose(): void };

/**
 * Real Codex runner. Argument array only; prompt follows `--` so it can never be parsed as a flag or shell.
 * Signal handlers are installed once per runner so an interrupt between attempts also stops the ladder.
 */
export function codexRunner(mode: 'interactive' | 'exec', cwd: string, bin = 'codex', graceMs = 2000): CodexRunner {
  let child: ChildProcess | undefined;
  let interrupted: number | undefined; // exit code to report
  const onSignal = (sig: NodeJS.Signals) => {
    interrupted = sig === 'SIGINT' ? 130 : 143;
    // A terminal Ctrl-C already reaches the child through the process group; only forward SIGTERM
    // immediately and SIGINT after a grace period if the child is still alive.
    if (sig === 'SIGTERM') child?.kill('SIGTERM');
    else setTimeout(() => child?.exitCode === null && child.kill('SIGINT'), graceMs).unref();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const run: Runner = (step, prompt) => new Promise((resolve) => {
    if (interrupted) return resolve({ code: interrupted, interrupted: true, tail: '' });
    const args = [...(mode === 'exec' ? ['exec', '--json'] : []), '-m', step.model, '-c', `model_reasoning_effort="${step.effort}"`, '--', prompt];
    const proc = spawn(bin, args, { cwd, stdio: mode === 'exec' ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    child = proc;
    let tail = '';
    let usage: Usage | undefined;
    let buf = '';
    const keep = (s: string) => { tail = (tail + s).slice(-4000); };
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line) as { item?: { text?: string }; msg?: { message?: string } };
          usage = findUsage(ev) ?? usage;
          const text = ev.item?.text ?? ev.msg?.message;
          if (text) process.stdout.write(`${text}\n`);
        } catch { process.stdout.write(`${line}\n`); }
        keep(line);
      }
    });
    proc.stderr?.on('data', (d: Buffer) => { process.stderr.write(d); keep(d.toString()); });
    const done = (code: number) => resolve({ code: interrupted ?? code, interrupted: interrupted !== undefined, tail, usage });
    proc.on('error', (e) => { keep(String(e)); done(127); });
    proc.on('close', (code, signal) => done(code ?? (signal === 'SIGINT' ? 130 : 143)));
  });
  return Object.assign(run, { dispose: () => { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); } });
}
