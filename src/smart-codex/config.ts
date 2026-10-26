import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const TIERS = ['fast', 'normal', 'hard', 'critical'] as const;
export type Tier = (typeof TIERS)[number];

export const ConfigSchema = z.object({
  routing: z.object({
    default_tier: z.enum(TIERS).default('normal'),
    default_agents: z.number().int().min(1).default(1),
    max_attempts: z.number().int().min(1).max(5).default(3),
    llm_classification: z.literal(false).default(false), // router never calls an LLM
  }).default({}),
  // Preferred model ids per tier; resolved against the installed Codex model catalog.
  models: z.object({
    fast: z.string().default('gpt-6-luna'), normal: z.string().default('gpt-6-luna'),
    hard: z.string().default('gpt-6-sol'), critical: z.string().default('gpt-6-sol'),
  }).default({}),
  reasoning: z.object({
    fast: z.string().default('low'), normal: z.string().default('medium'),
    hard: z.string().default('high'), critical: z.string().default('high'),
    critical_simple: z.string().default('medium'), // security-sensitive but small changes
  }).default({}),
  optimization: z.object({
    minimal_context: z.boolean().default(true),
    max_context_files: z.number().int().min(0).max(50).default(8),
    max_scanned_files: z.number().int().min(100).default(20000),
    max_analysis_depth: z.number().int().min(0).max(3).default(1),
    max_file_read_bytes: z.number().int().min(256).max(65536).default(4096),
  }).default({}),
  // Lumina smart context: file-path/symbol hints prepended to a turn (never file contents; Codex may explore freely)
  retrieval: z.object({
    enabled: z.boolean().default(true),
    max_files: z.number().int().min(1).max(30).default(6),
    max_chars: z.number().int().min(200).max(20000).default(1200), // hint block budget (~4 chars per token)
    max_read_bytes: z.number().int().min(512).max(65536).default(8192), // per candidate, only to find symbol lines
    timeout_ms: z.number().int().min(50).max(10000).default(800), // the turn never waits longer than this
  }).default({}),
  // Lumina automatic skill selection (deterministic; explicit $skill always wins)
  skills: z.object({
    auto_select: z.boolean().default(true),
    max_auto: z.number().int().min(0).max(3).default(2),
  }).default({}),
  // Lumina context efficiency metrics (in memory for /context; numbers only in routing.jsonl)
  metrics: z.object({
    enabled: z.boolean().default(true),
    summary: z.boolean().default(false), // one dim line after each request
    log: z.boolean().default(true), // a `context_metrics` entry in routing.jsonl (also needs analytics.enabled)
  }).default({}),
  // Lumina smart verification after code changes (project .smart-codex.json may override)
  verification: z.object({
    mode: z.enum(['auto', 'quick', 'standard', 'full', 'off']).default('auto'),
    timeout_ms: z.number().int().min(5000).max(3_600_000).default(600_000), // per check
    reuse: z.boolean().default(true), // reuse passing results of identical checks on an unchanged tree
    use_graph: z.boolean().default(true), // add tests of graph-confirmed dependents; high predicted impact raises the level
  }).default({}),
  // Lumina self-healing: focused repair turns after verification finds code failures (bounded)
  self_healing: z.object({
    enabled: z.boolean().default(true),
    max_repair_attempts: z.number().int().min(0).max(5).default(2),
    max_escalations: z.number().int().min(0).max(3).default(2),
    transient_retries: z.number().int().min(0).max(3).default(1), // re-run checks (no code change) on transient failures
  }).default({}),
  // Lumina persistent project memory (local markdown per repository; only relevant, verified notes are sent)
  memory: z.object({
    enabled: z.boolean().default(true),
    max_entries: z.number().int().min(0).max(20).default(5), // per request
    max_chars: z.number().int().min(100).max(8000).default(800),
    max_implementation_notes: z.number().int().min(0).max(200).default(30),
  }).default({}),
  // Lumina execution diagnostics (/why, /diagnostics): bounded local history, sanitized
  diagnostics: z.object({
    history: z.number().int().min(0).max(1000).default(50), // executions kept per project (0 = none on disk)
    max_events: z.number().int().min(20).max(2000).default(200), // trace events per execution
  }).default({}),
  // Lumina cross-repository awareness: related repositories of a workspace (read-only unless allowed in the user config)
  workspace: z.object({
    repositories: z.array(z.string().min(1)).max(20).default([]),
    /** Relationships the user declares ("from" uses "to"), for links static analysis cannot see. */
    mappings: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(['api', 'package', 'types', 'other']).default('other'), note: z.string().max(200).optional() })).max(50).default([]),
    /** Repositories Lumina may suggest editing from here. Only honoured from the user config, never from a project file. */
    allow_writes: z.array(z.string()).default([]),
  }).default({}),
  // Lumina routing feedback: verified outcomes per task category may nudge future routes (no training, bounded)
  feedback: z.object({
    enabled: z.boolean().default(true), // record outcomes
    influence: z.boolean().default(true), // let enough evidence adjust routes (one step at a time)
    min_evidence: z.number().int().min(3).max(100).default(8),
    window: z.number().int().min(5).max(500).default(50), // most recent outcomes per category considered
    max_records: z.number().int().min(50).max(20000).default(2000),
  }).default({}),
  // Lumina execution budget: optional per-request limits on top of stages.* and self_healing.* (0 = no limit)
  budget: z.object({
    max_duration_ms: z.number().int().min(0).max(24 * 3600 * 1000).default(0),
    max_input_tokens: z.number().int().min(0).default(0), // provider-reported input (cached included)
    max_output_tokens: z.number().int().min(0).default(0),
  }).default({}),
  escalation: z.object({
    enabled: z.boolean().default(true),
    max_attempts: z.number().int().min(1).max(5).default(3),
    retry_environment_failures: z.boolean().default(false),
    retry_after_file_changes: z.boolean().default(false),
  }).default({}),
  // Intra-request model switching (Lumina): one prompt may run as several turns, each on its own model.
  stages: z.object({
    enabled: z.boolean().default(true),
    /** direct = always one turn · adaptive = one turn, more only when execution needs it · orchestrated = plan complex work upfront */
    execution_strategy: z.enum(['direct', 'adaptive', 'orchestrated']).default('adaptive'),
    tiers: z.object({
      fast: z.string().default('gpt-6-luna'),
      balanced: z.string().default('gpt-6-sol'),
      advanced: z.string().default('gpt-6-astra'),
    }).default({}),
    max_stages: z.number().int().min(1).max(12).default(3),
    max_switches: z.number().int().min(0).max(20).default(4),
    max_escalations: z.number().int().min(0).max(5).default(2),
    max_retries: z.number().int().min(0).max(5).default(2),
    stage_timeout_ms: z.number().int().min(10000).default(15 * 60 * 1000),
    /** auto: extra stages share the thread while its history is small, otherwise run on a fresh thread with a compact hand-off */
    context_strategy: z.enum(['auto', 'shared', 'isolated']).default('auto'),
    isolate_min_context_tokens: z.number().int().min(0).default(40000),
    /** auto: compact the thread before a shared stage only when it is close to the context window */
    compaction_strategy: z.enum(['auto', 'never']).default('auto'),
    compact_threshold: z.number().min(0.1).max(1).default(0.7),
    /** avoid switching to a cheaper model just for a final short stage */
    model_switch_penalty: z.boolean().default(true),
  }).default({}),
  // Lumina checkpoints: pre-execution snapshots stored under the state dir (never in the repository)
  checkpoints: z.object({
    enabled: z.boolean().default(true),
    max_count: z.number().int().min(1).max(500).default(30),
    max_age_days: z.number().int().min(1).max(365).default(14),
    max_file_bytes: z.number().int().min(1024).default(5 * 1024 * 1024),
    max_total_bytes: z.number().int().min(1024 * 1024).default(200 * 1024 * 1024),
  }).default({}),
  analytics: z.object({
    enabled: z.boolean().default(true),
    store_prompts: z.boolean().default(false),
  }).default({}),
});
export type RouterConfig = z.infer<typeof ConfigSchema>;

