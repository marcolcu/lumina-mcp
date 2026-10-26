import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Route } from '../smart-codex/router.js';
import { classifyFailure, redact } from '../smart-codex/run.js';
import { stateDir } from '../smart-codex/config.js';
import { unwrap } from './approval/policy.js';
import type { HealOutcome } from './heal.js';
import { categoryOf } from './feedback.js';
import { looksSecret } from './memory.js';
import type { RoutingLog } from './stages.js';
import type { TokenBreakdown } from './tui/chat.js';
import type { Verification } from './verify.js';

/**
 * Execution diagnostics: one record per request, filled from what Lumina already observes (the routing decision,
 * stage-engine log events, App Server item events, verification and self-healing results, provider-reported usage).
 * Nothing is inferred by a model; missing data stays missing. Records are sanitized (no prompts unless
 * analytics.store_prompts, no command arguments, secrets redacted) and kept in a bounded local JSONL history.
 */
export interface TraceEvent { t: number; type: string; [k: string]: string | number | boolean | null | undefined }
export type FailureCategory = 'budget' | 'application' | 'environment' | 'permission' | 'model unavailable' | 'context' | 'tool' | 'cancellation';
export interface StageRecord { type: string; title: string; model?: string; effort?: string; status: string; ms?: number; thread?: string; escalation?: number }
export interface ExecutionRecord {
  id: string; at: number; ms?: number; status: 'running' | 'completed' | 'failed' | 'cancelled';
  /** Short request title: only kept when analytics.store_prompts is on; otherwise the task classification. */
  title: string;
  routing?: { tier: string; complexity: number; base: number; risk: string; confidence: number; model: string; effort: string; reasons: string[]; reasoning?: string; source: string; strategy: string; reference_chars: number; category?: string; feedback?: { change: string; evidence: string } };
  stages: StageRecord[]; switches: number; escalations: number; compactions: number;
  skills?: { mode: string; names: string[] };
  context?: { retrievalMs?: number; hinted?: number; candidates?: number; skipped?: string; memoryEntries?: number; filesRead?: number; hintsRead?: number; contextPct?: number };
  usage?: TokenBreakdown;
  tools: { commands: number; failedCommands: number; fileChanges: number; mcp: number; approvals: number; declined: number; repeatedTests: number };
  verification?: { level: string; reason: string; checks: { label: string; status: string; source: string; failure?: string; ms: number }[]; declined?: boolean; rerunAfterCodex: number };
  healing?: { status: string; attempts: number; escalations: number; models: string[]; efforts?: string[]; reason: string; classes: { check: string; cls: string }[] };
  failure?: { category: FailureCategory; operation: string; error: string; lastStage?: string; unresolved: string[]; next: string[] };
  insights: string[];
  trace: TraceEvent[]; droppedEvents: number;
}

const HOME = os.homedir();
/** Safe for storage and display: secrets redacted, home shortened, one line, bounded. */
export function sanitize(s: string, max = 200): string {
  let x = redact(String(s)).replace(/\s+/g, ' ').trim();
  if (HOME && HOME !== '/') x = x.split(HOME).join('~');
  x = x.split(/(\s+)/).map((w) => (w.trim() && looksSecret(w) ? '[redacted]' : w)).join('');
  if (looksSecret(x)) x = x.replace(/((password|passwd|pwd|secret|api[_ -]?key|token|access[_ -]?key|client[_ -]?secret)\s*(is|=|:)\s*)\S+/gi, '$1[redacted]').replace(/:\/\/[^/\s:@]+:[^/\s@]+@/g, '://[redacted]@');
  return x.slice(0, max);
}
/** The program and subcommand only (`npm test`, `rg`, `go vet`): arguments may carry data or secrets. */
export function commandName(cmd: string): string {
  const w = unwrap(cmd).trim().split(/\s+/).filter(Boolean);
  const head = path.basename(w[0] ?? '?');
  const sub = w[1] && /^[a-z][\w:-]*$/i.test(w[1]) && !w[1].includes('/') ? ` ${w[1]}` : '';
  return sanitize(`${head}${sub}`, 40);
}

const MODEL_GONE = /model.*(not (supported|available|found)|unsupported|unknown|invalid|does not exist)|unsupported model|no access to model/i;
const CONTEXT = /context (window|length)|maximum context|too many tokens|prompt is too long|context_length_exceeded|compaction failed/i;

