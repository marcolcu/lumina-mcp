import fs from 'node:fs';
import path from 'node:path';
import type { RouterConfig } from '../smart-codex/config.js';
import { stateDir } from '../smart-codex/config.js';
import { ModelInfo, resolveModel } from '../smart-codex/models.js';
import type { Route } from '../smart-codex/router.js';
import type { ExecutionRecord } from './diagnostics.js';
import { raiseEffort } from './stages.js';

/**
 * Routing feedback loop: a bounded local history of execution outcomes (no prompts, no code) grouped by task category,
 * and a deterministic, conservative adjustment of future routes when — and only when — enough verified evidence
 * supports it. One step at a time (one reasoning level, or one model tier up), never lowering anything for
 * security-sensitive or high-risk work, never applied over user overrides. No model calls; no training.
 */
export type Outcome = 'verified-success' | 'verified-failure' | 'failure' | 'unverified' | 'cancelled';
export interface OutcomeRecord {
  at: number; category: string; tier: string; complexity: number; risk: string; model: string; effort: string; source: string;
  ms?: number; input?: number; cached?: number; output?: number;
  outcome: Outcome; repairs: number; escalations: number; switches: number;
}
type Cfg = RouterConfig['feedback'];

const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const TIER_ORDER = ['fast', 'normal', 'hard', 'critical'] as const;

/** Category: router tier + the reasoning class (e.g. "normal · standard implementation"). Stable and prompt-free. */
export function categoryOf(route: Pick<Route, 'tier' | 'reasoning_reason'>): string {
  const why = (route.reasoning_reason ?? '').split(';')[0].replace(/\(.*?\)/g, '').replace(/^explicitly requested.*$/, 'override').trim().toLowerCase().slice(0, 60);
  return `${route.tier} · ${why || 'unclassified'}`;
}

/**
 * Verified success needs passing checks after the change (repairs allowed, recorded separately); a completed turn
 * without checks is only model-reported. Failures are unresolved verification or a failed turn.
 */
export function outcomeOf(r: ExecutionRecord): Outcome {
  if (r.status === 'cancelled') return 'cancelled';
  const checks = r.verification?.checks ?? [];
  const ran = Boolean(r.verification && !r.verification.declined && r.verification.level !== 'off' && checks.some((c) => c.status !== 'skipped'));
  if (r.status === 'failed') return ran && r.failure?.operation === 'verification' ? 'verified-failure' : 'failure';
  return ran ? 'verified-success' : 'unverified';
}

export function recordFrom(r: ExecutionRecord, category: string): OutcomeRecord | undefined {
  if (!r.routing) return undefined;
  return {
    at: r.at, category, tier: r.routing.tier, complexity: r.routing.complexity, risk: r.routing.risk, model: r.routing.model, effort: r.routing.effort, source: r.routing.source,
    ms: r.ms, input: r.usage?.inputTokens, cached: r.usage?.cachedInputTokens, output: r.usage?.outputTokens,
    outcome: outcomeOf(r), repairs: r.healing?.attempts ?? 0, escalations: r.escalations + (r.healing?.escalations ?? 0), switches: r.switches,
  };
}

const needsHelp = (o: OutcomeRecord) => o.outcome === 'failure' || o.outcome === 'verified-failure' || o.repairs > 0 || o.escalations > 0;
const decisive = (o: OutcomeRecord) => o.outcome === 'verified-success' || o.outcome === 'verified-failure' || o.outcome === 'failure';

export class RoutingFeedback {
  readonly file: string;
  /** Session switch for influence (/feedback off); recording continues. */
  influence: boolean;
  recovered = 0; // unreadable lines skipped on load

  constructor(private readonly cfg: Cfg, file = path.join(stateDir(), 'feedback.jsonl')) { this.file = file; this.influence = cfg.influence; }

