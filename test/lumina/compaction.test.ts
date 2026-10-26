import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { Compactor, MIN_TURNS, preservedContext } from '../../src/lumina/compaction.js';

const stages = (o: Record<string, unknown> = {}) => ConfigSchema.parse({ stages: o }).stages;
const big = { used: 200_000, window: 250_000 };
const turns = (c: Compactor, n: number, ctx = big) => { for (let i = 0; i < n; i++) c.turnDone(ctx); };

describe('compaction policy (only when it pays off, only at boundaries)', () => {
  it('short conversations are never compacted', () => {
    const c = new Compactor(stages(), async () => true);
    turns(c, MIN_TURNS - 1);
    expect(c.decide(big)).toEqual({ compact: false, reason: `short conversation (${MIN_TURNS - 1} turns since the last reset/compaction)` });
  });
  it('long conversation with a large, mostly full context: compact; small or roomy contexts: no', () => {
    const c = new Compactor(stages(), async () => true);
    turns(c, 8);
    expect(c.decide(big)).toEqual({ compact: true, reason: 'context 80% of the window after 8 turns' });
    expect(c.decide({ used: 30_000, window: 40_000 }).reason).toMatch(/too small to justify a summarization call/);
    expect(c.decide({ used: 100_000, window: 250_000 }).reason).toBe('context 40% of the window (threshold 70%)');
    expect(c.decide(undefined).reason).toMatch(/not reported/);
    expect(new Compactor(stages({ compaction_strategy: 'never' }), async () => true).decide(big).compact).toBe(false);
  });
  it('records before/after/duration/cost; repeated compaction is prevented until the conversation grows again', async () => {
    const c = new Compactor(stages(), async () => true, () => ({ totalTokens: 9000, inputTokens: 8000, cachedInputTokens: 0, outputTokens: 1000 }));
    turns(c, 8);
    const r = await c.run('turn boundary', big, 'context 80%');
    expect(r).toMatchObject({ ok: true, before: 200_000, window: 250_000, usage: { inputTokens: 8000, outputTokens: 1000 } });
    expect(c.decide(big).compact).toBe(false); // just compacted: turns reset
    c.turnDone({ used: 60_000, window: 250_000 });
    expect(c.records[0].after).toBe(60_000);
    const t = c.format().join('\n');
    expect(t).toContain('Compaction: 1 done · 1 turn since the last one');
    expect(t).toContain('✓ turn boundary · 200,000 tokens (80%) → 60,000 at the next turn (includes its new input)');
    expect(t).toContain('compaction cost: input 8,000, output 1,000 (provider-reported)');
    expect(t).not.toMatch(/sav(ed|ing)/i); // never reports savings
  });
  it('compaction failure: recorded, no retry for a few turns, cost "not reported"', async () => {
    const c = new Compactor(stages(), async () => false);
    turns(c, 8);
    const r = await c.run('turn boundary', big, 'x');
    expect(r.ok).toBe(false);
    expect(c.decide(big)).toEqual({ compact: false, reason: 'the last compaction failed recently' });
    turns(c, 3);
    expect(c.decide(big).compact).toBe(true);
    expect(c.format().join('\n')).toContain('✗ turn boundary · 200,000 tokens (80%) → next turn not measured yet');
    const thrown = new Compactor(stages(), async () => { throw new Error('server gone'); });
    turns(thrown, 8);
    expect((await thrown.run('stage boundary', big, 'x')).ok).toBe(false);
  });
});

describe('preserved critical context', () => {
  it('restates clarifications, decisions, changed files, pending work, failures, constraints and approvals; nothing when empty', () => {
    const b = preservedContext({
      ticket: { id: 'PRJ-12', mode: 'implementing', clarifications: ['use UTC for all timestamps', 'no soft delete'] },
      decisions: ['HEMS and Base share BaseCategory'], files: ['src/a.ts', 'src/b.ts'], pending: ['queued request: add tests'],
      failures: ['TypeScript (npm run typecheck): compilation error'], constraints: ['security-sensitive work: keep existing safeguards'], approval: 'smart mode',
    })!;
    expect(b).toMatch(/^\[Lumina preserved context after compaction — restated so it does not depend on the summary:/);
    for (const s of ['Ticket PRJ-12 (implementing); confirmed clarifications: 1. use UTC for all timestamps 2. no soft delete', 'Decisions the user stated this session (recorded notes; the code is authoritative): HEMS and Base share BaseCategory', 'Files changed in this conversation: src/a.ts, src/b.ts', 'Pending: queued request: add tests', 'Known verification failures: TypeScript', 'Constraints: security-sensitive work', 'Approvals: smart mode']) expect(b).toContain(s);
    expect(preservedContext({})).toBeUndefined();
    expect(preservedContext({ files: Array.from({ length: 400 }, (_, i) => `src/file${i}.ts`) }, 300)!.length).toBeLessThanOrEqual(300);
  });
});