/** Category of a failed request from recorded evidence, with next steps. */
export function categorize(error: string, r: Pick<ExecutionRecord, 'status' | 'verification' | 'healing' | 'tools'>): { category: FailureCategory; next: string[] } {
  if (/^stopped: budget exhausted/.test(error)) return { category: 'budget', next: ['Progress is kept. /continue resumes with a fresh budget; /budget shows the limits (raise them in the config if this keeps happening).'] };
  if (r.status === 'cancelled') return { category: 'cancellation', next: ['Nothing failed: the request was cancelled. Send it again to continue; /checkpoints shows what was changed.'] };
  if (MODEL_GONE.test(error)) return { category: 'model unavailable', next: ['Pick another model with /model, or check `codex` model access for your plan.'] };
  if (CONTEXT.test(error)) return { category: 'context', next: ['Start a fresh conversation with /new, or split the request; pasted material counts toward the context window.'] };
  const kind = error ? classifyFailure(error) : 'coding';
  if (kind === 'auth') return { category: 'permission', next: ['Run `codex login` and retry.'] };
  if (kind === 'tool' || r.tools.declined) return { category: 'permission', next: ['A sandbox or approval decision blocked a step. Check /approval, or approve the command when asked.'] };
  if (kind === 'rate_limit') return { category: 'model unavailable', next: ['Usage limit reached: /usage shows when it resets.'] };
  if (kind === 'network' || kind === 'config' || kind === 'dependency') return { category: 'environment', next: [`Fix the ${kind === 'dependency' ? 'missing dependency or command' : kind === 'network' ? 'network connection' : 'configuration'}, then retry.`] };
  const envCheck = r.healing?.classes.find((c) => c.cls === 'ENVIRONMENT_FAILURE');
  if (envCheck) return { category: 'environment', next: [`Fix the environment for "${envCheck.check}" (missing tool, dependency or service), then run /verify.`] };
  if (/mcp|tool call/i.test(error)) return { category: 'tool', next: ['A tool call failed: check the MCP server, then retry.'] };
  return { category: 'application', next: ['Review the failing checks above; say "fix it" to let Codex continue, or /rollback to undo the change.'] };
}

/** Collects one request's diagnostics from events; `finish` freezes it into a record. */
export class Diagnostic {
  readonly rec: ExecutionRecord;
  private readonly t0 = Date.now();
  private testRuns = new Map<string, number>();
  constructor(title: string, private readonly maxEvents = 200) {
    this.rec = { id: `req_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`, at: Date.now(), status: 'running', title: sanitize(title, 80), stages: [], switches: 0, escalations: 0, compactions: 0, tools: { commands: 0, failedCommands: 0, fileChanges: 0, mcp: 0, approvals: 0, declined: 0, repeatedTests: 0 }, insights: [], trace: [], droppedEvents: 0 };
    this.event('request_received');
  }
  get id(): string { return this.rec.id; }

  /** Bounded trace: the first events and the most recent ones are kept; the count of dropped events is recorded. */
  event(type: string, data: Record<string, string | number | boolean | null | undefined> = {}): void {
    const clean: TraceEvent = { t: Date.now() - this.t0, type };
    for (const [k, v] of Object.entries(data)) if (v !== undefined) clean[k] = typeof v === 'string' ? sanitize(v, 160) : v;
    const tr = this.rec.trace;
    tr.push(clean);
    if (tr.length > this.maxEvents) { tr.splice(20, 1); this.rec.droppedEvents++; }
  }

  routed(route: Route, sel: { model?: string; effort?: string }, source: string, strategy: string): void {
    this.rec.routing = { tier: route.tier, complexity: route.complexity_score, base: route.base_complexity, risk: route.risk, confidence: route.confidence, model: sel.model ?? route.model, effort: sel.effort ?? route.reasoning_effort, reasons: route.reason.split('; ').filter(Boolean).map((r) => sanitize(r, 120)), reasoning: route.reasoning_reason ? sanitize(route.reasoning_reason, 200) : undefined, source, strategy, reference_chars: route.reference_chars, category: categoryOf(route), feedback: route.feedback };
    this.event('task_classified', { tier: route.tier, complexity: route.complexity_score, risk: route.risk });
    this.event('model_selected', { model: this.rec.routing.model, effort: this.rec.routing.effort, source, strategy });
  }

