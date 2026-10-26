import { describe, expect, it } from 'vitest';
import { ContextMetrics, RequestMetrics, filesRead } from '../../src/lumina/metrics.js';
import type { Retrieval } from '../../src/lumina/retrieval.js';

const retrieval = (o: Partial<Retrieval> = {}): Retrieval => ({
  ms: 18,
  hints: [{ path: 'src/services/orders.ts', score: 5, symbols: [] }, { path: 'src/hooks/useOrders.ts', score: 3, symbols: [] }],
  block: '[Lumina context hints: …]\n- src/services/orders.ts — listOrders (L2)\n- src/hooks/useOrders.ts',
  stats: { indexedFiles: 486, candidates: 12, mapAgeMs: 180_000, mapCached: true, listCache: 'hit', symbolHits: 3, symbolMisses: 1 },
  ...o,
});
const req = (o: Partial<RequestMetrics> = {}): RequestMetrics => ({
  at: 1, retrieval: retrieval(), skills: { names: [], mode: 'none' }, model: 'GPT-6 Luna', effort: 'medium', stages: 1, switches: 0,
  usage: { totalTokens: 83700, inputTokens: 82500, cachedInputTokens: 70000, outputTokens: 1200 }, filesRead: ['src/services/orders.ts', 'src/lib/http.ts', 'README.md'], status: 'completed', ...o,
});

describe('context metrics', () => {
  it('/context: repository, retrieval, skills and provider-reported usage, estimates labelled', () => {
    const m = new ContextMetrics();
    m.record(req({ skills: { names: ['security-review'], mode: 'auto' } }));
    const t = m.format();
    expect(t).toContain('Indexed files: 486 · map 3m old (cached)');
    expect(t).toContain('Candidate files: 12 · Selected: 2');
    expect(t).toContain('Files read by Codex: 3 (1 of them hinted)');
    expect(t).toContain('Duration: 18ms');
    expect(t).toContain('Cache: file list hit · symbols 3 hit / 1 miss');
    expect(t).toMatch(/Hint size: \d+ chars ≈ \d+ tokens \(estimate\)/);
    expect(t).toContain('Skills: $security-review (auto)');
    expect(t).toContain('Model Usage (provider-reported):');
    expect(t).toContain('Input: 82,500 tokens · Cached: 70,000 · Output: 1,200');
    expect(t).toContain('Savings are not inferred');
    expect(t).not.toMatch(/sav(ed|ing)s? \d/i); // never a savings figure
  });
  it('session totals add up provider-reported usage exactly; requests without usage are counted as unavailable', () => {
    const m = new ContextMetrics();
    m.record(req());
    m.record(req({ usage: { totalTokens: 10, inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 } }));
    m.record(req({ usage: undefined }));
    const t = m.format();
    expect(t).toContain('Tokens: unavailable (Codex did not report usage for this request)');
    expect(t).toContain('Session: 3 requests · input 82,507 · cached 70,002 · output 1,203 (1 without reported usage)');
    m.reset();
    expect(m.format()).toContain('No request has finished');
  });
  it('retrieval failure, skipped or absent retrieval are shown as such (no invented numbers)', () => {
    const m = new ContextMetrics();
    m.record(req({ retrieval: { hints: [], ms: 3, skipped: 'failed: boom', stats: { symbolHits: 0, symbolMisses: 0 } } }));
    let t = m.format();
    expect(t).toContain('Indexed files: unavailable');
    expect(t).toContain('Candidate files: unavailable · Selected: 0');
    expect(t).toContain('Duration: 3ms · skipped: failed: boom');
    expect(t).toContain('Hint size: none sent');
    m.record(req({ retrieval: undefined }));
    t = m.format();
    expect(t).toContain('not run for this request');
  });
  it('per-request summary line', () => {
    const m = new ContextMetrics();
    expect(m.summary(req())).toBe('context: 2 hinted · 3 read · in 82,500 (cached 70,000) out 1,200 · retrieval 18ms');
    expect(m.summary(req({ usage: undefined, retrieval: undefined }))).toBe('context: 3 read · tokens unavailable');
  });
  it('log entries carry numbers only: no paths, prompt text, code or skill names', () => {
    const m = new ContextMetrics();
    const e = m.logEntry(req({ skills: { names: ['secret-skill-name'], mode: 'auto' } }));
    const s = JSON.stringify(e);
    for (const bad of ['orders', 'http.ts', 'README', 'listOrders', 'Lumina context hints', 'secret-skill-name']) expect(s).not.toContain(bad);
    expect(e).toMatchObject({ event: 'context_metrics', files_read: 3, selected_files: 2, candidate_files: 12, list_cache: 'hit', usage_reported: true, input_tokens: 82500, cached_input_tokens: 70000, output_tokens: 1200, skills_selected: 1 });
    expect(m.logEntry(req({ usage: undefined }))).toMatchObject({ usage_reported: false, input_tokens: null });
  });
  it('disabled: nothing recorded', () => {
    const m = new ContextMetrics(false);
    m.record(req());
    expect(m.last).toBeUndefined();
    expect(m.format()).toMatch(/disabled/);
  });
  it('files read: distinct, repository-relative; outside paths kept absolute', () => {
    expect(filesRead([{ type: 'commandExecution', reads: ['/r/src/a.ts', '/r/src/a.ts', 'src/b.ts'] }, { type: 'commandExecution', reads: ['/etc/hosts'] }, { type: 'agentMessage' }], '/r')).toEqual(['src/a.ts', 'src/b.ts', '/etc/hosts']);
  });
});
