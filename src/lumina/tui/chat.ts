import type { AppServerClient } from '../appserver/client.js';

export type AppClient = Pick<AppServerClient, 'request' | 'onNotification' | 'onClose' | 'onServerRequest' | 'close'>;
interface McpElicitation { threadId?: string; serverName: string; message: string; _meta?: { codex_approval_kind?: string; persist?: string[]; tool_params_display?: { name: string; display_name?: string; value: unknown }[] } | null; }
export type Decision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export interface ApprovalRequest { kind: 'command' | 'fileChange' | 'mcpTool'; summary: string; detail?: string; command?: string; server?: string; tool?: string; cwd?: string | null; network?: boolean; }
// approvalsReviewer 'user' is required: a user config with approvals_reviewer = auto_review would otherwise
// answer approvals server-side and they would never reach Lumina's prompt (verified against codex 0.162).
export interface Policy { approvalPolicy: 'on-request' | 'never'; sandbox: 'workspace-write' | 'read-only'; approvalsReviewer?: 'user'; }
export const DEFAULT_POLICY: Policy = { approvalPolicy: 'on-request', sandbox: 'workspace-write', approvalsReviewer: 'user' };
export interface Selection { model?: string; effort?: string; }
export interface ThreadSummary { id: string; preview: string; }
/** What a finished turn did, kept small: enough to hand off context and detect failures, no file contents. */
export interface TurnItem { type: string; status?: string; exitCode?: number | null; command?: string; files?: string[]; text?: string }
/** `usage` is the provider-reported usage of this turn alone (difference of the thread's cumulative counters). */
export interface TurnResult { status: 'completed' | 'interrupted' | 'failed'; error?: string; items?: TurnItem[]; usage?: TokenBreakdown }

/** One multi-turn conversation on a single App Server thread. Streams assistant text via onDelta. */
export class Chat {
  threadId?: string;
  model?: string;
  busy = false;
  /** Latest token usage reported by the App Server for the current thread (undefined until a turn reports it). */
  usage?: import('../usage.js').SessionUsage;
  private turnId?: string;
  private approvals = new Map<string, Promise<Decision>>();

  constructor(private client: AppClient, private readonly opts: { cwd: string; onDelta: (text: string) => void; onEvent?: (method: string, params: unknown) => void; onApproval?: (r: ApprovalRequest) => Promise<Decision>; policy?: Policy }) {
    this.attach(client);
  }

  /** (Re)binds to an App Server client, e.g. after a reconnect. */
  attach(client: AppClient): void {
    this.client = client;
    client.onServerRequest((method, params) => this.onServerRequest(method, params));
  }