export function stateDir(): string {
  return process.env.SMART_CODEX_HOME ?? path.join(os.homedir(), '.smart-codex');
}

/**
 * Loads ./.smart-codex.json (project) over ~/.smart-codex/config.json (user). Throws on invalid config.
 * The project file is untrusted (it may come from a cloned repo): it cannot change analytics settings.
 */
export function loadConfig(cwd = process.cwd()): RouterConfig {
  const merged: Record<string, unknown> = {};
  const sources: [string, boolean][] = [[path.join(stateDir(), 'config.json'), true], [path.join(cwd, '.smart-codex.json'), false]];
  for (const [file, trusted] of sources) {
    if (!fs.existsSync(file)) continue;
    const part = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;
    for (const [k, v] of Object.entries(part)) {
      if (!trusted && k === 'analytics') continue;
      // a cloned project may list sibling repositories, but not grant write access or point at absolute paths
      if (!trusted && k === 'workspace') {
        const w = { ...v } as { repositories?: unknown; allow_writes?: unknown };
        delete w.allow_writes;
        if (Array.isArray(w.repositories)) w.repositories = w.repositories.filter((r) => typeof r === 'string' && !path.isAbsolute(r) && !r.startsWith('~'));
        merged[k] = { ...(merged[k] as object), ...w };
        continue;
      }
      merged[k] = { ...(merged[k] as object), ...v };
    }
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`Invalid smart-codex config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}
