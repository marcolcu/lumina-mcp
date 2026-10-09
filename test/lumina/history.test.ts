import { describe, expect, it } from 'vitest';
import { renderHistory } from '../../src/lumina/tui/history.js';

const plain = { accent: (s: string) => s, dim: (s: string) => s, ok: (s: string) => s, bad: (s: string) => s, warn: (s: string) => s };
const user = (text: string) => ({ type: 'userMessage', content: [{ type: 'text', text }] });
const agent = (text: string) => ({ type: 'agentMessage', text });

describe('renderHistory', () => {
  it('renders prompts, collapsed tool steps and answers in the live format; hides reasoning', () => {
    const out = renderHistory([{ status: 'completed', items: [user('hello'), { type: 'reasoning' }, { type: 'fileChange', changes: [{}, {}], status: 'completed' }, { type: 'fileChange', changes: [{}], status: 'completed' }, { type: 'mcpToolCall', status: 'completed' }, agent('all done')] }], plain);
    expect(out).toBe('› hello\n\n◆ Lumina\n  ✓ Edited 3 files\n  ✓ Used 1 tool call\n  all done\n');
  });
  it('keeps failures, declines and interrupted/failed turns visible', () => {
    const out = renderHistory([
      { status: 'interrupted', items: [user('a'), { type: 'commandExecution', status: 'failed', exitCode: 2, commandActions: [] }, { type: 'commandExecution', status: 'declined', commandActions: [] }] },
      { status: 'failed', items: [user('b')] },
    ], plain);
    expect(out).toContain('✗ Command failed (exit 2)');
    expect(out).toContain('! Action declined');
    expect(out).toContain('! Cancelled');
    expect(out).toContain('✗ Failed');
  });
  it('shows only the last N turns and says how many were skipped', () => {
    const turns = Array.from({ length: 5 }, (_, i) => ({ status: 'completed', items: [user(`q${i}`), agent(`a${i}`)] }));
    const out = renderHistory(turns, plain, 2);
    expect(out).toContain('… 3 earlier turns not shown');
    expect(out).not.toContain('q2');
    expect(out).toContain('q3');
    expect(out).toContain('a4');
  });
  it('clips very long messages and preserves multi-line prompts and indentation', () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const out = renderHistory([{ status: 'completed', items: [user('first\n  indented\nthird'), agent(long)] }], plain);
    expect(out).toContain('› first\n    indented\n  third');
    expect(out).toContain('… 60 more lines');
    expect(out).not.toContain('line 99');
  });
  it('handles an empty history', () => { expect(renderHistory([], plain)).toBe(''); });
});
