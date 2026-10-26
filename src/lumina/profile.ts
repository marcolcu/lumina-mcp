import type { OutcomeRecord } from './feedback.js';

/**
 * Model performance profiles from the routing-feedback history (the same bounded local file; no new storage, no
 * telemetry). Success rates count only outcomes that were actually verified or failed; unverified runs are reported
 * as unknown. Groups below the sample threshold show counts but no rates. Tasks are compared within complexity bands
 * and categories, never across them.
 */
export const MIN_SAMPLES = 5;
export type Band = 'low' | 'medium' | 'high';
export const bandOf = (complexity: number): Band => (complexity <= 3 ? 'low' : complexity <= 6 ? 'medium' : 'high');

export interface Stats {
  n: number; verifiedSuccess: number; failed: number; unknown: number;
  /** verified successes / (verified successes + failures); undefined below the sample threshold. */
  successRate?: number; escalationRate?: number; repairRate?: number;
  medianMs?: number; timed: number;
  medianInput?: number; medianCached?: number; medianOutput?: number; usageReported: number;
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export function stats(rs: OutcomeRecord[]): Stats {
  const decided = rs.filter((r) => r.outcome !== 'unverified' && r.outcome !== 'cancelled');
  const vs = rs.filter((r) => r.outcome === 'verified-success').length;
  const failed = rs.filter((r) => r.outcome === 'verified-failure' || r.outcome === 'failure').length;
  const usage = rs.filter((r) => typeof r.input === 'number');
  const timed = rs.filter((r) => typeof r.ms === 'number');
  const enough = rs.length >= MIN_SAMPLES;
  return {
    n: rs.length, verifiedSuccess: vs, failed, unknown: rs.length - decided.length,
    successRate: decided.length >= MIN_SAMPLES ? vs / decided.length : undefined,
    escalationRate: enough ? rs.filter((r) => r.escalations > 0).length / rs.length : undefined,
    repairRate: enough ? rs.filter((r) => r.repairs > 0).length / rs.length : undefined,
    medianMs: median(timed.map((r) => r.ms!)), timed: timed.length,
    medianInput: median(usage.map((r) => r.input!)), medianCached: median(usage.filter((r) => typeof r.cached === 'number').map((r) => r.cached!)), medianOutput: median(usage.filter((r) => typeof r.output === 'number').map((r) => r.output!)), usageReported: usage.length,
  };
}

export interface ProfileFilter { category?: string; band?: Band }
/** Parses "/models stats [low|medium|high] [category words]". */
export function parseFilter(arg: string): ProfileFilter {
  const words = arg.trim().split(/\s+/).filter(Boolean);
  const band = words.find((w) => /^(low|medium|high)$/i.test(w))?.toLowerCase() as Band | undefined;
  const category = words.filter((w) => w.toLowerCase() !== band).join(' ').toLowerCase() || undefined;
  return { band, category };
}

const pct = (x?: number) => (x === undefined ? undefined : `${Math.round(x * 100)}%`);
const secs = (ms?: number) => (ms === undefined ? 'not recorded' : ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`);
const n = (x?: number) => (x === undefined ? '—' : x.toLocaleString('en-US'));

function lines(s: Stats, indent: string): string[] {
  const out = [`${indent}Executions: ${s.n} (${s.verifiedSuccess} verified success, ${s.failed} failed, ${s.unknown} unknown — not verified)`];
  out.push(`${indent}Verified success: ${pct(s.successRate) ?? `insufficient samples (${s.n - s.unknown} verified/failed, need ${MIN_SAMPLES})`}`);
  out.push(`${indent}Median duration: ${secs(s.medianMs)}${s.timed < s.n ? ` (${s.timed} of ${s.n} timed)` : ''}`);
  out.push(s.usageReported ? `${indent}Median tokens per request: input ${n(s.medianInput)} · cached ${n(s.medianCached)} · output ${n(s.medianOutput)}${s.usageReported < s.n ? ` (reported for ${s.usageReported} of ${s.n})` : ''}` : `${indent}Tokens: not reported`);
  if (s.escalationRate !== undefined) out.push(`${indent}Escalated: ${pct(s.escalationRate)} · Needed repair: ${pct(s.repairRate)}`);
  return out;
}

/** /models stats: per model, then per reasoning effort and complexity band (only like is compared with like). */
export function formatProfile(all: OutcomeRecord[], filter: ProfileFilter = {}, displayName: (m: string) => string = (m) => m): string {
  let rs = all.filter((r) => r.outcome !== 'cancelled');
  if (filter.band) rs = rs.filter((r) => bandOf(r.complexity) === filter.band);
  if (filter.category) rs = rs.filter((r) => r.category.toLowerCase().includes(filter.category!));
  const scope = [filter.band && `${filter.band} complexity`, filter.category && `category "${filter.category}"`].filter(Boolean).join(', ');
  const head = `Model Performance${scope ? ` · ${scope}` : ''} · ${rs.length} execution${rs.length === 1 ? '' : 's'} (local history)`;
  if (!rs.length) return `${head}\n\nNo recorded executions${scope ? ' match this filter' : ' yet'}. Outcomes are recorded after each request (see /feedback).`;
  const out = [head];
  const byModel = new Map<string, OutcomeRecord[]>();
  for (const r of rs) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  for (const [model, xs] of [...byModel].sort((a, b) => b[1].length - a[1].length)) {
    out.push('', `${displayName(model)}:`, ...lines(stats(xs), '  '));
    const groups = new Map<string, OutcomeRecord[]>();
    for (const r of xs) { const k = `${r.effort} reasoning · ${bandOf(r.complexity)} complexity`; groups.set(k, [...(groups.get(k) ?? []), r]); }
    if (groups.size > 1) for (const [k, ys] of [...groups].sort()) { const s = stats(ys); out.push(`    ${k}: ${s.n} run${s.n === 1 ? '' : 's'} · success ${pct(s.successRate) ?? 'insufficient samples'} · median ${secs(s.medianMs)}`); }
  }
  // comparisons only within the same complexity band, and only where each side has enough verified samples
  const comparable: string[] = [];
  for (const band of ['low', 'medium', 'high'] as Band[]) {
    const per = [...byModel].map(([m, xs]) => ({ m, s: stats(xs.filter((r) => bandOf(r.complexity) === band)) })).filter((x) => x.s.successRate !== undefined);
    if (per.length >= 2) comparable.push(`  ${band} complexity: ${per.map((x) => `${displayName(x.m)} ${pct(x.s.successRate)} (${x.s.n - x.s.unknown} verified/failed), median ${secs(x.s.medianMs)}`).join(' · ')}`);
  }
  out.push('', comparable.length ? 'Like-for-like (same complexity band, enough samples):' : 'No like-for-like comparison yet: models need enough verified runs in the same complexity band.', ...comparable);
  const mixes = [...byModel].map(([m, xs]) => `${displayName(m)} ${(['low', 'medium', 'high'] as Band[]).map((b) => xs.filter((r) => bandOf(r.complexity) === b).length).join('/')}`);
  if (byModel.size > 1) out.push(`Task mix (low/medium/high complexity): ${mixes.join(' · ')} — overall rates are not comparable when mixes differ.`);
  out.push('', `Rates need ${MIN_SAMPLES}+ samples; "unknown" means nothing verified the result. Tokens are provider-reported counts, not subscription cost.`, 'Filter: /models stats [low|medium|high] [category words] · history: /feedback (reset clears it)');
  return out.join('\n');
}
