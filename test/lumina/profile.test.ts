import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { OutcomeRecord, RoutingFeedback } from '../../src/lumina/feedback.js';
import { MIN_SAMPLES, bandOf, formatProfile, parseFilter, stats } from '../../src/lumina/profile.js';

beforeEach(() => { process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-prof-')); });
const rec = (o: Partial<OutcomeRecord> = {}): OutcomeRecord => ({ at: 1, category: 'normal · standard implementation', tier: 'normal', complexity: 5, risk: 'low', model: 'gpt-6-luna', effort: 'medium', source: 'automatic routing', ms: 20_000, input: 10_000, cached: 8_000, output: 500, outcome: 'verified-success', repairs: 0, escalations: 0, switches: 0, ...o });
const times = <T>(k: number, f: (i: number) => T) => Array.from({ length: k }, (_, i) => f(i));
const name = (m: string) => ({ 'gpt-6-luna': 'Luna', 'gpt-6-sol': 'Sol' } as Record<string, string>)[m] ?? m;

describe('aggregation', () => {
  it('counts, verified success over verified/failed only, medians, escalation and repair rates', () => {
    const s = stats([...times(8, (i) => rec({ ms: (i + 1) * 1000, input: (i + 1) * 100 })), rec({ outcome: 'verified-failure', ms: 50_000, repairs: 1 }), rec({ outcome: 'failure', escalations: 1 }), rec({ outcome: 'unverified' })]);
    expect(s).toMatchObject({ n: 11, verifiedSuccess: 8, failed: 2, unknown: 1, successRate: 0.8, escalationRate: 1 / 11, repairRate: 1 / 11, timed: 11, usageReported: 11 });
    expect(s.medianMs).toBe(6000); // 1..8s, 20s ×2 (failure, unknown), 50s → sorted middle of 11 values
    expect(s.medianInput).toBe(600); // 100..800 and three 10,000s: middle of 11 values
  });
  it('missing metrics are not invented: untimed runs and unreported usage are excluded and counted', () => {
    const s = stats([rec({ ms: undefined, input: undefined, cached: undefined, output: undefined }), rec({ ms: 4000 })]);
    expect([s.medianMs, s.timed, s.usageReported, s.medianInput]).toEqual([4000, 1, 1, 10_000]);
    expect(stats([rec({ input: undefined, cached: undefined, output: undefined })]).medianInput).toBeUndefined();
    expect(formatProfile([rec({ input: undefined, cached: undefined, output: undefined, ms: undefined })])).toMatch(/Median duration: not recorded \(0 of 1 timed\)\n {2}Tokens: not reported/);
  });
  it('insufficient samples: counts shown, no rates', () => {
    const t = formatProfile(times(MIN_SAMPLES - 1, () => rec()), {}, name);
    expect(t).toContain('Verified success: insufficient samples (4 verified/failed, need 5)');
    expect(t).not.toMatch(/Escalated:/);
  });
  it('unknown outcomes never count as success: only unverified runs → no rate at all', () => {
    const t = formatProfile(times(10, () => rec({ outcome: 'unverified' })), {}, name);
    expect(t).toContain('Executions: 10 (0 verified success, 0 failed, 10 unknown — not verified)');
    expect(t).toContain('Verified success: insufficient samples (0 verified/failed, need 5)');
  });
});

describe('reporting', () => {
  const history = () => [
    ...times(10, () => rec({ model: 'gpt-6-luna', complexity: 2 })),
    ...times(2, () => rec({ model: 'gpt-6-luna', complexity: 2, outcome: 'failure' })),
    ...times(6, () => rec({ model: 'gpt-6-sol', effort: 'high', complexity: 8, ms: 45_000, category: 'critical · security-sensitive implementation' })),
    ...times(6, () => rec({ model: 'gpt-6-sol', effort: 'high', complexity: 2, ms: 30_000 })),
    rec({ model: 'gpt-6-luna', effort: 'high', complexity: 8, escalations: 1 }),
  ];
  it('per model, then per reasoning effort and complexity band; like-for-like comparison only within a band', () => {
    const t = formatProfile(history(), {}, name);
    expect(t).toMatch(/^Model Performance · 25 executions \(local history\)\n\nLuna:\n {2}Executions: 13 \(11 verified success, 2 failed, 0 unknown — not verified\)\n {2}Verified success: 85%\n {2}Median duration: 20s/);
    expect(t).toContain('    high reasoning · high complexity: 1 run · success insufficient samples');
    expect(t).toContain('    medium reasoning · low complexity: 12 runs · success 83%');
    expect(t).toMatch(/Sol:\n {2}Executions: 12[\s\S]*high reasoning · high complexity: 6 runs · success 100% · median 45s/);
    expect(t).toContain('Like-for-like (same complexity band, enough samples):\n  low complexity: Luna 83% (12 verified/failed), median 20s · Sol 100% (6 verified/failed), median 30s');
    expect(t).not.toMatch(/high complexity: Luna/); // Luna has too few high-complexity runs to compare
    expect(t).toContain('Task mix (low/medium/high complexity): Luna 12/0/1 · Sol 6/0/6 — overall rates are not comparable when mixes differ.');
    expect(t).toContain('Tokens are provider-reported counts, not subscription cost.');
  });
  it('filters by complexity band and category', () => {
    expect(parseFilter('high security')).toEqual({ band: 'high', category: 'security' });
    const t = formatProfile(history(), parseFilter('security'), name);
    expect(t).toMatch(/^Model Performance · category "security" · 6 executions/);
    expect(t).not.toContain('Luna:');
    expect(formatProfile(history(), parseFilter('medium'), name)).toContain('No recorded executions match this filter.');
    expect(bandOf(3)).toBe('low');
  });
  it('reads the routing-feedback history (no separate storage); cleanup via reset or the size bound', () => {
    const fb = new RoutingFeedback(ConfigSchema.parse({ feedback: { max_records: 50 } }).feedback);
    for (const r of times(120, () => rec())) fb.record(r);
    expect(fb.load().length).toBeLessThanOrEqual(75);
    expect(formatProfile(fb.load(), {}, name)).toMatch(/Luna:\n {2}Executions: \d+/);
    fb.reset();
    expect(formatProfile(fb.load(), {}, name)).toContain('No recorded executions yet.');
  });
});