  /** Stage-engine log events (the existing structured routing log), correlated by this request's id. */
  fromLog(e: RoutingLog): void {
    if (e.event === 'model_switched') { this.rec.switches++; this.event('model_switched', { from: e.previous_model ?? null, to: e.selected_model, reason: e.routing_reason }); }
    else if (e.event === 'escalated') { this.rec.escalations++; this.event('model_escalated', { to: e.selected_model, reason: e.routing_reason, level: e.escalation_level }); }
    else if (e.event === 'context_compacted') { this.rec.compactions++; this.event('context_compacted', { reason: e.routing_reason }); }
    else if (['stage_started', 'stage_completed', 'switch_limit_reached', 'escalation_limit_reached', 'model_fallback', 'model_rejected', 'compaction_failed'].includes(e.event)) {
      this.event(e.event, { stage: e.stage_type, model: e.selected_model, status: e.status, ms: e.execution_duration_ms, reason: e.routing_reason });
    }
  }

  stage(s: StageRecord): void { this.rec.stages.push({ ...s, title: sanitize(s.title, 60) }); }

  /** App Server notifications: tools executed, files changed, compaction. Counts and command names only. */
  onServerEvent(method: string, params: unknown): void {
    const it = (params as { item?: { type?: string; command?: string; exitCode?: number | null; status?: string; changes?: unknown[]; server?: string; tool?: string } })?.item;
    if (method === 'thread/compacted') { this.rec.compactions++; this.event('context_compacted'); return; }
    if (method !== 'item/completed' || !it) return;
    if (it.type === 'commandExecution') {
      this.rec.tools.commands++;
      const name = commandName(it.command ?? '');
      const failed = it.status === 'failed' || (typeof it.exitCode === 'number' && it.exitCode !== 0);
      if (failed) this.rec.tools.failedCommands++;
      if (it.status === 'declined') this.rec.tools.declined++;
      if (/\b(test|vitest|jest|pytest|mocha)\b/.test(unwrap(it.command ?? ''))) { const k = unwrap(it.command ?? '').replace(/\s+/g, ' '); this.testRuns.set(k, (this.testRuns.get(k) ?? 0) + 1); }
      this.event('tool_executed', { tool: name, exit: it.exitCode ?? null, status: it.status });
    } else if (it.type === 'fileChange') { this.rec.tools.fileChanges += Math.max(1, it.changes?.length ?? 1); if (it.status === 'declined') this.rec.tools.declined++; this.event('files_changed', { count: it.changes?.length ?? 1, status: it.status }); }
    else if (it.type === 'mcpToolCall') { this.rec.tools.mcp++; this.event('tool_executed', { tool: sanitize(`${it.server ?? 'mcp'} › ${it.tool ?? '?'}`, 60), status: it.status }); }
  }

  approval(kind: string, decision: string): void { this.rec.tools.approvals++; if (decision === 'decline' || decision === 'cancel') this.rec.tools.declined++; this.event('approval', { kind, decision }); }

  verified(v: Verification, codexCommands: string[] = []): void {
    const ran = new Set(codexCommands.map((c) => unwrap(c).replace(/\s+/g, ' ').trim()));
    const checks = v.results.map((r) => ({ label: r.check.label, status: r.status, source: r.source, failure: r.failure, ms: r.ms }));
    const rerunAfterCodex = v.results.filter((r) => r.source === 'ran' && ran.has(r.check.command)).length;
    const prev = this.rec.verification;
    this.rec.verification = { level: v.level, reason: sanitize(v.reason, 120), checks: [...(prev?.checks ?? []), ...checks], declined: v.declined, rerunAfterCodex: (prev?.rerunAfterCodex ?? 0) + rerunAfterCodex };
    this.event('verification_completed', { level: v.level, passed: checks.filter((c) => c.status === 'passed').length, failed: checks.filter((c) => c.status === 'failed').length, reused: checks.filter((c) => c.source !== 'ran').length });
  }