  load(): OutcomeRecord[] {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const out: OutcomeRecord[] = [];
    let bad = 0;
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      try {
        const o = JSON.parse(l) as OutcomeRecord;
        if (typeof o.category === 'string' && typeof o.model === 'string' && typeof o.effort === 'string' && typeof o.outcome === 'string' && typeof o.at === 'number') out.push(o); else bad++;
      } catch { bad++; }
    }
    this.recovered = bad;
    return out;
  }

  record(o: OutcomeRecord | undefined): void {
    if (!this.cfg.enabled || !o || o.outcome === 'cancelled') return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      fs.appendFileSync(this.file, `${JSON.stringify(o)}\n`, { mode: 0o600 });
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      if (lines.length > this.cfg.max_records * 1.5) { fs.writeFileSync(`${this.file}.tmp`, `${lines.slice(-this.cfg.max_records).join('\n')}\n`, { mode: 0o600 }); fs.renameSync(`${this.file}.tmp`, this.file); }
    } catch { /* feedback must never break execution */ }
  }

  reset(): number { const n = this.load().length; try { fs.rmSync(this.file, { force: true }); } catch { /* none */ } return n; }

  /**
   * A one-step adjustment of the deterministic route, or undefined. Evidence = the most recent decisive (verified or
   * failed) outcomes of this category on the same model and effort; model-reported successes never count as proof.
   */
  advise(route: Route, models: Record<string, string>, catalog: ModelInfo[]): { model: string; effort: string; change: string; evidence: string } | undefined {
    if (!this.cfg.enabled || !this.influence) return undefined;
    const category = categoryOf(route);
    if (category.endsWith('override')) return undefined;
    const all = this.load().filter((o) => o.category === category).slice(-this.cfg.window);
    const at = (model: string, effort: string) => all.filter((o) => o.model === model && o.effort === effort && decisive(o));
    const here = at(route.model, route.reasoning_effort);
    const min = this.cfg.min_evidence;
    if (here.length < min) return undefined; // sparse: deterministic routing stands
    const help = here.filter(needsHelp).length;
    const rate = help / here.length;
    const ok = (m: string, e: string) => { const r = resolveModel(catalog, m, e, false); return r.model === m && r.effort === e && !r.note; };
    const ev = (xs: OutcomeRecord[], h: number, what: string) => `${h} of ${xs.length} verified/failed runs ${what} (category "${category}", ${route.model}/${route.reasoning_effort}, since ${new Date(xs[0].at).toISOString().slice(0, 10)})`;
    if (rate >= 0.5) {
      // runs here keep needing repairs/escalations: start where they ended up, one step only
      const escalated = here.filter((o) => o.escalations > 0 && o.outcome === 'verified-success').length;
      const tierIdx = TIER_ORDER.indexOf(route.tier as typeof TIER_ORDER[number]);
      const stronger = tierIdx >= 0 && tierIdx < TIER_ORDER.length - 1 ? models[TIER_ORDER[tierIdx + 1]] : undefined;
      if (escalated / here.length >= 0.5 && stronger && stronger !== route.model && ok(stronger, route.reasoning_effort)) {
        return { model: stronger, effort: route.reasoning_effort, change: `model ${route.model} → ${stronger}`, evidence: ev(here, escalated, 'only succeeded after escalating to a stronger model') };
      }
      const up = raiseEffort(route.reasoning_effort, EFFORTS.indexOf(route.reasoning_effort) >= 2 ? 'xhigh' : 'high');
      if (up !== route.reasoning_effort && ok(route.model, up)) return { model: route.model, effort: up, change: `reasoning ${route.reasoning_effort} → ${up}`, evidence: ev(here, help, 'needed repairs, escalation or failed') };
      return undefined; // nothing stronger available: deterministic route stands
    }
    // lower cost only for low-risk work, only with verified evidence AT the lower level too, never below "low"
    if (rate === 0 && route.risk === 'low' && route.tier !== 'critical') {
      const i = EFFORTS.indexOf(route.reasoning_effort);
      const down = i > 0 ? EFFORTS[i - 1] : undefined;
      const there = down ? at(route.model, down) : [];
      if (down && there.length >= Math.ceil(min / 2) && there.filter(needsHelp).length / there.length <= 0.1 && ok(route.model, down)) {
        return { model: route.model, effort: down, change: `reasoning ${route.reasoning_effort} → ${down}`, evidence: `${there.length - there.filter(needsHelp).length} of ${there.length} verified runs at ${down} succeeded without help, and ${here.length} of ${here.length} at ${route.reasoning_effort} (category "${category}")` };
      }
    }
    return undefined; // mixed or good-as-is: no change
  }

  /** /feedback: per-category outcome counts (bounded window), nothing else. */
  format(): string {
    const all = this.load();
    if (!all.length) return `Routing feedback: no recorded outcomes yet.${this.recovered ? ` (${this.recovered} unreadable lines skipped)` : ''}\nOutcomes are recorded after each request; routes change only with ${this.cfg.min_evidence}+ verified runs in a category.`;
    const cats = new Map<string, OutcomeRecord[]>();
    for (const o of all) cats.set(o.category, [...(cats.get(o.category) ?? []), o]);
    const out = [`Routing feedback · ${all.length} outcomes · influence ${this.cfg.enabled && this.influence ? 'on' : 'off'} · evidence needed: ${this.cfg.min_evidence} verified runs`];
    for (const [c, xs0] of [...cats].sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
      const xs = xs0.slice(-this.cfg.window);
      const by = new Map<string, OutcomeRecord[]>();
      for (const o of xs) by.set(`${o.model}/${o.effort}`, [...(by.get(`${o.model}/${o.effort}`) ?? []), o]);
      out.push('', c);
      for (const [k, ys] of by) {
        const vs = ys.filter((o) => o.outcome === 'verified-success').length;
        const vf = ys.filter((o) => o.outcome === 'verified-failure' || o.outcome === 'failure').length;
        const un = ys.filter((o) => o.outcome === 'unverified').length;
        out.push(`  ${k}: ${vs} verified success, ${vf} failed, ${un} unverified · ${ys.filter((o) => o.repairs > 0).length} needed repair, ${ys.filter((o) => o.escalations > 0).length} escalated`);
      }
    }
    if (this.recovered) out.push('', `${this.recovered} unreadable lines skipped`);
    out.push('', '/feedback reset · /feedback off|on (this session) · feedback.influence in the config');
    return out.join('\n');
  }
}
