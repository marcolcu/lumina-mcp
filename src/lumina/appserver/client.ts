import { ChildProcess, spawn } from 'node:child_process';
import readline from 'node:readline';

export type Json = unknown;
export type NotificationHandler = (method: string, params: Json) => void;
/** Handles a server→client request (e.g. approvals). Return the result; throw to send a JSON-RPC error. */
export type ServerRequestHandler = (method: string, params: Json) => Promise<Json> | Json;

export interface AppServerOptions {
  bin?: string;
  args?: string[];
  cwd?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string; }

/**
 * Minimal client for `codex app-server` (stdio, newline-delimited JSON-RPC without the "jsonrpc" field).
 * Auth comes from the existing Codex login; nothing here touches ~/.codex.
 */
export class AppServerClient {
  private proc?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<NotificationHandler>();
  private closeHandlers = new Set<(err: Error) => void>();
  private serverRequestHandler?: ServerRequestHandler;
  private stderrTail = '';
  private exited?: Promise<number | null>;
  info?: { userAgent: string; codexHome: string; platformOs: string };

  constructor(private readonly opts: AppServerOptions = {}) {}

  /** Spawns the server and performs the initialize / initialized handshake. */
  async start(): Promise<NonNullable<AppServerClient['info']>> {
    if (this.proc) throw new Error('App server already started');
    const proc = spawn(this.opts.bin ?? 'codex', this.opts.args ?? ['app-server'], { cwd: this.opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); // own process group: lets us reap tool processes it started
    this.proc = proc;
    process.once('exit', this.killGroup);
    this.exited = new Promise((res) => proc.once('close', (code) => { this.failAll(new Error(`App server exited (code ${code}). ${this.stderrTail.trim()}`)); res(code); }));
    proc.once('error', (e) => this.failAll(e));
    proc.stdin?.on('error', () => undefined); // EPIPE after exit surfaces via pending rejections
    proc.stderr?.on('data', (d: Buffer) => { this.stderrTail = (this.stderrTail + d.toString()).slice(-2000); });
    readline.createInterface({ input: proc.stdout! }).on('line', (line) => this.onLine(line));

    this.info = await this.request('initialize', {
      clientInfo: { name: 'lumina', title: 'Lumina', version: this.opts.clientVersion ?? '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    }) as NonNullable<AppServerClient['info']>;
    this.write({ method: 'initialized' });
    return this.info;
  }

  request<T = unknown>(method: string, params: Json = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.proc || this.proc.exitCode !== null || !this.proc.stdin?.writable) return reject(new Error('App server is not running'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Request ${method} timed out`)); }, this.opts.requestTimeoutMs ?? 30000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.write({ id, method, params });
    });
  }

  /** Subscribes to all server notifications. Returns an unsubscribe function. */
  onNotification(handler: NotificationHandler): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /** Called once if the server process exits (expectedly or not). */
  onClose(handler: (err: Error) => void): void {
    this.closeHandlers.add(handler);
  }

  /** Registers the single handler for server requests. Without one, they are rejected (safe default). */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  /** Closes stdin (graceful), then SIGTERM, then SIGKILL. Resolves with the exit code. */
  async close(graceMs = 2000): Promise<number | null> {
    const proc = this.proc;
    if (!proc || !this.exited) return null;
    proc.stdin?.end();
    const wait = (ms: number) => Promise.race([this.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms).unref())]);
    let r = await wait(graceMs);
    if (r === 'timeout') { proc.kill('SIGTERM'); r = await wait(graceMs); }
    if (r === 'timeout') { proc.kill('SIGKILL'); r = await wait(graceMs); }
    this.killGroup(); // reap stragglers (e.g. a command the model started) so nothing is left running
    process.off('exit', this.killGroup);
    return r === 'timeout' ? null : (r ?? null);
  }

  /** Kills the server's whole process group (it, its MCP servers and any shell commands still running). */
  private readonly killGroup = (): void => {
    const pid = this.proc?.pid;
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  };

  private write(msg: object): void {
    this.proc?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    let msg: { id?: number | string; method?: string; params?: Json; result?: unknown; error?: { message?: string; code?: number } };
    try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON noise
    if (msg.method !== undefined && msg.id !== undefined) { void this.answerServerRequest(msg.id, msg.method, msg.params); return; }
    if (msg.method !== undefined) { for (const l of [...this.listeners]) { try { l(msg.method, msg.params); } catch { /* listener errors must not kill the stream */ } } return; }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? 'error'} (${msg.error.code ?? '?'})`));
    else p.resolve(msg.result);
  }

  private async answerServerRequest(id: number | string, method: string, params: Json): Promise<void> {
    if (!this.serverRequestHandler) return this.write({ id, error: { code: -32601, message: `Unhandled server request: ${method}` } });
    try { this.write({ id, result: await this.serverRequestHandler(method, params) }); }
    catch (e) { this.write({ id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }); }
  }

  private failAll(err: Error): void {
    for (const h of this.closeHandlers) h(err);
    this.closeHandlers.clear();
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(err); this.pending.delete(id); }
  }
}