  /** Approval requests for this thread go to the UI; anything else, or no UI, is declined (safe default). */
  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    const p = params as { threadId?: string; itemId?: string; approvalId?: string | null; networkApprovalContext?: unknown; command?: string | null; cwd?: string | null; reason?: string | null; grantRoot?: string | null };
    if (p?.threadId !== this.threadId && (!this.activeThread || p?.threadId !== this.activeThread)) throw new Error('Request for an unknown conversation');
    if (method === 'mcpServer/elicitation/request') return this.onMcpElicitation(params as McpElicitation);
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') throw new Error(`Unsupported request: ${method}`);
    const command = method === 'item/commandExecution/requestApproval';
    const detail = [p.cwd && command ? `in ${p.cwd}` : '', p.grantRoot ? `grants write access to ${p.grantRoot}` : '', p.reason ?? ''].filter(Boolean).join(' · ');
    const ask = (): Promise<Decision> => this.opts.onApproval
      ? this.opts.onApproval({ kind: command ? 'command' : 'fileChange', summary: command ? (p.command ?? 'command') : 'apply file changes', detail, command: command ? (p.command ?? undefined) : undefined, cwd: p.cwd, network: Boolean(p.networkApprovalContext) })
      : Promise.resolve('decline');
    // A repeated request for the same item gets the same answer, never a second prompt or response.
    const key = p.itemId ? `${method}:${p.itemId}:${p.approvalId ?? ''}` : '';
    let pending = key ? this.approvals.get(key) : undefined;
    if (!pending) { pending = ask(); if (key) this.approvals.set(key, pending); }
    const decision = await pending;
    return { decision };
  }

  /**
   * MCP tool-call approvals arrive as elicitations tagged `codex_approval_kind: mcp_tool_call`. They always go to the user
   * (never auto-approved: tools may write to external systems). Any other elicitation (forms, URLs) is unsupported → error.
   */
  private async onMcpElicitation(p: McpElicitation): Promise<unknown> {
    if (p._meta?.codex_approval_kind !== 'mcp_tool_call') throw new Error('Unsupported MCP elicitation');
    const tool = /tool "([^"]+)"/.exec(p.message)?.[1] ?? 'tool';
    const args = (p._meta.tool_params_display ?? []).map((d) => `${d.display_name ?? d.name}=${String(d.value).replace(/\s+/g, ' ').slice(0, 60)}`).join(', ');
    const decision = this.opts.onApproval
      ? await this.opts.onApproval({ kind: 'mcpTool', summary: `${p.serverName} › ${tool}`, detail: args.slice(0, 200), server: p.serverName, tool })
      : 'decline';
    const action = decision === 'accept' || decision === 'acceptForSession' ? 'accept' : decision === 'cancel' ? 'cancel' : 'decline';
    // "for session" asks Codex to remember the approval (one of the persist modes offered in _meta)
    const meta = decision === 'acceptForSession' && p._meta.persist?.includes('session') ? { persist: 'session' } : null;
    return { action, content: null, _meta: meta };
  }

  /** Interrupts the running turn. Resolves false when no turn is active. */
  async interrupt(): Promise<boolean> {
    const thread = this.activeThread ?? this.threadId;
    if (!this.busy || !thread || !this.turnId) return false;
    await this.client.request('turn/interrupt', { threadId: thread, turnId: this.turnId });
    return true;
  }

  private async ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId;
    const res = await this.client.request<{ thread: { id: string }; model: string }>('thread/start', {
      cwd: this.opts.cwd, ...(this.opts.policy ?? DEFAULT_POLICY),
    });
    this.model = res.model;
    return (this.threadId = res.thread.id);
  }

  /** Starts a fresh conversation on the next send (/new). */
  reset(): void {
    if (this.busy) throw new Error('A turn is running');
    this.threadId = undefined;
    this.usage = undefined;
  }

  /** Recent threads for this cwd, newest first. Codex persists them; nothing is stored by Lumina. */
  async list(limit = 10): Promise<ThreadSummary[]> {
    const res = await this.client.request<{ data: { id: string; preview?: string; name?: string | null }[] }>('thread/list', {
      cwd: this.opts.cwd, limit, sortKey: 'updated_at',
    });
    return res.data.map((t) => ({ id: t.id, preview: (t.name || t.preview || '').replace(/\s+/g, ' ').slice(0, 60) }));
  }

  /** Persisted turns of a thread (server-side read, no model call). Empty when unavailable. */
  async readTurns(id: string): Promise<import('./history.js').HistoryTurn[]> {
    const res = await this.client.request<{ thread?: { turns?: import('./history.js').HistoryTurn[] } }>('thread/read', { threadId: id, includeTurns: true });
    return res?.thread?.turns ?? [];
  }

  /** Re-attaches to a persisted thread; the server restores the full conversation context. */
  async resume(id: string): Promise<void> {
    if (this.busy) throw new Error('A turn is running');
    const res = await this.client.request<{ thread: { id: string }; model: string }>('thread/resume', {
      threadId: id, cwd: this.opts.cwd, ...(this.opts.policy ?? DEFAULT_POLICY), excludeTurns: true,
    });
    this.threadId = res.thread.id;
    this.model = res.model;
    this.usage = undefined;
  }

  /** Context carried into the next main-thread turn (e.g. results of a stage that ran on an isolated thread). */
  private carry?: string;
  queueContext(note: string): void { this.carry = this.carry ? `${this.carry}\n${note}` : note; }

  /** Thread of the turn currently running (main or isolated); approvals and interrupts target it. */
  private activeThread?: string;
  /** Last cumulative usage per thread, so a turn's own usage is the difference (no double counting). */
  private totals = new Map<string, TokenBreakdown>();

  /** Main-thread context size from the last provider report (tokens of the last request), if known. */
  contextTokens(): { used: number; window: number | null } | undefined {
    return this.usage?.last ? { used: this.usage.last.totalTokens, window: this.usage.modelContextWindow } : undefined;
  }

  /** Asks Codex to compact the main thread and waits for `thread/compacted` (bounded). Returns false when it did not happen. */
  async compact(timeoutMs = 120000): Promise<boolean> {
    const id = this.threadId;
    if (!id || this.busy) return false;
    this.busy = true;
    let off: (() => void) | undefined;
    try {
      const done = new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(false), timeoutMs);
        t.unref?.();
        off = this.client.onNotification((m, p) => { if (m === 'thread/compacted' && (p as { threadId?: string }).threadId === id) { clearTimeout(t); resolve(true); } });
      });
      await this.client.request('thread/compact/start', { threadId: id });
      return await done;
    } finally { off?.(); this.busy = false; }
  }

  /**
   * Runs one turn. `isolated` starts a fresh, ephemeral thread (same cwd, sandbox and approval policy) so the turn does
   * not carry the main conversation's history; the main thread is left untouched.
   */
  async send(text: string, sel: Selection = {}, skills: { name: string; path: string }[] = [], opts: { isolated?: boolean } = {}): Promise<TurnResult> {
    if (this.busy) throw new Error('A turn is already running');
    this.busy = true;
    let off: (() => void) | undefined;
    try {
      const threadId = opts.isolated
        ? (await this.client.request<{ thread: { id: string } }>('thread/start', { cwd: this.opts.cwd, ...(this.opts.policy ?? DEFAULT_POLICY), ephemeral: true })).thread.id
        : await this.ensureThread();
      this.activeThread = threadId;
      const before = this.totals.get(threadId);
      if (!opts.isolated && this.carry) { text = `${this.carry}\n\n${text}`; this.carry = undefined; }
      const done = new Promise<TurnResult>((resolve) => {
        let lastError: string | undefined;
        let total: TokenBreakdown | undefined;
        const items: TurnItem[] = [];
        this.client.onClose((e) => resolve({ status: 'failed', error: e.message }));
        off = this.client.onNotification((method, params) => {
          const p = params as { item?: { type: string; status?: string; exitCode?: number | null; command?: string; changes?: { path?: string }[]; text?: string }; threadId?: string; delta?: string; error?: { message?: string }; willRetry?: boolean; turn?: { id?: string; status: TurnResult['status']; error?: { message?: string } | null } };
          if (p?.threadId !== threadId) return;
          this.opts.onEvent?.(method, params);
          if (method === 'item/agentMessage/delta' && p.delta) this.opts.onDelta(p.delta);
          else if (method === 'error' && !p.willRetry) lastError = p.error?.message;
          else if (method === 'thread/tokenUsage/updated') {
            const u = (params as { tokenUsage: import('../usage.js').SessionUsage }).tokenUsage;
            total = u.total as TokenBreakdown;
            this.totals.set(threadId, total);
            if (!opts.isolated) this.usage = u;
          }
          else if (method === 'turn/started' && p.turn?.id) this.turnId = p.turn.id;
          else if (method === 'item/completed' && p.item) {
            const it = p.item;
            items.push({ type: it.type, status: it.status, exitCode: it.exitCode, command: it.command?.slice(0, 300), files: it.changes?.map((c) => c.path ?? '').filter(Boolean), text: it.type === 'agentMessage' ? it.text?.slice(-2000) : undefined });
          }
          else if (method === 'turn/completed' && p.turn) resolve({ status: p.turn.status, error: p.turn.error?.message ?? lastError, items, usage: total ? diffUsage(total, before) : undefined });
        });
      });
      const started = await this.client.request<{ turn?: { id?: string } }>('turn/start', {
        // explicit `$skill` invocations are passed to Codex as native skill items; Codex loads the SKILL.md itself
        threadId, input: [{ type: 'text', text, text_elements: [] }, ...skills.map((k) => ({ type: 'skill', name: k.name, path: k.path }))],
        ...(sel.model ? { model: sel.model } : {}), ...(sel.effort ? { effort: sel.effort } : {}),
      });
      this.turnId ??= started?.turn?.id;
      return await done;
    } finally {
      this.turnId = undefined;
      this.activeThread = undefined;
      this.approvals.clear();
      off?.();
      this.busy = false;
    }
  }
}

export interface TokenBreakdown { totalTokens: number; inputTokens: number; cachedInputTokens: number; outputTokens: number }
const diffUsage = (now: TokenBreakdown, before?: TokenBreakdown): TokenBreakdown => ({
  totalTokens: now.totalTokens - (before?.totalTokens ?? 0), inputTokens: now.inputTokens - (before?.inputTokens ?? 0),
  cachedInputTokens: now.cachedInputTokens - (before?.cachedInputTokens ?? 0), outputTokens: now.outputTokens - (before?.outputTokens ?? 0),
});