  healed(h: HealOutcome): void {
    this.rec.healing = { status: h.status, attempts: h.attempts, escalations: h.escalations, models: h.models, efforts: h.efforts, reason: sanitize(h.reason, 120), classes: h.classes.map((c) => ({ check: sanitize(c.check, 60), cls: c.cls })) };
    this.event('self_healing', { status: h.status, attempts: h.attempts, escalations: h.escalations });
  }

  finish(status: 'completed' | 'failed' | 'cancelled', o: { error?: string; usage?: TokenBreakdown; contextPct?: number } = {}): ExecutionRecord {
    const r = this.rec;
    r.ms = Date.now() - this.t0;
    r.usage = o.usage;
    r.tools.repeatedTests = [...this.testRuns.values()].filter((n) => n >= 3).length;
    if (o.contextPct !== undefined) r.context = { ...r.context, contextPct: o.contextPct };
    // verification that still fails after the turn makes the request a failure even if the turn itself completed
    const unresolved = (r.verification?.checks ?? []).filter((c) => c.status === 'failed').slice(-5).map((c) => `${c.label}: ${c.failure ?? 'failed'}`);
    const healedOk = r.healing?.status === 'repaired' || r.healing?.status === 'not-needed';
    const lastChecks = r.healing && healedOk ? [] : unresolved;
    r.status = status === 'completed' && lastChecks.length ? 'failed' : status;
    if (r.status !== 'completed') {
      const error = sanitize(o.error ?? (lastChecks[0] ? `verification: ${lastChecks[0]}` : status), 200);
      const { category, next } = categorize(o.error ?? '', r);
      const lastStage = [...r.stages].reverse().find((s) => s.status === 'done')?.title;
      r.failure = { category: lastChecks.length && !o.error && category === 'application' ? 'application' : category, operation: o.error ? (r.stages.find((s) => s.status === 'failed')?.title ?? 'Codex turn') : lastChecks.length ? 'verification' : 'execution', error, lastStage, unresolved: lastChecks, next };
    }
    r.insights = insights(r);
    this.event(`execution_${r.status}`, { ms: r.ms });
    return r;
  }
}

/** Inefficiencies visible in the recorded events only; each line names its evidence. */
export function insights(r: ExecutionRecord): string[] {
  const out: string[] = [];
  const models = r.stages.map((s) => s.model).filter(Boolean);
  if (models.some((m, i) => i >= 2 && m === models[i - 2] && m !== models[i - 1])) out.push(`model switched back and forth (${models.join(' → ')}): each switch starts without the prompt cache`);
  else if (r.switches >= 2) out.push(`${r.switches} model switches in one request`);
  if (r.compactions >= 2) out.push(`context compacted ${r.compactions} times in one request: consider /new for unrelated work`);
  if (r.context?.retrievalMs !== undefined && r.context.retrievalMs > 500) out.push(`context retrieval took ${r.context.retrievalMs}ms`);
  if (r.context?.hinted && r.context.filesRead && r.context.hintsRead === 0) out.push(`none of the ${r.context.hinted} hinted file${r.context.hinted === 1 ? ' was' : 's were'} read by Codex (it read ${r.context.filesRead} other${r.context.filesRead === 1 ? '' : 's'})`);
  if (r.verification?.rerunAfterCodex) out.push(`${r.verification.rerunAfterCodex} verification check(s) re-ran a command Codex had already run (its result was not reusable: edited afterwards, piped, or failed)`);
  if (r.tools.repeatedTests) out.push(`the same test command ran 3+ times during the turn (${r.tools.repeatedTests} command${r.tools.repeatedTests === 1 ? '' : 's'})`);
  if (r.healing && r.healing.attempts >= 2 && r.healing.status !== 'repaired') out.push(`${r.healing.attempts} repair attempts without a passing result`);
  if (r.usage && r.usage.inputTokens > 200_000 && r.usage.cachedInputTokens / r.usage.inputTokens > 0.9) out.push(`large conversation history: ${r.usage.cachedInputTokens.toLocaleString('en-US')} cached input tokens re-read (provider-reported); /new starts fresh`);
  if (r.context?.contextPct !== undefined && r.context.contextPct >= 70) out.push(`context window ${r.context.contextPct}% full (provider-reported)`);
  return out;
}

