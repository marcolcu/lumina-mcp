import path from 'node:path';
import type { RoutingLog } from './stages.js';
import type { Retrieval } from './retrieval.js';
import type { TokenBreakdown, TurnItem } from './tui/chat.js';

/**
 * Context efficiency of the last request and the session, from data Lumina already has: the retriever's own
 * measurements, the items Codex reported for the turn, and provider-reported token usage. Kept in memory; only
 * counts (never paths, prompt text or code) go to the existing routing log. Estimates are labelled as such and no
 * savings are ever derived from them.
 */
export interface RequestMetrics {
  at: number;
  retrieval?: Retrieval;
  skills: { names: string[]; mode: string };
  model: string; effort: string; stages: number; switches: number;
  /** Provider-reported usage of the request (all its turns); undefined = Codex did not report it. */
  usage?: TokenBreakdown;
  /** Files Codex reported reading (repository-relative when inside it). */
  filesRead: string[];
  status: string;
  /** Project memory sent with the request. */
  memory?: { entries: number; chars: number; ms: number };
}

const est = (chars: number) => Math.ceil(chars / 4); // rough characters-per-token estimate, shown as "≈ … (estimate)"
const n = (x: number) => x.toLocaleString('en-US');
const ago = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h`);

/** Distinct files read in a request's turns, relative to `root` when inside it. */
export function filesRead(items: TurnItem[], root: string): string[] {
  const out = new Set<string>();
  for (const it of items) for (const p of it.reads ?? []) {
    const rel = path.isAbsolute(p) ? path.relative(root, p) : p;
    out.add(rel.startsWith('..') || path.isAbsolute(rel) ? p : rel);
  }
  return [...out];
}

export class ContextMetrics {
  last?: RequestMetrics;
  private session = { requests: 0, reported: 0, usage: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } as TokenBreakdown };

  constructor(public enabled = true) {}

  record(m: RequestMetrics): void {
    if (!this.enabled) return;
    this.last = m;
    this.session.requests++;
    if (m.usage) {
      this.session.reported++;
      for (const k of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens'] as const) this.session.usage[k] += m.usage[k];
    }
  }

  reset(): void { this.last = undefined; this.session = { requests: 0, reported: 0, usage: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } }; }

  private hinted(m: RequestMetrics): string[] { return m.retrieval?.block ? m.retrieval.hints.map((h) => h.path).filter((p) => m.retrieval!.block!.includes(`- ${p}`)) : []; }

  /** /context */
  format(): string {
    if (!this.enabled) return 'Context metrics are disabled (metrics.enabled = false).';
    const m = this.last;
    if (!m) return 'Context Efficiency\n\nNo request has finished in this session yet.';
    const r = m.retrieval;
    const s = r?.stats;
    const hinted = this.hinted(m);
    const readHinted = m.filesRead.filter((f) => hinted.includes(f)).length;
    const lines = ['Context Efficiency (last request)', '', 'Repository:'];
    lines.push(`  Indexed files: ${s?.indexedFiles !== undefined ? n(s.indexedFiles) : 'unavailable'}${s?.mapAgeMs !== undefined ? ` · map ${ago(s.mapAgeMs)} old${s.mapCached ? ' (cached)' : ' (rebuilt)'}` : ''}`);
    lines.push(`  Candidate files: ${s?.candidates ?? 'unavailable'} · Selected: ${hinted.length}`);
    lines.push(`  Files read by Codex: ${m.filesRead.length}${hinted.length ? ` (${readHinted} of them hinted)` : ''}`);
    lines.push('', 'Retrieval:');
    if (!r) lines.push('  not run for this request');
    else {
      lines.push(`  Duration: ${r.ms}ms${r.skipped ? ` · skipped: ${r.skipped}` : ''}`);
      if (s?.listCache) lines.push(`  Cache: file list ${s.listCache} · symbols ${s.symbolHits} hit / ${s.symbolMisses} miss`);
      lines.push(`  Hint size: ${r.block ? `${n(r.block.length)} chars ≈ ${n(est(r.block.length))} tokens (estimate)` : 'none sent'}`);
    }
    lines.push('', `Memory: ${m.memory?.entries ? `${m.memory.entries} entr${m.memory.entries === 1 ? 'y' : 'ies'} · ${n(m.memory.chars)} chars ≈ ${n(est(m.memory.chars))} tokens (estimate) · ${m.memory.ms}ms` : 'none sent'}`);
    lines.push('', `Skills: ${m.skills.names.length ? `${m.skills.names.map((x) => `$${x}`).join(' ')} (${m.skills.mode})` : 'none'}`);
    lines.push('', 'Model Usage (provider-reported):');
    lines.push(`  Model: ${m.model || 'unknown'} · Reasoning: ${m.effort || 'unknown'} · Stages: ${m.stages} · Switches: ${m.switches} · ${m.status}`);
    lines.push(m.usage ? `  Input: ${n(m.usage.inputTokens)} tokens · Cached: ${n(m.usage.cachedInputTokens)} · Output: ${n(m.usage.outputTokens)}` : '  Tokens: unavailable (Codex did not report usage for this request)');
    const u = this.session;
    lines.push('', `Session: ${u.requests} request${u.requests === 1 ? '' : 's'}${u.reported ? ` · input ${n(u.usage.inputTokens)} · cached ${n(u.usage.cachedInputTokens)} · output ${n(u.usage.outputTokens)}` : ''}${u.reported < u.requests ? ` (${u.requests - u.reported} without reported usage)` : ''}`);
    lines.push('', 'Estimates are characters ÷ 4. Savings are not inferred from them; compare real runs with bench/context.bench.ts.');
    return lines.join('\n');
  }

  /** Optional one-line summary after a request (metrics.summary). */
  summary(m: RequestMetrics): string {
    const hinted = this.hinted(m).length;
    return `context: ${hinted ? `${hinted} hinted · ` : ''}${m.filesRead.length} read · ${m.usage ? `in ${n(m.usage.inputTokens)} (cached ${n(m.usage.cachedInputTokens)}) out ${n(m.usage.outputTokens)}` : 'tokens unavailable'}${m.retrieval ? ` · retrieval ${m.retrieval.ms}ms` : ''}`;
  }

  /** Numbers only, for the existing routing log: no paths, prompt text, code or skill descriptions. */
  logEntry(m: RequestMetrics): RoutingLog {
    const s = m.retrieval?.stats;
    return {
      level: 'info', event: 'context_metrics', request_id: `req_${m.at.toString(36)}`, execution_id: '-', routing_strategy: m.stages > 1 ? 'staged' : 'single',
      selected_model: m.model, reasoning_effort: m.effort, stage_count: m.stages, switch_count: m.switches, status: m.status,
      retrieval_ms: m.retrieval?.ms ?? null, retrieval_skipped: m.retrieval?.skipped ?? null, indexed_files: s?.indexedFiles ?? null, candidate_files: s?.candidates ?? null,
      selected_files: this.hinted(m).length, hint_chars: m.retrieval?.block?.length ?? 0, hint_tokens_estimate: m.retrieval?.block ? est(m.retrieval.block.length) : 0,
      list_cache: s?.listCache ?? null, symbol_cache_hits: s?.symbolHits ?? 0, symbol_cache_misses: s?.symbolMisses ?? 0, map_age_ms: s?.mapAgeMs ?? null,
      files_read: m.filesRead.length, memory_entries: m.memory?.entries ?? 0, memory_chars: m.memory?.chars ?? 0, skills_selected: m.skills.names.length, skill_mode: m.skills.mode,
      usage_reported: Boolean(m.usage), input_tokens: m.usage?.inputTokens ?? null, cached_input_tokens: m.usage?.cachedInputTokens ?? null, output_tokens: m.usage?.outputTokens ?? null,
    };
  }
}
