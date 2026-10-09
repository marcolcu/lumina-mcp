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
      merged[k] = { ...(merged[k] as object), ...v };
    }
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) throw new Error(`Invalid smart-codex config: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}