const n = (x: number) => x.toLocaleString('en-US');
const secs = (ms?: number) => (ms === undefined ? 'unknown' : ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** /why: the recorded routing decision. */
export function formatWhy(r: ExecutionRecord | undefined, displayName: (m: string) => string = (m) => m): string {
  if (!r?.routing) return 'Routing Decision\n\nNo request has been routed in this session yet.';
  const g = r.routing;
  const out = ['Routing Decision', '', `Task: ${r.title}`, `Classification: ${g.tier} · complexity ${g.complexity}/10 (base ${g.base}) · risk ${g.risk} · confidence ${g.confidence}`, `Model: ${displayName(g.model)}`, `Reasoning: ${cap(g.effort)}${g.reasoning && !/^explicitly/.test(g.reasoning) && g.source === 'automatic routing' ? ` — ${g.reasoning}` : ''}`, `Selected by: ${g.source}`];
  if (g.reasons.length) out.push('', 'Reasons:', ...g.reasons.map((x) => `- ${x}`));
  out.push('', g.feedback ? `History: ${g.feedback.change} — ${g.feedback.evidence}` : `History: not used${g.category ? ` (category "${g.category}")` : ''} — the deterministic route stands`);
  if (g.reference_chars) out.push(`- ${n(g.reference_chars)} chars of pasted reference material were not used to judge complexity`);
  out.push('', `Strategy: ${cap(g.strategy)}`, `Stages: ${r.stages.length || (r.status === 'running' ? 'running' : 1)}${r.escalations ? ` · escalations: ${r.escalations}` : ''}${r.switches ? ` · switches: ${r.switches}` : ''}`);
  if (r.stages.length > 1) out.push(...r.stages.map((s, i) => `  ${i + 1}. ${s.title} · ${s.model ? displayName(s.model) : '?'}${s.effort ? ` · ${s.effort} reasoning` : ''} · ${s.status}`));
  if (r.healing && r.healing.attempts) out.push(`Self-healing: ${r.healing.attempts} repair attempt${r.healing.attempts === 1 ? '' : 's'} on ${r.healing.models.map((m, i) => `${displayName(m)}${r.healing!.efforts?.[i] ? `/${r.healing!.efforts[i]}` : ''}`).join(' → ')}`);
  out.push('', 'Reasoning is set per Codex turn and can only change between stages, never during a running turn.');
  return out.join('\n');
}

/** /diagnostics: the execution summary; only measured values are shown. */
export function formatDiagnostics(r: ExecutionRecord | undefined, displayName: (m: string) => string = (m) => m, detail = false): string {
  if (!r) return 'Execution Diagnostics\n\nNo execution recorded yet.';
  const out = ['Execution Diagnostics', '', `Request: ${r.title} · ${r.id}`, `Status: ${cap(r.status)}`, `Duration: ${secs(r.ms)}`];
  if (r.routing) out.push('', 'Routing:', `  Model: ${displayName(r.routing.model)} · Reasoning: ${cap(r.routing.effort)} · ${r.routing.tier} tier`, `  Strategy: ${cap(r.routing.strategy)} · Stages: ${r.stages.length} · Switches: ${r.switches}${r.escalations ? ` · Escalations: ${r.escalations}` : ''}${r.compactions ? ` · Compactions: ${r.compactions}` : ''}`);
  if (r.skills?.names.length) out.push(`  Skills: ${r.skills.names.map((s) => `$${s}`).join(' ')} (${r.skills.mode})`);
  const c = r.context;
  const ctx: string[] = [];
  if (c?.hinted !== undefined) ctx.push(`  Relevant files hinted: ${c.hinted}${c.candidates !== undefined ? ` of ${c.candidates} candidates` : ''}${c.retrievalMs !== undefined ? ` · retrieval ${c.retrievalMs}ms` : ''}`);
  else if (c?.skipped) ctx.push(`  Retrieval: skipped (${c.skipped})`);
  if (c?.memoryEntries) ctx.push(`  Project memory: ${c.memoryEntries} note${c.memoryEntries === 1 ? '' : 's'}`);
  if (c?.filesRead !== undefined) ctx.push(`  Files read by Codex: ${c.filesRead}`);
  ctx.push(r.usage ? `  Input tokens: ${n(r.usage.inputTokens)} · Cached: ${n(r.usage.cachedInputTokens)} · Output: ${n(r.usage.outputTokens)} (provider-reported)` : '  Tokens: not reported for this request');
  if (c?.contextPct !== undefined) ctx.push(`  Context window: ${c.contextPct}% used`);
  out.push('', 'Context:', ...ctx);
  out.push('', 'Tools:', `  Commands: ${r.tools.commands}${r.tools.failedCommands ? ` (${r.tools.failedCommands} non-zero exit)` : ''} · File changes: ${r.tools.fileChanges} · MCP calls: ${r.tools.mcp}${r.tools.approvals ? ` · Approvals: ${r.tools.approvals}${r.tools.declined ? ` (${r.tools.declined} declined)` : ''}` : ''}`);
  const v = r.verification;
  if (v) {
    const passed = v.checks.filter((x) => x.status === 'passed');
    out.push('', 'Verification:', `  Level: ${cap(v.level)}${v.reason ? ` (${v.reason})` : ''}${v.declined ? ' · declined' : ''}`);
    out.push(v.checks.length ? `  ${passed.length} passed${passed.some((x) => x.source !== 'ran') ? ` (${passed.filter((x) => x.source !== 'ran').length} reused)` : ''} · ${v.checks.filter((x) => x.status === 'failed').length} failed · ${v.checks.filter((x) => x.status === 'skipped').length} skipped` : '  no checks ran');
    for (const x of v.checks.filter((y) => y.status === 'failed').slice(-3)) out.push(`  ✗ ${x.label}: ${x.failure ?? 'failed'}`);
  }
  const h = r.healing;
  if (h && h.status !== 'not-needed') out.push('', 'Self-Healing:', `  ${h.attempts} repair attempt${h.attempts === 1 ? '' : 's'} · ${h.status}${h.escalations ? ` · ${h.escalations} escalation${h.escalations === 1 ? '' : 's'}` : ''}${h.models.length ? ` · ${h.models.map(displayName).join(' → ')}` : ''}`, `  ${h.reason}`);
  if (r.failure) {
    const f = r.failure;
    out.push('', 'Failure:', `  Category: ${f.category}`, `  Failed operation: ${f.operation}`, `  Error: ${f.error}`);
    if (f.lastStage) out.push(`  Last successful stage: ${f.lastStage}`);
    if (h?.attempts) out.push(`  Repair attempts: ${h.attempts}`);
    if (f.unresolved.length) out.push('  Unresolved:', ...f.unresolved.map((u) => `    - ${u}`));
    out.push('  Next steps:', ...f.next.map((x) => `    - ${x}`));
  }
  if (r.insights.length) out.push('', 'Performance:', ...r.insights.map((x) => `  - ${x}`));
  if (detail) {
    out.push('', `Trace (${r.trace.length} events${r.droppedEvents ? `, ${r.droppedEvents} older events dropped` : ''}):`);
    for (const e of r.trace) {
      const { t, type, ...rest } = e;
      out.push(`  +${secs(t).padStart(5)} ${type}${Object.keys(rest).length ? ` ${Object.entries(rest).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`);
    }
  }
  return out.join('\n');
}

/** Bounded local history (JSONL per project under the state dir); one append per finished request. */
export class DiagnosticsHistory {
  readonly file: string;
  constructor(root: string, private readonly keep: number) {
    this.file = path.join(stateDir(), 'diagnostics', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.jsonl`);
  }
  append(r: ExecutionRecord): void {
    if (this.keep <= 0) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, `${JSON.stringify(r)}\n`, { mode: 0o600 });
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > this.keep * 2) { // trimmed occasionally, not on every write
        fs.writeFileSync(`${this.file}.tmp`, `${lines.slice(-this.keep).join('\n')}\n`, { mode: 0o600 });
        fs.renameSync(`${this.file}.tmp`, this.file);
      }
    } catch { /* diagnostics must never break execution */ }
  }
  /** Newest first, at most `keep`; unreadable lines are skipped. */
  list(): ExecutionRecord[] {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out: ExecutionRecord[] = [];
    for (const l of text.split('\n').filter(Boolean).slice(-this.keep).reverse()) { try { const r = JSON.parse(l) as ExecutionRecord; if (r.id && r.trace) out.push(r); } catch { /* skip */ } }
    return out;
  }
}
