interface Item { type: string; text?: string; content?: { type: string; text?: string }[]; status?: string; exitCode?: number | null; commandActions?: { type: string }[]; changes?: unknown[] }
export interface HistoryTurn { status?: string; items: Item[] }
export interface Painter { accent(s: string): string; dim(s: string): string; ok(s: string): string; bad(s: string): string; warn(s: string): string }

const MAX_AGENT_LINES = 40;
const MAX_USER_LINES = 20;

type Kind = 'read' | 'search' | 'command' | 'edit' | 'tool' | 'web';
function kindOf(i: Item): Kind | undefined {
  switch (i.type) {
    case 'commandExecution': {
      const a = i.commandActions ?? [];
      if (a.length && a.every((x) => x.type === 'read')) return 'read';
      if (a.length && a.every((x) => x.type === 'search' || x.type === 'listFiles')) return 'search';
      return 'command';
    }
    case 'fileChange': return 'edit';
    case 'mcpToolCall': case 'dynamicToolCall': return 'tool';
    case 'webSearch': return 'web';
    default: return undefined;
  }
}
const SUMMARY = (k: Kind, n: number): string => {
  const s = n === 1 ? '' : 's';
  return { read: `Read ${n} file${s}`, search: `Searched ${n} time${s}`, command: `Ran ${n} command${s}`, edit: `Edited ${n} file${s}`, tool: `Used ${n} tool call${s}`, web: 'Searched the web' }[k];
};

const clip = (text: string, max: number, indent: string): string[] => {
  const lines = text.replace(/\r/g, '').trimEnd().split('\n');
  const out = lines.slice(0, max).map((l) => (l ? indent + l : ''));
  if (lines.length > max) out.push(`${indent}… ${lines.length - max} more lines`);
  return out;
};

/**
 * Renders a persisted conversation in the same shape as the live view (› prompt, ◆ Lumina, collapsed tool steps,
 * assistant text). Hidden reasoning is never shown. Only the last `maxTurns` turns are rendered.
 */
export function renderHistory(turns: HistoryTurn[], paint: Painter, maxTurns = 20): string {
  const shown = turns.slice(-maxTurns);
  const out: string[] = [];
  if (turns.length > shown.length) out.push(paint.dim(`… ${turns.length - shown.length} earlier turn${turns.length - shown.length === 1 ? '' : 's'} not shown`), '');
  for (const t of shown) {
    const user = t.items.filter((i) => i.type === 'userMessage').flatMap((i) => (i.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '')).join('\n');
    if (user.trim()) {
      const lines = user.replace(/\r/g, '').trimEnd().split('\n');
      out.push(...lines.slice(0, MAX_USER_LINES).map((l, i) => `${i === 0 ? '›' : ' '} ${l}`));
      if (lines.length > MAX_USER_LINES) out.push(paint.dim(`  … ${lines.length - MAX_USER_LINES} more lines`));
      out.push('');
    }
    out.push(`${paint.accent('◆')} Lumina`);
    let group: { kind: Kind; n: number } | undefined;
    const flush = () => { if (group?.n) out.push(`  ${paint.ok('✓')} ${SUMMARY(group.kind, group.n)}`); group = undefined; };
    for (const i of t.items) {
      const kind = kindOf(i);
      if (kind) {
        const failed = i.status === 'failed' || i.status === 'declined' || (typeof i.exitCode === 'number' && i.exitCode !== 0);
        if (failed) {
          flush();
          out.push(i.status === 'declined' ? `  ${paint.warn('!')} Action declined` : `  ${paint.bad('✗')} ${kind === 'edit' ? 'Edit' : kind === 'tool' ? 'Tool call' : 'Command'} failed${typeof i.exitCode === 'number' ? ` (exit ${i.exitCode})` : ''}`);
          continue;
        }
        if (group && group.kind !== kind) flush();
        group ??= { kind, n: 0 };
        group.n += kind === 'edit' ? Math.max(1, i.changes?.length ?? 1) : 1;
      } else if (i.type === 'agentMessage' && i.text?.trim()) {
        flush();
        out.push(...clip(i.text, MAX_AGENT_LINES, '  '));
      }
    }
    flush();
    if (t.status === 'interrupted') out.push(`  ${paint.warn('!')} Cancelled`);
    else if (t.status === 'failed') out.push(`  ${paint.bad('✗')} Failed`);
    out.push('');
  }
  return out.join('\n');
}
