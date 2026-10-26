import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { AppServerClient } from '../appserver/client.js';
import { loadConfig } from '../../smart-codex/config.js';
import { ApprovalMode, MODES, evaluate, evaluateMcp, unwrap } from '../approval/policy.js';
import { fetchUsage, formatUsage } from '../usage.js';
import { Activity } from './activity.js';
import { renderHistory } from './history.js';
import { TicketSession, readingSelection } from '../ticket.js';
import { splitPrompt } from '../../smart-codex/router.js';
import { ExecutionPlan, RoutingLog, Stage, StagedExecution, logRouting, planExecution } from '../stages.js';
import { Composer } from './composer.js';
import { Screen } from './screen.js';
import { AppClient, ApprovalRequest, Chat, DEFAULT_POLICY, Decision, Policy, ThreadSummary } from './chat.js';
import { TurnRouter } from './routing.js';
import { CommandPalette, commandNames, helpText } from './commands.js';
import { copyToClipboard } from './clipboard.js';
import { imagePathFromPaste, readClipboardImage } from './images.js';
import { SessionPicker } from './sessions.js';
import { DiffViewer } from './diffview.js';
import { listChanges, fileDiff } from '../diff.js';
import { CheckpointStore, Manifest } from '../checkpoints.js';
import { RepoMap, formatRepoMap, repoMap } from '../repomap.js';
import { Retrieval, Retriever } from '../retrieval.js';
import { ContextMetrics, RequestMetrics, filesRead } from '../metrics.js';
import { Change, Level, Verification, Verifier, failureContext, formatFooter, formatHeader, formatResult } from '../verify.js';
import { errorLocations, healClass, selfHeal } from '../heal.js';
import { ProjectMemory, formatEntry, formatLine } from '../memory.js';
import { DependencyGraph, formatGraph } from '../graph.js';
import { analyzeChanges, formatImpact, predictImpact } from '../impact.js';
import { checkContracts, formatContracts } from '../apicontract.js';
import { Workspace } from '../workspace.js';
import { RoutingFeedback, recordFrom } from '../feedback.js';
import { formatProfile, parseFilter } from '../profile.js';
import { Compactor, preservedContext } from '../compaction.js';
import { Budget, formatLimits, limitsFrom } from '../budget.js';
import { RealDeps, SCENARIOS, StoredRun, formatRun, loadRuns, runMock, runReal, saveRun } from '../benchmark.js';
import { Diagnostic, DiagnosticsHistory, ExecutionRecord, formatDiagnostics, formatWhy, sanitize } from '../diagnostics.js';
import { discoverToolchain } from '../verify.js';
import type { TokenBreakdown, TurnItem } from './chat.js';
import { SkillCatalog, SkillInfo, SkillPicker, scopeLabel } from './skills.js';
import { SkillDecision, explainDecision, selectSkills, unavailable } from '../skillselect.js';
import type { Key } from './keys.js';


export interface TuiIO { input: NodeJS.ReadableStream; output: NodeJS.WriteStream; }

/**
 * Minimal line-based TUI: prompt, streamed output, multi-turn, resize-aware.
 * Resolves with the exit code when the user quits (exit/quit, Ctrl-D, Ctrl-C) or the server dies.
 */
export interface TuiOptions {
  resume?: string | 'last';
  router?: TurnRouter;
  policy?: Policy;
  /** Starting approval mode for this process only; defaults to manual and is never persisted. */
  approvalMode?: ApprovalMode;
  /** Starts a fresh App Server after an unexpected exit; the thread is then resumed. */
  reconnect?: () => Promise<AppClient>;
  /** Shown in the welcome header. */
  version?: string;
  /** Clipboard image reader (tests inject one). */
  readImage?: () => Promise<string | undefined>;
  /** Clipboard writer (tests inject one). */
  clipboard?: (text: string) => Promise<string>;
  /** Real connection info for the welcome header (omitted when unknown). */
  connection?: string;
  /** Isolated Codex sessions for /benchmark real (temporary repositories); absent = real benchmarks unavailable. */
  benchSession?: RealDeps['session'];
}

const MAX_RECONNECTS = 3;
const SIGNALS: [NodeJS.Signals, number][] = [['SIGINT', 2], ['SIGHUP', 1], ['SIGTERM', 15]];

export async function runTui(initialClient: AppClient, cwd: string, io: TuiIO = { input: process.stdin, output: process.stdout }, opts: TuiOptions = {}): Promise<number> {
  const { input, output } = io;
  let client = initialClient;
  const tty = Boolean(output.isTTY);
  const live = tty && process.env.TERM !== 'dumb'; // cursor-addressable: persistent bottom region
  const color = tty && !process.env.NO_COLOR;
  const animate = live && !process.env.LUMINA_NO_ANIMATION;
  const sgr = (on: string, off: string) => (x: string) => (color ? `\x1b[${on}m${x}\x1b[${off}m` : x);
  const screen = new Screen(output, { live, color, styler: { bold: sgr('1', '22'), code: sgr('36', '39'), link: sgr('4', '24'), dim: sgr('2', '22') } });
  const h = { key: (_k: Key) => false, submit: (_t: string) => true, interrupt: () => undefined as void, eof: () => undefined as void };
  const paintInput = () => { if (live) screen.setInput(composer.view(screen.columns)); };
  // slash-command palette: local, driven by the input text; overlay is shared with the skills picker
  const palette = new CommandPalette();
  let paintOverlay = () => undefined as void;
  const onInputChange = () => { paintInput(); palette.update(composer.text); paintOverlay(); };
  const composer = new Composer(input as never, output, { onSubmit: (t) => h.submit(t), onInterrupt: () => h.interrupt(), onEof: () => h.eof(), onChange: onInputChange, onKey: (k) => h.key(k) }, live);
  const activity = new Activity(screen, { animate, color, cwd });
  composer.setDim((x) => activity.dim(x));
  const IDLE_PLACEHOLDER = 'Ask Lumina anything...';
  let pendingApproval: ((d: Decision) => void) | undefined;
  let cmdBusy = false; // a slash command's request is in flight
  let interrupting = false;
  let closing = false;
  const write = (s: string) => activity.text(s);
  let answer = ''; // raw text of the last assistant answer (for /copy all)
  const onDelta = (d: string) => { answer += d; write(d); };
  const note = (m: string) => write(`${m.split('\n').map((l) => activity.dim(l)).join('\n')}\n`);
  const askManual = (r: ApprovalRequest) => new Promise<Decision>((resolve) => {
    pendingApproval = resolve;
    activity.pause();
    composer.stash(); // answers use a fresh buffer; the user's draft comes back afterwards
    composer.setPlaceholder('y approve · a for session · n reject · c cancel');
    const home = os.homedir();
    const tidy = (p: string) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p);
    const lines = [`${activity.paintStatus('warn', '⚠')} Approval Required`];
    if (r.kind === 'command' && r.reason) lines.push(activity.dim(r.reason));
    lines.push('', `${r.kind === 'command' ? 'Command' : r.kind === 'mcpTool' ? 'MCP tool' : 'Changes'}:`);
    lines.push(`  ${r.kind === 'command' && r.command ? unwrap(r.command) : r.summary}`); // the shell wrapper is noise
    if (r.kind === 'command' && r.cwd) lines.push(activity.dim(`  in ${tidy(r.cwd)}`));
    else if (r.kind !== 'command' && r.detail) lines.push(activity.dim(`  ${r.detail}`));
    // a request reaching into another configured repository is called out (never auto-approved: it is outside this workspace)
    const other = [r.cwd ?? '', ...(r.detail ?? '').split(/\s+/)].filter((x) => x.startsWith('/')).map((x) => workspace?.ownerOf(x)).find(Boolean);
    if (other) lines.push('', activity.paintStatus('warn', `⚠ This touches ${other.name}, another repository of the workspace (${other.writable ? 'edits allowed by workspace.allow_writes' : 'read-only for this session'}).`));
    lines.push('', '[y] Approve once   [a] Always this session   [n] Reject   [c] Cancel');
    activity.block(lines.join('\n'));
  });
  // Approval mode lives only in this process/session; it starts as manual unless explicitly requested.
  let approvalMode: ApprovalMode = opts.approvalMode ?? 'manual';
  const shortCmd = (c: string) => unwrap(c).replace(/\s+/g, ' ').trim().slice(0, 100);
  const ask = async (r: ApprovalRequest): Promise<Decision> => {
    if (r.kind === 'mcpTool' && r.server && r.tool && evaluateMcp({ server: r.server, tool: r.tool, mode: approvalMode }).decision === 'approve') {
      activity.notice(`${activity.paintStatus('ok', '✓')} Auto-approved: ${r.server} › ${r.tool}`);
      return 'accept'; // once only; never persisted for the session
    }
    if (approvalMode !== 'manual' && r.kind === 'command' && r.command) {
      const e = evaluate({ command: r.command, cwd, mode: approvalMode, network: r.network, commandCwd: r.cwd });
      if (e.decision === 'approve') { activity.notice(`${activity.paintStatus('ok', '✓')} Auto-approved: ${shortCmd(r.command)}`); return 'accept'; }
      if (e.decision === 'deny') {
        activity.notice(`${activity.paintStatus('bad', '✗')} Auto-rejected: ${shortCmd(r.command)} (${e.reason}; /approval manual to decide yourself)`);
        return 'decline';
      }
    }
    return askManual(r); // ask, manual mode, file changes and anything unclassified
  };
  // execution diagnostics of the request in flight (and the last finished one), from events Lumina already sees
  let diag: Diagnostic | undefined;
  let lastRecord: ExecutionRecord | undefined;
  const chat = new Chat(client, { cwd, onDelta, onEvent: (m, p) => { activity.event(m, p); diag?.onServerEvent(m, p); }, onApproval: async (r) => { const d = await ask(r); diag?.approval(r.kind, d); return d; }, policy: opts.policy ?? DEFAULT_POLICY });
  const router = opts.router ?? new TurnRouter(loadConfig(cwd), cwd);
  // routing feedback: outcomes recorded after each request; enough verified evidence may nudge later routes
  const feedback = new RoutingFeedback(router.config.feedback);
  // compaction: Codex's own API, only at boundaries and only when it pays off; critical context restated afterwards
  const compactor = new Compactor(router.config.stages, () => chat.compact(), () => chat.lastCompactionUsage);
  const sessionStart = Date.now();
  const sessionFiles = new Set<string>(); // files changed in this conversation (from checkpoints)
  let knownFailures: string[] = []; // unresolved verification failures of the last change
  // budget of the request in flight (and the last one, for /budget); a stopped request can be continued explicitly
  let budget: Budget | undefined;
  let lastBudget: Budget | undefined;
  let continuation: { request: string; reason: string; unfinished: string[] } | undefined;
  /** Budget exhausted at a boundary: report what is done and what is not, keep the progress, offer /continue. */
  const reportStop = (b: Budget, request: string) => {
    if (!b.stopped) return;
    continuation = { request, reason: b.stopped.reason, unfinished: b.stopped.unfinished };
    note(`⏸ Stopped at an execution boundary: budget exhausted (${b.stopped.reason}).\n  Not finished: ${b.stopped.unfinished.join('; ')}\n  Progress so far is kept (files, checkpoint, conversation). /continue resumes with a fresh budget · /budget shows usage.`);
  };
  const stageCompact = async () => (await compactor.run('stage boundary', chat.contextTokens(), 'context over the threshold between stages')).ok;
  router.feedback ??= feedback;
  let listed: ThreadSummary[] = [];
  // Skills: metadata from Codex's own skills/list; Codex itself loads SKILL.md bodies when a skill is used.
  const catalog = new SkillCatalog(client, cwd);
  let picker: SkillPicker | undefined;
  let skillDecision: SkillDecision | undefined; // the last request's skill choice, for /why
  const paint = { accent: (x: string) => activity.accent(x), dim: (x: string) => activity.dim(x) };
  // suggestions shown: up to 8, fewer on short terminals so the input always stays on screen
  const paletteRows = () => Math.max(2, Math.min(8, (output.rows || 24) - 12));
  // prompts queued with Tab while a turn runs; they run in order when it ends
  const queue: string[] = [];
  const queueRows = (): string[] | undefined => {
    if (!queue.length) return undefined;
    const w = screen.columns - 1;
    const fit = (x: string) => (x.length > w ? `${x.slice(0, w - 1)}…` : x);
    return [
      paint.dim(fit(`  Queued (${queue.length}) · runs after the current turn · Ctrl-C clears`)),
      ...queue.slice(0, 3).map((q, i) => fit(`  ${i + 1}. ${q.split('\n')[0]}${q.includes('\n') ? ' …' : ''}`)),
      ...(queue.length > 3 ? [paint.dim(`  … +${queue.length - 3} more`)] : []),
    ];
  };
  paintOverlay = () => screen.setOverlay(diffView ? diffView.rows(screen.columns - 1, diffHeight(), diffPaint) : diagPicker ? diagPicker.picker.rows(screen.columns - 1, paletteRows(), paint) : cpPicker ? cpPicker.rows(screen.columns - 1, paletteRows(), paint) : sessions ? sessions.rows(screen.columns - 1, paletteRows(), paint) : picker ? picker.rows(screen.columns - 1, paint) : live && palette.open ? palette.rows(screen.columns - 1, paletteRows(), paint) : live ? queueRows() : undefined);

  // pasted images: a [Image #n] token in the draft stands for a file; it is attached when the prompt is sent
  const images = new Map<string, string>();
  const attachImage = (file: string) => {
    const label = `[Image #${images.size + 1}]`;
    images.set(label, file);
    const t = composer.text;
    composer.insertText(`${t && !/\s$/.test(t) ? ' ' : ''}${label} `);
  };
  const imagesIn = (text: string): string[] => [...new Set([...text.matchAll(/\[Image #\d+\]/g)].map((m) => images.get(m[0])).filter((p): p is string => Boolean(p)))];
  /** Keys handled before the input: image paste (Ctrl+V / pasted image path) and Tab-to-queue. */
  const extraKey = (k: Key): boolean => {
    if (pendingApproval || pendingConfirm) return false;
    if (k.t === 'paste') { const file = imagePathFromPaste(k.s, cwd); if (file) { attachImage(file); return true; } return false; }
    if (k.t !== 'key') return false;
    if (k.name === 'paste-image') {
      void (opts.readImage ?? readClipboardImage)().then((file) => {
        if (file) attachImage(file); else note('no image in the clipboard (text is pasted by the terminal: Cmd+V / Ctrl+Shift+V)');
      }, () => note('could not read the clipboard'));
      return true;
    }
    // Tab = queue (or send when idle); on an empty input it does nothing (no stray indentation)
    if (k.name === 'tab' && live) { if (composer.text.trim()) enqueue(composer.text); return true; }
    return false;
  };
  let enqueue = (_t: string) => undefined as void;
  const paintPicker = paintOverlay;
  // /diff viewer (read-only): file list, then one file's diff, drawn above the input
  let diffView: DiffViewer | undefined;
  const diffHeight = () => Math.max(6, (output.rows || 24) - 8);
  const sgr2 = (on: string, off: string) => (x: string) => (color ? `\x1b[${on}m${x}\x1b[${off}m` : x);
  const diffPaint = { add: sgr2('32', '39'), del: sgr2('31', '39'), hunk: sgr2('36', '39'), head: sgr2('1', '22'), dim: sgr2('2', '22'), accent: sgr2('36', '39') };
  // /resume picker: pages of Codex threads (metadata only), fetched as the user scrolls or filters
  let sessions: SessionPicker | undefined;
  let sessionPages = 0;
  const loadMoreSessions = () => {
    const sp = sessions;
    if (!sp || !sp.wantsMore || sessionPages >= 20) return;
    sp.loading = true;
    sessionPages++;
    void chat.listPage({ cursor: sp.cursor }).then((page) => {
      if (sessions !== sp) return;
      sp.append(page.items, page.nextCursor);
      paintOverlay();
      loadMoreSessions(); // a filter that still matches nothing keeps paging (bounded)
    }, (e: unknown) => { sp.loading = false; sp.cursor = null; note(`could not load more conversations: ${e instanceof Error ? e.message : String(e)}`); paintOverlay(); });
  };
  /** Re-attaches to a saved conversation and shows it; a missing/deleted one leaves the current conversation as is. */
  let resumeThread = async (_id: string): Promise<void> => undefined;
  h.key = (k) => {
    if (diffView) {
      const dv = diffView;
      const act = dv.handle(k, diffHeight() - 1);
      if (act.type === 'close') diffView = undefined;
      else if (act.type === 'open') {
        dv.loading = true;
        void fileDiff(cwd, act.file).then((d) => { dv.showDiff(act.file, d.lines, d.truncated); paintOverlay(); }, (e: unknown) => {
          dv.loading = false;
          note(`/diff: ${act.file.path}: ${e instanceof Error ? e.message : String(e)}`);
          paintOverlay();
        });
      }
      paintOverlay();
      return true;
    }
    if (diagPicker) {
      const dp = diagPicker;
      const r = dp.picker.handle(k);
      const chosen = dp.picker.selected;
      if (r === 'close') diagPicker = undefined;
      else if (r === 'select' && chosen) { diagPicker = undefined; const rec = dp.all.find((x) => x.id === chosen.id); if (rec) note(formatDiagnostics(rec, (m) => router.displayName(m), true)); }
      paintOverlay();
      return true;
    }
    if (cpPicker) {
      const r = cpPicker.handle(k);
      const chosen = cpPicker.selected;
      if (r === 'close') { cpPicker = undefined; note('rollback cancelled'); }
      else if (r === 'select' && chosen) { cpPicker = undefined; void checkpoints().then((st) => { if (typeof st !== 'string') proposeRollback(st, chosen.id); }); }
      paintOverlay();
      return true;
    }
    if (sessions) {
      const r = sessions.handle(k);
      const chosen = sessions.selected;
      if (r === 'close') { sessions = undefined; note('resume cancelled'); }
      else if (r === 'select' && chosen) { sessions = undefined; cmdBusy = true; void resumeThread(chosen.id).finally(() => { cmdBusy = false; }); }
      else loadMoreSessions();
      paintOverlay();
      return true;
    }
    if (!picker) {
      if (!live) return extraKey(k);
      const r = palette.handle(k);
      if (typeof r === 'string') composer.replace(r); // filled, not executed: Enter again runs it
      if (r !== false) { paintOverlay(); return true; }
      return extraKey(k);
    }
    const r = picker.handle(k);
    if (r === 'select') { // insert the reference into the draft; nothing is sent
      const t = composer.text;
      composer.insertText(`${t && !/\s$/.test(t) ? ' ' : ''}$${picker.selected?.name} `);
    }
    if (r !== 'consumed') picker = undefined;
    paintPicker();
    return true;
  };
  let lastPick: { model: string; effort: string } | undefined;
  const skillNote = (skills: SkillInfo[]) => `skills: ${skills.map((k) => `$${k.name}`).join(' ')}${skillDecision?.mode === 'auto' ? ' (selected automatically · /why)' : ''}`;
  /** The routed model and effort, shown under the activity row while the model works. */
  const showModel = () => { activity.model = lastPick?.model ? `Model: ${router.displayName(lastPick.model)} · Reasoning: ${cap(lastPick.effort)}` : undefined; };
  let staged: StagedExecution | undefined;
  const ticket = new TicketSession();
  let stageCancel = false;

  /** Replays the stored conversation above the composer after a resume. A failure only skips the replay. */
  const showHistory = async (id: string) => {
    try {
      const turns = await chat.readTurns(id);
      if (!turns.length) return;
      write(`${renderHistory(turns, { accent: (x) => activity.accent(x), dim: (x) => activity.dim(x), ok: (x) => activity.paintStatus('ok', x), bad: (x) => activity.paintStatus('bad', x), warn: (x) => activity.paintStatus('warn', x) })}\n`);
      note('— end of previous conversation —\n');
    } catch (e) { note(`could not load history: ${e instanceof Error ? e.message : String(e)}`); }
  };

  // ---- checkpoints: local snapshots around code-modifying turns, for /checkpoints and /rollback ----
  let cpStore: Promise<CheckpointStore | string> | undefined;
  const checkpoints = () => (cpStore ??= router.config.checkpoints.enabled
    ? CheckpointStore.open(cwd, router.config.checkpoints).catch((e: unknown) => `checkpoints unavailable: ${e instanceof Error ? e.message : String(e)}`)
    : Promise.resolve('checkpoints are disabled (checkpoints.enabled in the Lumina config)'));
setImmediate(() => void checkpoints()); // resolve the repository once at startup, not on the first turn
  let liveCp: { store: CheckpointStore; m: Manifest } | undefined; // the turn currently being recorded
  /** Snapshot before a turn that may modify code; never blocks the turn when it fails. */
  const beginCheckpoint = async (task: string): Promise<void> => {
    const st = await checkpoints();
    if (typeof st === 'string') return;
    try { liveCp = { store: st, m: await st.begin(task) }; } catch (e) { note(`checkpoint skipped: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const finishCheckpoint = async (interrupted: boolean, quiet = false): Promise<Manifest | undefined> => {
    const cp = liveCp;
    liveCp = undefined;
    if (!cp) return undefined;
    try {
      const m = await cp.store.finish(cp.m, interrupted);
      for (const c of m.changes) if (sessionFiles.size < 200) sessionFiles.add(c.path);
      if (!quiet && m.status !== 'no-changes') note(`checkpoint ${m.id} · ${m.changes.length} file${m.changes.length === 1 ? '' : 's'} changed${m.status === 'interrupted' ? ' · interrupted' : ''} · /rollback to undo`);
      return m;
    } catch (e) { if (!quiet) note(`checkpoint could not be completed: ${e instanceof Error ? e.message : String(e)}`); return undefined; }
  };
  const cpTime = (ms: number) => new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const cpLine = (m: Manifest) => `${m.id}  ${cpTime(m.createdAt)}  ${m.status.padEnd(11)}  ${String(m.changes.length).padStart(3)} file${m.changes.length === 1 ? ' ' : 's'}  ${m.task.slice(0, 70)}`;
  /** Pending y/n confirmation (rollback, verification), answered through the input like approvals. */
  let pendingConfirm: ((yes: boolean) => void) | undefined;
  const askYesNo = (block: string, placeholder: string) => new Promise<boolean>((resolve) => {
    activity.block(block);
    composer.stash();
    composer.setPlaceholder(placeholder);
    pendingConfirm = (yes) => {
      pendingConfirm = undefined;
      composer.restore();
      composer.setPlaceholder(IDLE_PLACEHOLDER);
      resolve(yes);
    };
  });
  let cpPicker: SessionPicker | undefined;
  let diagPicker: { picker: SessionPicker; all: ExecutionRecord[] } | undefined;
  let graph: DependencyGraph | undefined; // dependency graph, updated incrementally on each /graph
  const findCheckpoint = (st: CheckpointStore, ref: string): Manifest | string => {
    const all = st.list();
    const hit = all.filter((m) => m.id.startsWith(ref.toLowerCase()));
    if (hit.length === 1) return hit[0];
    return hit.length ? `"${ref}" matches ${hit.length} checkpoints; use more characters` : `no checkpoint ${ref} (see /checkpoints)`;
  };
  /** Shows what a rollback would do and asks for explicit confirmation; conflicts block it. */
  const proposeRollback = (st: CheckpointStore, id: string) => {
    let plan;
    try { plan = st.plan(id); } catch (e) { note(`/rollback: ${e instanceof Error ? e.message : String(e)}`); return; }
    const m = plan.checkpoint;
    const verb = { restore: 'restore ', delete: 'delete  ', recreate: 'recreate' } as const;
    const lines = [`Rollback checkpoint ${m.id} · ${cpTime(m.createdAt)} · ${m.status}`, activity.dim(`  ${m.task.slice(0, 100)}`), ''];
    for (const it of plan.items) lines.push(it.conflict ? `  ${activity.paintStatus('bad', '✗')} ${verb[it.action]} ${it.path}  ${activity.dim(`(${it.conflict})`)}` : `    ${verb[it.action]} ${it.path}`);
    if (plan.blocked) {
      lines.push('', `${activity.paintStatus('bad', '✗')} Rollback not possible: ${plan.blocked}. Nothing was changed.`);
      activity.block(lines.join('\n'));
      return;
    }
    lines.push('', activity.dim('Only these files are touched; everything else (including your own edits) stays as it is.'), '[y] Roll back   [n] Cancel');
    void askYesNo(lines.join('\n'), 'y roll back · n cancel').then((yes) => {
      if (!yes) { note('rollback cancelled; nothing was changed'); return; }
      try {
        const r = st.rollback(id); // re-checks every file right now: a change since the preview blocks it
        note(`✓ rolled back checkpoint ${id}: ${r.restored} file${r.restored === 1 ? '' : 's'} restored`);
      } catch (e) { note(`✗ ${e instanceof Error ? e.message : String(e)}`); }
    });
  };

  // ---- smart verification: checks chosen for the changed files, after a turn that changed code (or /verify) ----
  let verifier: Verifier | undefined;
  let verifyAbort: AbortController | undefined;
  let healing = false; // a self-healing loop is between its turns and checks
  const verifyRoot = async () => { const m = await (repo ?? indexRepo()); return m instanceof Error ? cwd : m.root; };
  const runVerification = async (changes: Change[], o: { request?: string; items?: TurnItem[]; mode?: Level; queue?: boolean }): Promise<Verification | undefined> => {
    if (!changes.length) return undefined;
    if (router.config.verification.mode === 'off' && !o.mode) { note('Verification: off (verification.mode = off)'); return undefined; }
    const root = await verifyRoot();
    verifier ??= new Verifier(root, router.config.verification, predictForVerify, () => Promise.race([checkContracts(root), new Promise<undefined>((r) => setTimeout(() => r(undefined), 10_000).unref())]));
    verifyAbort = new AbortController();
    let headed = false;
    const head = (v: Pick<Verification, 'level' | 'reason'>) => { if (!headed) { headed = true; note(formatHeader(v)); } };
    try {
      diag?.event('verification_started', { files: changes.length });
      const v = await verifier.verify(changes, {
        request: o.request, items: o.items, mode: o.mode, signal: verifyAbort.signal,
        hooks: {
          approved: (c) => approvalMode !== 'manual' && evaluate({ command: c.approval ?? c.command, cwd: root, mode: approvalMode }).decision === 'approve',
          confirm: (checks) => askYesNo(['Run verification?', ...checks.map((c) => `  ${c.command}`), '', '[y] Run   [n] Skip'].join('\n'), 'y run checks · n skip'),
          start: (c) => activity.spin(`Verifying: ${c.label}...`, c.command),
          done: (r) => { activity.stopSpin(); write(`${formatResult(r)}\n`); },
        },
      });
      activity.stopSpin();
      diag?.verified(v, (o.items ?? []).filter((i) => i.type === 'commandExecution' && i.exitCode === 0).map((i) => i.command ?? ''));
      if (!v.declined && v.level !== 'off') knownFailures = v.results.filter((r) => r.status === 'failed').map((r) => `${r.check.label} (${r.check.command}): ${r.failure}`).slice(0, 5);
      if (v.level === 'off') { note(formatHeader(v)); return v; }
      head(v);
      const foot = formatFooter(v);
      if (v.declined) note('verification not run (declined); /verify runs it later');
      if (foot.length) note(foot.join('\n'));
      const ctx = o.queue === false ? undefined : failureContext(v);
      if (ctx) chat.queueContext(ctx);
      return v;
    } catch (e) {
      activity.stopSpin();
      note(`verification could not run: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    } finally { verifyAbort = undefined; }
  };
  /**
   * After a turn: verify, and when the change broke something code can fix, repair it in focused fix turns (the stage
   * engine's fix stage, through the normal approval flow and checkpoints), re-verifying after each. Bounded.
   */
  const verifyAndHeal = async (changes: Change[], request: string, items: TurnItem[]) => {
    const sh = router.config.self_healing;
    const v = await runVerification(changes, { request, items, queue: !sh.enabled });
    if (v) void learn(v, request);
    if (!v || !sh.enabled || !v.results.some((r) => r.status === 'failed') || v.declined) return;
    const root = await verifyRoot();
    const name = (m?: string) => (m ? router.displayName(m) : '?');
    let prev = lastPick?.model;
    stageCancel = false;
    healing = true;
    const res = await selfHeal(v, {
      cfg: router.config, catalog: router.models, root, request, changes, startModel: lastPick?.model, startEffort: lastPick?.effort, budget,
      stage: { send: (p, sel, o) => chat.send(p, sel, [], { isolated: o.isolated }), interrupt: () => chat.interrupt(), cancelled: () => stageCancel, context: () => chat.contextTokens(), compact: stageCompact, log: stageLog },
      hooks: { planned: () => undefined, stageStart: () => undefined, stageEnd: () => undefined, notice: (t) => note(t) },
      verify: (ch, it, level) => runVerification(ch, { items: it, mode: level, queue: false }),
      checkpoint: (opts.policy ?? DEFAULT_POLICY).sandbox === 'read-only' ? undefined : {
        begin: (task) => beginCheckpoint(task),
        finish: async (cancelled) => turnChanges(await finishCheckpoint(cancelled), []),
      },
      ui: {
        attempt: (n, max, sel, reason, brief) => {
          note(`Self-Healing: Attempt ${n}/${max} · ${name(sel.model)} · ${sel.effort} · ${reason}\n${brief.split('\n').slice(0, 4).map((l) => `  ${l.slice(0, 140)}`).join('\n')}`);
          if (prev && sel.model && sel.model !== prev) activity.notice(`↪ Switching model\n  ${name(prev)} → ${name(sel.model)}\n  ${activity.dim(`Reason: ${reason}`)}`);
          prev = sel.model ?? prev;
          lastPick = { model: sel.model ?? '', effort: sel.effort ?? '' };
          showModel(); refreshFooter();
          answer = '';
          activity.begin('Applying targeted fix...');
        },
        repairEnd: (ok) => activity.end(ok ? 'completed' : stageCancel ? 'cancelled' : 'failed'),
        notice: (t) => note(t),
      },
    }).catch((e: unknown) => { note(`self-healing stopped: ${e instanceof Error ? e.message : String(e)}`); return undefined; }).finally(() => { healing = false; });
    if (!res) return;
    diag?.healed(res);
    if (res.attempts) diag?.event('repair_attempted', { attempts: res.attempts, status: res.status });
    const last = res.last;
    if (res.status === 'repaired') note('✓ Repair successful\n✓ Verification passed');
    else if (res.status === 'skipped' && res.classes.length) note(`Self-Healing: not applied — ${res.reason}\n${res.classes.map((c) => `  ${c.check}: ${c.cls} (${c.reason})`).join('\n')}`);
    else if (res.status === 'exhausted' || res.status === 'stopped') {
      const err = last?.results.find((r) => r.status === 'failed');
      note(`✗ Automatic repair ${res.status === 'exhausted' ? 'exhausted' : 'stopped'} (${res.reason})\n  Attempts: ${res.attempts}${res.models.length ? ` · Models: ${res.models.map(name).join(' → ')}` : ''}\n  Last error: ${err ? `${err.failure} in \`${err.check.command}\`` : 'unknown'}\n  Manual intervention required. Repair changes are kept; /checkpoints and /rollback can undo them.`);
    } else if (res.status === 'cancelled') note('self-healing cancelled; changes so far are kept (/rollback can undo them)');
    if (res.status !== 'repaired' && last) { const ctx = failureContext(last); if (ctx) chat.queueContext(ctx); }
    if (budget?.stopped) reportStop(budget, request);
    if (last && last !== v) void learn(last, request);
  };
  /** Memory from verified outcomes only: passing changes (where the work lives) and failures not caused by the change. */
  const learn = async (v: Verification, request: string) => {
    const mem = await openMemory();
    if (mem instanceof Error || v.level === 'off' || v.declined) return;
    const root = await verifyRoot();
    const failed = v.results.filter((r) => r.status === 'failed');
    const ran = v.results.some((r) => r.status === 'passed');
    try {
      if (!failed.length && ran) mem.noteImplementation(request, v.impact.changes.filter((c) => c.kind !== 'deleted').map((c) => c.path));
      for (const r of failed) {
        const c = healClass(r, v.impact, root);
        if (c.cls === 'PRE_EXISTING_FAILURE' || c.cls === 'ENVIRONMENT_FAILURE') mem.observeIssue(r.check.command, c.cls === 'ENVIRONMENT_FAILURE' ? `environment: ${r.failure}` : 'pre-existing', c.reason, errorLocations(r.output ?? '', root).slice(0, 5));
      }
    } catch { /* memory must never break a turn */ }
  };
  /** Stage-engine events go to the existing routing log and into the request's trace (same request id). */
  const stageLog = (e: RoutingLog) => { logRouting(diag ? { ...e, request_id: diag.id } : e, router.config); diag?.fromLog(e); };
  const diagHistory = (() => { let h: DiagnosticsHistory | undefined; return async () => (h ??= new DiagnosticsHistory(await verifyRoot().catch(() => cwd), router.config.diagnostics.history)); })();
  /** Freezes the request's diagnostics: history (bounded), one numbers-only routing-log line, failure summary. */
  const finishDiag = async (status: 'completed' | 'failed' | 'cancelled', error?: string, usage?: TokenBreakdown) => {
    const d = diag;
    diag = undefined;
    if (!d) return;
    const c = chat.contextTokens();
    const r = d.finish(status, { error, usage, contextPct: c?.window ? Math.round((c.used / c.window) * 100) : undefined });
    lastRecord = r;
    if (r.routing?.category) feedback.record(recordFrom(r, r.routing.category));
    compactor.turnDone(chat.contextTokens());
    void diagHistory().then((h) => h.append(r)); // off the turn's critical path
    logRouting({ level: r.status === 'completed' ? 'info' : 'warn', event: 'execution_diagnostics', request_id: r.id, execution_id: r.id, routing_strategy: r.routing?.strategy ?? 'direct', status: r.status, selected_model: r.routing?.model, execution_duration_ms: r.ms, switch_count: r.switches, stage_count: r.stages.length, escalations: r.escalations, failure_category: r.failure?.category ?? null, verification_failed: r.verification?.checks.filter((x) => x.status === 'failed').length ?? 0, repair_attempts: r.healing?.attempts ?? 0, insights: r.insights.length }, router.config);
    if (r.failure && r.failure.category !== 'cancellation') note(`Diagnostics: ${r.failure.category} failure in ${r.failure.operation}\n${r.failure.next.map((x) => `  → ${x}`).join('\n')}\n  /diagnostics for details`);
  };
  /** Dependency graph of the repository, updated incrementally (only changed files are re-parsed). */
  const ensureGraph = async (announce = false): Promise<DependencyGraph> => {
    const root = await verifyRoot();
    if (graph?.root !== root) graph = new DependencyGraph(root);
    const g = graph;
    const slow = announce ? setTimeout(() => note('indexing dependencies…'), 400) : undefined;
    try { return await g.update(); } finally { clearTimeout(slow); }
  };
  const graphStats = (g: DependencyGraph, t0: number) => { const s = g.stats; return `${s.files} source files · ${s.parsed} parsed, ${s.reused} unchanged${s.skipped ? `, ${s.skipped} skipped` : ''}${s.truncated ? ' · truncated at 20,000 files' : ''} · ${Date.now() - t0}ms`; };
  /** Verification reuses the impact of the actual changes (bounded in time: verification never waits long for it). */
  const predictForVerify = async (changes: Change[]) => {
    if (!router.config.verification.use_graph) return undefined;
    const work = ensureGraph().then((g) => analyzeChanges(g, changes));
    return Promise.race([work, new Promise<undefined>((r) => setTimeout(() => r(undefined), 10_000).unref())]);
  };
  /** Files a turn changed: exact from the checkpoint, else what Codex reported editing. */
  const turnChanges = (m: Manifest | undefined, items: TurnItem[]): Change[] => {
    if (m) return m.changes.filter((c) => !c.unsafe).map((c) => ({ path: c.path, kind: c.before === null ? 'added' : c.after === null ? 'deleted' : 'modified' }));
    const rel = (p: string) => (path.isAbsolute(p) ? path.relative(cwd, p) : p);
    return [...new Set(items.flatMap((i) => (i.type === 'fileChange' ? i.files ?? [] : [])).map(rel))].filter((p) => p && !p.startsWith('..')).map((p) => ({ path: p, kind: 'modified' as const }));
  };

  // ---- repository map: built in the background at startup (cached on disk), shown by /repo ----
  let repo: Promise<(RepoMap & { cached: boolean }) | Error> | undefined;
  const indexRepo = (refresh = false) => (repo = repoMap(cwd, { refresh }).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))));
  // project memory: local MEMORY.md per repository; repository-derived notes re-synced from the map
  let memory: Promise<ProjectMemory | Error> | undefined;
  const openMemory = () => (memory ??= router.config.memory.enabled
    ? ProjectMemory.open(cwd, router.config.memory).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e))))
    : Promise.resolve(new Error('project memory is disabled (memory.enabled = false)')));
  const syncMemory = async () => {
    const [mem, map] = await Promise.all([openMemory(), repo ?? indexRepo()]);
    if (mem instanceof Error || map instanceof Error) return mem instanceof Error ? mem : undefined;
    try { return mem.sync(map, discoverToolchain(map.root)); } catch (e) { return e instanceof Error ? e : undefined; }
  };
  // workspace: explicitly configured related repositories, linked in the background (each keeps its own indexes)
  const workspace: Workspace | undefined = router.config.workspace.repositories.length ? new Workspace(cwd, router.config.workspace) : undefined;
  let workspaceBuild: Promise<Workspace | Error> | undefined;
  const buildWorkspace = () => (workspaceBuild = workspace ? workspace.build().catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))) : Promise.resolve(new Error('no workspace configured')));
  setImmediate(() => { repo ??= indexRepo(); void syncMemory(); if (workspace) void buildWorkspace(); }); // after the first paint; never awaited by turns
  // smart context: path/symbol hints from the same map, prepended to the next turn (bounded by retrieval.timeout_ms)
  const retriever = new Retriever(cwd, router.config.retrieval);
  // context efficiency of each request (/context); counts only go to the existing routing log
  const metrics = new ContextMetrics(router.config.metrics.enabled);
  const recordMetrics = (m: Omit<RequestMetrics, 'at' | 'filesRead' | 'model' | 'effort'> & { items: TurnItem[] }) => {
    if (!metrics.enabled) return;
    const { items, ...rest } = m;
    const rm: RequestMetrics = { ...rest, at: Date.now(), filesRead: filesRead(items, cwd), model: lastPick?.model ? router.displayName(lastPick.model) : '', effort: lastPick?.effort ?? '' };
    metrics.record(rm);
    if (diag) { const hinted = new Set(rm.retrieval?.block ? rm.retrieval.hints.map((h) => h.path).filter((p) => rm.retrieval!.block!.includes(`- ${p}`)) : []); diag.rec.context = { ...diag.rec.context, filesRead: rm.filesRead.length, hintsRead: rm.filesRead.filter((f) => hinted.has(f)).length }; }
    if (router.config.metrics.log) logRouting(metrics.logEntry(rm), router.config);
    if (router.config.metrics.summary) note(metrics.summary(rm));
  };

  // ---- status bar (below the input): real routing state only ----
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const statusBar = (): string => {
    const model = router.model ?? lastPick?.model;
    const name = model ? router.displayName(model) : router.configuredModels().map((m) => router.displayName(m)).join(' ⇄ ');
    const effort = router.reasoning ? `${cap(router.reasoning)} (manual)` : lastPick ? cap(lastPick.effort) : '';
    const tk = ticket.ticket && ticket.mode && ticket.mode !== 'done' ? ` · ${ticket.ticket.id}: ${({ understanding: 'Understanding', ready: 'Ready', implementing: 'Implementing' } as Record<string, string>)[ticket.mode]}` : '';
    return `  ◉ ${router.model ? 'Manual model' : 'Auto Routing'} · ${[name, effort].filter(Boolean).join(' · ')}${approvalMode !== 'manual' ? ` · Approval: ${cap(approvalMode)}` : ''}${tk}`;
  };
  const refreshFooter = () => { if (live) screen.setFooter([activity.dim(screen.fit(statusBar()))]); }; // commands: type / (palette)

  // ---- welcome ----
  const home = os.homedir();
  const shownCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  write(`${activity.accent('◆')} Lumina CLI${opts.version ? ` v${opts.version}` : ''}\n${activity.dim('  Adaptive AI Coding Assistant')}\n\n  ${router.configuredModels().map((m) => router.displayName(m)).join(' ⇄ ')} · Auto Routing\n  ${shownCwd}${opts.connection ? activity.dim(`  ·  ${opts.connection}`) : ''}\n${tty ? '' : `${activity.dim(`  ${commandNames()}`)}\n`}\n`);

  // Terminal resize: re-wrap the input area (keeping the draft), re-fit the status row, repaint the region.
  const onResize = () => { paintInput(); refreshFooter(); activity.refresh(); paintOverlay(); screen.onResize(); };
  output.on('resize', onResize);

  resumeThread = async (id: string) => {
    try {
      await chat.resume(id);
    } catch (e) {
      note(`could not resume ${id.slice(0, 8)}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)} — it may have been deleted or archived; the current conversation is unchanged`);
      return;
    }
    router.reset(); ticket.reset(); retriever.reset(); metrics.reset(); compactor.reset(); sessionFiles.clear(); knownFailures = []; void openMemory().then((m) => { if (!(m instanceof Error)) m.reset(); });
    resetApproval();
    note(`resumed ${id.slice(0, 8)} (${chat.model ?? '?'})`);
    await showHistory(id);
    refreshFooter();
  };
  const resetApproval = () => { if (approvalMode !== 'manual') { approvalMode = 'manual'; note('approval mode reset to manual'); refreshFooter(); } };

  const command = async (line: string): Promise<boolean> => {
    const [name, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    switch (name) {
      case '/model':
        if (arg) router.setModel(arg);
        refreshFooter();
        note(`model: ${router.model ?? 'auto'}`);
        return true;
      case '/reasoning':
        if (arg) router.setReasoning(arg);
        refreshFooter();
        note(`reasoning: ${router.reasoning ?? 'auto'}`);
        return true;
      case '/approval': {
        const a = arg.toLowerCase();
        if (!a) {
          note(`Approval Mode (current: ${approvalMode})\n1. Manual - ask for every approval\n2. Smart  - auto-approve clearly safe read/test commands\n3. Auto   - also approve workspace-local git add/commit, builds and read-only lumina-mcp tools (get_/list_/search_/find_/inspect_/read_)\n/approval manual|smart|auto|status`);
          return true;
        }
        if (a === 'status') { note(`approval mode: ${approvalMode}`); return true; }
        const m = ({ 1: 'manual', 2: 'smart', 3: 'auto' } as Record<string, string>)[a] ?? a;
        if (!(MODES as string[]).includes(m)) { note('usage: /approval manual|smart|auto|status'); return true; }
        approvalMode = m as ApprovalMode;
        refreshFooter();
        note(`approval mode: ${m}${m === 'manual' ? '' : ' (dangerous commands are rejected, unknown ones still ask; resets to manual on /new, /resume and restart)'}`);
        return true;
      }
      case '/skills': {
        const skills = await catalog.load();
        if (!skills.length) { note('no skills found (global ~/.agents/skills, ~/.codex/skills, or project .agents/skills)'); return true; }
        if (catalog.failed) note(`${catalog.failed} skill(s) could not be loaded by Codex`);
        if (!live) { // no keyboard menu without a capable terminal: print the list
          const f = arg.toLowerCase();
          note(skills.filter((x) => !f || x.name.toLowerCase().includes(f) || x.description.toLowerCase().includes(f)).map((x) => `$${x.name} [${scopeLabel(x.scope)}]${unavailable(x) ? ` (unavailable: ${unavailable(x)})` : ''} ${x.description.slice(0, 100)}`).join('\n') || 'no matching skills');
          return true;
        }
        picker = new SkillPicker(skills, arg);
        paintPicker();
        return true;
      }
      case '/help':
        note(helpText());
        return true;
      case '/copy': {
        const blocks = screen.codeBlocks;
        const a = arg.trim().toLowerCase();
        let text: string | undefined;
        let what = '';
        if (a === 'all') { text = answer.trim(); what = 'last answer'; }
        else {
          const n = a ? Number(a) : blocks.length;
          if (a && (!Number.isInteger(n) || n < 1 || n > blocks.length)) { note(blocks.length ? `no code block ${a}; there ${blocks.length === 1 ? 'is 1' : `are ${blocks.length}`}` : 'no code blocks yet; /copy all copies the last answer'); return true; }
          text = blocks[n - 1]?.text; what = `code block ${n}`;
        }
        if (!text) { note(a === 'all' ? 'nothing to copy yet' : 'no code blocks yet; /copy all copies the last answer'); return true; }
        const how = await (opts.clipboard ?? ((x: string) => copyToClipboard(x, output)))(text);
        note(`✓ copied ${what} (${text.split('\n').length} line${text.includes('\n') ? 's' : ''}) to the ${how}`);
        return true;
      }
      case '/diff': {
        let files;
        try { files = await listChanges(cwd); } catch (e) { note(`/diff: ${e instanceof Error ? e.message : String(e)}`); return true; }
        if (!live) { // no interactive viewer without a capable terminal: print the summary
          note(files.length ? files.map((f) => `${f.section.padEnd(9)} ${f.status} ${f.origPath ? `${f.origPath} → ` : ''}${f.path}  ${f.binary ? 'binary' : `+${f.added ?? '?'} −${f.removed ?? 0}`}`).join('\n') : 'No changes — the working tree matches HEAD.');
          return true;
        }
        diffView = new DiffViewer(files);
        paintOverlay();
        return true;
      }
      case '/repo': {
        if (arg && arg !== 'refresh') { note('usage: /repo [refresh]'); return true; }
        const m = await (arg === 'refresh' || !repo ? indexRepo(arg === 'refresh') : repo);
        note(m instanceof Error ? `/repo: could not map ${cwd}: ${m.message}` : formatRepoMap(m));
        return true;
      }
      case '/context':
        note([metrics.format(), ...compactor.format(), `  next turn: ${compactor.decide(chat.contextTokens()).reason}`].join('\n'));
        return true;
      case '/verify': {
        const lv = arg.toLowerCase();
        if (lv && !['quick', 'standard', 'full'].includes(lv)) { note('usage: /verify [quick|standard|full]'); return true; }
        let files;
        try { files = await listChanges(cwd); } catch (e) { note(`/verify: ${e instanceof Error ? e.message : String(e)}`); return true; }
        const root = await verifyRoot();
        const changes = files.map((f) => ({ path: path.relative(root, path.resolve(cwd, f.path)), kind: f.status === 'D' ? 'deleted' as const : f.status === '?' || f.status === 'A' ? 'added' as const : 'modified' as const }));
        if (!changes.length) { note('Nothing to verify: the working tree matches HEAD.'); return true; }
        await runVerification(changes, { mode: (lv || undefined) as Level | undefined });
        return true;
      }
      case '/memory': {
        const [sub, ...more] = arg.split(/\s+/);
        const ref = more.join(' ').trim();
        const mem = await openMemory();
        if (mem instanceof Error) { note(`/memory: ${mem.message}`); return true; }
        if (!sub) { note(mem.summary()); return true; }
        if (sub === 'list') { const all = mem.list(); note(all.length ? all.map(formatLine).join('\n') : 'No memories stored for this project yet.'); return true; }
        if (sub === 'inspect' || sub === 'forget') {
          const e = ref ? mem.get(ref) : undefined;
          if (!e) { note(ref ? `no memory ${ref} (see /memory list)` : `usage: /memory ${sub} <id>`); return true; }
          if (sub === 'inspect') { note(formatEntry(e)); return true; }
          void askYesNo(`Forget this memory?\n${formatEntry(e)}\n\n[y] Forget   [n] Keep`, 'y forget · n keep').then((yes) => {
            note(yes && mem.forget(e.id) ? `forgot ${e.id}` : 'memory kept');
          });
          return true;
        }
        if (sub === 'refresh') {
          if (!repo) indexRepo(); else indexRepo(true);
          const r = await syncMemory();
          const v = mem.validate();
          note(r instanceof Error ? `/memory refresh: ${r.message}` : `memory refreshed: repository notes re-derived${r ? ` (${r.added} added, ${r.removed} removed)` : ''} · ${v.stale} marked stale · ${v.restored} restored\n${mem.summary()}`);
          return true;
        }
        if (sub === 'add') {
          if (!ref) { note('usage: /memory add <decision or convention>'); return true; }
          const e = mem.upsert({ category: /\b(nam(e|ing)|style|format|tests?|lint|imports?)\b/i.test(ref) ? 'convention' : 'decision', status: 'verified', source: 'user', content: ref, scope: mem.scope || undefined });
          note(e ? `remembered ${e.id}: ${e.content}` : 'not stored: it looks like it contains a secret');
          return true;
        }
        note('usage: /memory [list|inspect <id>|forget <id>|refresh|add <text>]');
        return true;
      }
      case '/why':
        note(`${formatWhy(diag?.rec ?? lastRecord, (m) => router.displayName(m))}\n\n${explainDecision(skillDecision)}`);
        return true;
      case '/graph': {
        if (!arg) { note('usage: /graph <file-or-symbol>   e.g. /graph src/orders/service.ts · /graph OrderService · /graph Server.Start'); return true; }
        const t0 = Date.now();
        let g;
        try { g = await ensureGraph(true); } catch (e) { note(`/graph: ${e instanceof Error ? e.message : String(e)}`); return true; }
        note(`${formatGraph(g, arg)}\n${activity.dim(graphStats(g, t0))}`);
        return true;
      }
      case '/workspace': {
        const [sub, ...rest] = arg.split(/\s+/);
        const w = workspace ?? new Workspace(cwd, router.config.workspace);
        if (!w.configured) { note(w.format()); return true; }
        if (sub === 'refresh' || !workspaceBuild) await buildWorkspace();
        const built = await workspaceBuild!;
        if (built instanceof Error) { note(`/workspace: ${built.message}`); return true; }
        if (!sub || sub === 'refresh') { note(built.format()); return true; }
        if (sub === 'impact') { const target = rest.join(' '); note(target ? await built.impact(target) : 'usage: /workspace impact <endpoint|file|symbol>   e.g. /workspace impact GET /api/v1/orders'); return true; }
        note('usage: /workspace [refresh | impact <endpoint|file|symbol>]');
        return true;
      }
      case '/models': {
        const [sub, ...rest] = arg.split(/\s+/);
        if (sub !== 'stats') { note('usage: /models stats [low|medium|high] [category words]   (/model selects a model)'); return true; }
        note(formatProfile(feedback.load(), parseFilter(rest.join(' ')), (m) => router.displayName(m)));
        return true;
      }
      case '/benchmark': {
        const [mode, ...rest] = arg.split(/\s+/).filter(Boolean);
        const prevOf = (m: 'mock' | 'real') => [...loadRuns()].reverse().find((r) => r.mode === m);
        if (!mode || mode === 'mock') {
          const ids = rest.length ? rest : undefined;
          const unknown = (ids ?? []).filter((i) => !SCENARIOS.some((s) => s.id === i));
          if (unknown.length) { note(`unknown scenario ${unknown.join(', ')}; available: ${SCENARIOS.map((s) => s.id).join(', ')}`); return true; }
          const run: StoredRun = { at: Date.now(), mode: 'mock', results: await runMock(router.config, router.models, ids) };
          const prev = prevOf('mock');
          try { saveRun(run); } catch { /* results are optional */ }
          note(formatRun(run, prev));
          return true;
        }
        if (mode !== 'real') { note('usage: /benchmark [mock [ids…]] | /benchmark real [samples 1-10] [ids…]'); return true; }
        if (!opts.benchSession) { note('real benchmarks are not available in this session'); return true; }
        const samples = rest[0] && /^\d+$/.test(rest[0]) ? Number(rest.shift()) : 3;
        const ids = rest.length ? rest : undefined;
        const runnable = SCENARIOS.filter((s) => s.real && (!ids || ids.includes(s.id)));
        if (!runnable.length || samples < 1 || samples > 10) { note(`nothing to run: samples must be 1-10; runnable scenarios: ${SCENARIOS.filter((s) => s.real).map((s) => s.id).join(', ')}`); return true; }
        const yes = await askYesNo(`Run REAL benchmarks?\n  ${runnable.map((s) => s.name).join(', ')} · ${samples} sample${samples === 1 ? '' : 's'} each = ${runnable.length * samples} Codex executions in temporary repositories.\n  This uses your Codex quota. Your repositories are not touched.\n\n[y] Run   [n] Cancel`, 'y run · n cancel');
        if (!yes) { note('real benchmark cancelled'); return true; }
        try {
          const run: StoredRun = { at: Date.now(), mode: 'real', results: await runReal(router.config, router.models, { session: opts.benchSession }, { confirmed: true, samples, ids, onProgress: (m) => activity.spin(`Benchmark: ${m}`) }) };
          activity.stopSpin();
          const prev = prevOf('real');
          try { saveRun(run); } catch { /* optional */ }
          note(formatRun(run, prev));
        } catch (e) { activity.stopSpin(); note(`/benchmark real: ${e instanceof Error ? e.message : String(e)}`); }
        return true;
      }
      case '/budget':
        note([...formatLimits(limitsFrom(router.config)), '', ...(lastBudget ? lastBudget.format(lastBudget === budget && (chat.busy || Boolean(staged)) ? 'Current request' : 'Last request') : ['No request has run in this session yet.']), '', 'Configure: stages.max_stages / max_escalations / max_switches, self_healing.max_repair_attempts, budget.max_duration_ms / max_input_tokens / max_output_tokens'].join('\n'));
        return true;
      case '/continue': {
        const c = continuation;
        if (!c) { note('Nothing to continue: no request was stopped by the budget.'); return true; }
        continuation = undefined;
        // an explicit user continuation: a normal request (routing, approvals, checkpoints, verification all apply) with a fresh budget
        queue.unshift(`Continue the previous request: "${c.request.split('\n')[0].slice(0, 200)}". It was stopped at an execution boundary (${c.reason}). Still to do: ${c.unfinished.join('; ')}. Keep the work already done; do not redo it.`); // runs as soon as this command finishes
        return true;
      }
      case '/feedback': {
        if (arg === 'off' || arg === 'on') { feedback.influence = arg === 'on'; note(`routing feedback influence: ${arg} for this session (outcomes are still recorded${router.config.feedback.enabled ? '' : ' — except recording is disabled in the config'})`); return true; }
        if (arg === 'reset') {
          void askYesNo('Delete all recorded routing outcomes? Routes return to the deterministic defaults.\n\n[y] Delete   [n] Keep', 'y delete · n keep').then((yes) => { note(yes ? `routing feedback reset (${feedback.reset()} outcomes deleted)` : 'routing feedback kept'); });
          return true;
        }
        if (arg) { note('usage: /feedback [reset | off | on]'); return true; }
        note(feedback.format());
        return true;
      }
      case '/api-check': {
        const root = await verifyRoot();
        const t0 = Date.now();
        try { note(`${formatContracts(await checkContracts(root, arg || undefined))}\n${activity.dim(`${Date.now() - t0}ms`)}`); } catch (e) { note(`/api-check: ${e instanceof Error ? e.message : String(e)}`); }
        return true;
      }
      case '/impact': {
        const t0 = Date.now();
        let g;
        try { g = await ensureGraph(true); } catch (e) { note(`/impact: ${e instanceof Error ? e.message : String(e)}`); return true; }
        if (arg) { const r = predictImpact(g, arg); note(`${typeof r === 'string' ? r : formatImpact(r)}\n${activity.dim(graphStats(g, t0))}`); return true; }
        // no argument: the actual uncommitted changes (working tree vs HEAD)
        let files;
        try { files = await listChanges(cwd); } catch (e) { note(`/impact: ${e instanceof Error ? e.message : String(e)}`); return true; }
        const changes = files.map((f) => ({ path: path.relative(g.root, path.resolve(cwd, f.path)), kind: f.status === 'D' ? 'deleted' as const : f.status === '?' || f.status === 'A' ? 'added' as const : 'modified' as const }));
        if (!changes.length) { note('No uncommitted changes. Use /impact <file-or-symbol> to predict the impact of a planned change.'); return true; }
        note(`${formatImpact(await analyzeChanges(g, changes))}\n${activity.dim(graphStats(g, t0))}`);
        return true;
      }
      case '/diagnostics': {
        const h = await diagHistory();
        if (!arg) { note(formatDiagnostics(lastRecord ?? h.list()[0], (m) => router.displayName(m))); return true; }
        const all = h.list();
        if (arg === 'history' || arg === 'list') {
          if (!all.length) { note('No executions recorded for this project yet.'); return true; }
          if (!live) { note(all.map((r, i) => `${i + 1}. ${r.id}  ${new Date(r.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}  ${r.status.padEnd(9)} ${r.routing ? router.displayName(r.routing.model) : '?'}  ${r.title}`).join('\n') + '\n/diagnostics <n|id> for details'); return true; }
          diagPicker = { picker: new SessionPicker(all.map((r) => ({ id: r.id, title: `${r.status === 'completed' ? '✓' : r.status === 'cancelled' ? '!' : '✗'} ${r.title}${r.routing ? ` · ${router.displayName(r.routing.model)}` : ''}${r.ms !== undefined ? ` · ${Math.round(r.ms / 1000)}s` : ''}`, updatedAt: r.at / 1000 })), null, 'Execution history', 'view details', 'No executions recorded for this project yet.'), all };
          paintOverlay();
          return true;
        }
        const r = /^\d+$/.test(arg) ? all[Number(arg) - 1] : all.find((x) => x.id === arg || x.id.startsWith(arg));
        note(r ? formatDiagnostics(r, (m) => router.displayName(m), true) : `no execution ${sanitize(arg, 40)} (see /diagnostics history)`);
        return true;
      }
      case '/checkpoints': {
        const st = await checkpoints();
        if (typeof st === 'string') { note(st); return true; }
        const all = st.list();
        note(all.length ? `${all.map(cpLine).join('\n')}\n/rollback [id] to undo one` : 'No checkpoints yet — one is recorded automatically before each turn that can modify files.');
        return true;
      }
      case '/rollback': {
        const st = await checkpoints();
        if (typeof st === 'string') { note(st); return true; }
        if (arg) {
          const m = findCheckpoint(st, arg);
          if (typeof m === 'string') note(m); else proposeRollback(st, m.id);
          return true;
        }
        const open = st.list().filter((m) => m.status !== 'rolled-back');
        if (!live) { note(open.length ? `${open.map(cpLine).join('\n')}\nuse /rollback <id>` : 'No checkpoints to roll back.'); return true; }
        cpPicker = new SessionPicker(open.map((m) => ({ id: m.id, title: `${m.task || '(no description)'} · ${m.changes.length} file${m.changes.length === 1 ? '' : 's'}${m.status === 'active' ? '' : ` · ${m.status}`}`, updatedAt: m.createdAt / 1000 })), null, 'Roll back a checkpoint', 'review', 'No checkpoints to roll back.');
        paintOverlay();
        return true;
      }
      case '/usage': {
        note(formatUsage(await fetchUsage(client), chat.usage));
        return true;
      }
      case '/new':
        chat.reset(); router.reset(); ticket.reset(); retriever.reset(); metrics.reset(); workspace?.reset(); compactor.reset(); sessionFiles.clear(); knownFailures = []; void openMemory().then((m) => { if (!(m instanceof Error)) m.reset(); });
        resetApproval();
        note('new conversation');
        return true;
      case '/resume': {
        let id = arg;
        if (!arg && live) {
          const page = await chat.listPage({ limit: 50 });
          sessions = new SessionPicker(page.items, page.nextCursor);
          sessionPages = 1;
          paintOverlay();
          return true;
        }
        if (!arg) {
          listed = await chat.list();
          note(listed.length ? listed.map((t, i) => `${i + 1}. ${t.preview || '(no preview)'}  [${t.id.slice(0, 8)}]`).join('\n') + '\nuse /resume <number>' : 'no saved conversations here');
          return true;
        }
        if (/^\d+$/.test(arg)) {
          const t = listed[Number(arg) - 1];
          if (!t) { note('run /resume first, then pick a listed number'); return true; }
          id = t.id;
        }
        await resumeThread(id);
        return true;
      }
      default:
        note(`unknown command ${name}. Commands: ${commandNames()} (/help for details)`);
        return true;
    }
  };

  if (opts.resume) {
    try {
      const id = opts.resume === 'last' ? (await chat.list(1))[0]?.id : opts.resume;
      if (id) { await chat.resume(id); note(`resumed ${id.slice(0, 8)} (${chat.model ?? '?'})`); await showHistory(id); } else note('no saved conversation to resume');
    } catch (e) { note(`resume failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return new Promise<number>((resolve) => {
    let finished = false;
    let quitWhenIdle = false;
    const finish = async (code: number) => {
      if (finished) return;
      finished = true;
      closing = true;
      await finishCheckpoint(true, true); // quitting mid-turn: keep what was recorded, marked interrupted
      activity.dispose();
      output.off('resize', onResize);
      for (const [sig] of SIGNALS) process.off(sig, onSignal);
      composer.stop();
      screen.stop();
      await client.close().catch(() => undefined);
      resolve(code);
    };
    // EOF (Ctrl-D on an empty input / piped input ends): a running turn finishes first.
    h.eof = () => {
      pendingConfirm?.(false);
      pendingApproval?.('decline');
      pendingApproval = undefined;
      if (chat.busy || cmdBusy) quitWhenIdle = true; else void finish(0);
    };
    // Ctrl-C: interrupt a running turn (declining any pending approval); with a draft, clear it; otherwise quit.
    h.interrupt = () => {
      const running = chat.busy || Boolean(staged); // a staged request is running even between its turns
      if (pendingConfirm) return pendingConfirm(false);
      if (verifyAbort) { verifyAbort.abort(); stageCancel = true; note('verification cancelled'); return; }
      if (healing && !running) { stageCancel = true; note('stopping self-healing…'); return; }
      if (!running && !cmdBusy && !composer.isEmpty) return composer.clear();
      if (!running || interrupting) return void finish(130);
      interrupting = true;
      stageCancel = true; // no further stages start
      if (queue.length) { note(`queue cleared (${queue.length})`); queue.length = 0; paintOverlay(); }
      if (pendingApproval) { composer.restore(); composer.setPlaceholder(IDLE_PLACEHOLDER); }
      pendingApproval?.('cancel');
      pendingApproval = undefined;
      activity.resume();
      activity.setLabel('Cancelling...');
      note('interrupting… (Ctrl-C again to quit)');
      if (chat.busy) chat.interrupt().catch((e: unknown) => note(`interrupt failed: ${e instanceof Error ? e.message : String(e)}`));
    };

    // External termination (kill, closing the terminal window, `kill -INT`): restore the terminal and stop the
    // App Server instead of dying mid-render. A second signal while shutting down forces the exit.
    const onSignal = (sig: NodeJS.Signals) => {
      const code = 128 + (SIGNALS.find(([s]) => s === sig)?.[1] ?? 15);
      if (finished) return process.exit(code);
      void finish(code);
    };
    for (const [sig] of SIGNALS) process.on(sig, onSignal);

    let reconnects = 0;
    const watch = (c: AppClient) => c.onClose((e) => { if (c === client && !closing) void recover(e); });
    const recover = async (e: Error) => {
      if (!opts.reconnect || reconnects >= MAX_RECONNECTS) {
        write(`\nlumina: Codex App Server exited${opts.reconnect ? ' repeatedly' : ''}. ${e.message.split('\n')[0]}\nRun \`lumina --resume\` to continue this conversation.\n`);
        return void finish(1);
      }
      reconnects++;
      cmdBusy = true;
      note('Codex App Server exited; reconnecting…');
      try {
        client = await opts.reconnect();
        chat.attach(client);
        catalog.attach(client);
        watch(client);
        const id = chat.threadId;
        if (id) await chat.resume(id);
        note('reconnected; conversation restored. Resend your last message if it did not finish.');
      } catch (err) {
        write(`\nlumina: reconnect failed: ${err instanceof Error ? err.message : String(err)}\n`);
        return void finish(1);
      } finally { cmdBusy = false; }
    };
    watch(client);

    const ANSWERS: Record<string, Decision> = { y: 'accept', yes: 'accept', a: 'acceptForSession', always: 'acceptForSession', n: 'decline', no: 'decline', '': 'decline', c: 'cancel', cancel: 'cancel' };
    // Leading/trailing blank lines are dropped; inner newlines and indentation are preserved.
    const trimBlank = (s: string) => s.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
    const busyNow = () => chat.busy || cmdBusy || Boolean(staged) || Boolean(pendingConfirm);
    /** Ticket state after a turn: remember the explanation, whether the ticket was fetched, and where we are. */
    const afterTicketTurn = (ok: boolean, tools: string[]) => {
      ticket.afterTurn(answer, tools, ok);
      if (ticket.ticket && ticket.mode === 'ready') note(`Ticket: ${ticket.ticket.id} · Mode: Ready for implementation · Requirements: updated (${ticket.clarifications.length} clarification${ticket.clarifications.length === 1 ? '' : 's'}) · say "kerjakan" / "implement it" to start`);
      refreshFooter();
    };
    /** After a turn or command: run the next queued prompt, if any. */
    const done = () => {
      if (quitWhenIdle) return void finish(0);
      if (queue.length) setTimeout(() => {
        if (finished || busyNow() || !queue.length) return;
        const next = queue.shift()!;
        paintOverlay();
        h.submit(next);
      }, 0);
    };
    enqueue = (t: string) => {
      composer.clear();
      if (!busyNow()) { h.submit(t); return; } // nothing running: Tab just sends
      queue.push(t);
      paintOverlay();
    };

    /** Returns false when the draft must be kept (a turn is running). */
    h.submit = (raw: string): boolean => {
      const text = trimBlank(raw);
      const imgs = imagesIn(text);
      if (pendingConfirm) {
        const a = text.toLowerCase();
        if (!['y', 'yes', 'n', 'no', ''].includes(a)) { write('Please answer y or n\n'); return true; }
        pendingConfirm(a === 'y' || a === 'yes');
        return true;
      }
      if (pendingApproval) {
        const d = ANSWERS[text.toLowerCase()];
        if (!d) { write('Please answer y, a, n or c\n'); return true; }
        const resolve = pendingApproval;
        pendingApproval = undefined;
        composer.restore();
        composer.setPlaceholder(IDLE_PLACEHOLDER);
        activity.resume();
        resolve(d);
        return true;
      }
      if (!text) return true; // never send empty prompts
      if (text === 'exit' || text === 'quit' || text === '/exit') {
        if (!chat.busy && !cmdBusy) { void finish(0); return true; }
        quitWhenIdle = true; // let the running turn finish; Ctrl-C force-quits
        note('exiting after the current turn (Ctrl-C to force)');
        return true;
      }
      if (chat.busy || cmdBusy) { note('(busy: draft kept, submit again when the turn ends)'); return false; }

      // Conversation history: show exactly what was submitted (multi-line preserved).
      if (output.isTTY) write(`${text.split('\n').map((l, i) => `${i === 0 ? '›' : ' '} ${l}`).join('\n')}\n\n`);

      if (text.startsWith('/') && !text.includes('\n')) {
        cmdBusy = true;
        void command(text).catch((e: unknown) => note(e instanceof Error ? e.message : String(e)))
          .finally(() => { cmdBusy = false; done(); });
        return true;
      }
      // ticket workflow: understanding/clarifying is read-only; implementation only when asked
      const tturn = ticket.prepare(text);
      const prompt = tturn?.prompt ?? text;
      const reading = Boolean(tturn?.readOnly);
      let pick;
      try { pick = router.pick(tturn?.routeText ?? text); } catch (e) { note(e instanceof Error ? e.message : String(e)); done(); return true; }
      // understanding a ticket is light work: the efficient model unless the request itself is complex
      if (reading && !router.model && !router.reasoning) {
        pick = { ...pick, sel: readingSelection(pick.route, text, ticket, router.models, router.config) };
      }
      // a pinned /model or /reasoning (or execution_strategy=direct), or a read-only ticket turn: plain single turns
      const plan: ExecutionPlan | undefined = router.model || router.reasoning || reading ? undefined : planExecution(prompt, pick.route, router.config, pick.sel);
      const executor = plan && plan.strategy !== 'direct' ? plan : undefined;
      budget = new Budget(limitsFrom(router.config), pick.route.risk === 'high');
      lastBudget = budget;
      continuation = undefined;
      diag = new Diagnostic(router.config.analytics.store_prompts ? text.split('\n')[0] : `${pick.route.tier} task (${pick.route.risk} risk)`, router.config.diagnostics.max_events);
      diag.rec.title = router.config.analytics.store_prompts ? sanitize(text.split('\n')[0], 80) : `${pick.route.tier} task (${pick.route.risk} risk)`;
      diag.routed(pick.route, pick.sel, router.model ? 'manual /model override' : router.reasoning ? 'manual /reasoning override' : reading ? 'ticket understanding (read-only turn on the efficient model)' : pick.sticky ? 'kept from the previous turn (vague follow-up)' : 'automatic routing', executor?.strategy ?? 'direct');
      if (tturn && ticket.ticket) {
        const mode = tturn.intent === 'understand' ? 'Understanding' : tturn.intent === 'clarify' ? 'Clarifying' : 'Implementing';
        note(`Ticket: ${ticket.ticket.id} · Mode: ${mode} · Model: ${router.displayName(pick.sel.model ?? '')} · Reasoning: ${cap(pick.sel.effort ?? '')}${reading ? ' · read-only' : ''}${tturn.intent === 'confirm' && ticket.clarifications.length ? ` · ${ticket.clarifications.length} clarification(s) applied` : ''}`);
      }
      if (pick.route.reference_chars > 0) note(`routed on your request · ${Math.round(pick.route.reference_chars / 100) / 10}k chars of pasted ticket/docs passed as context only`);
      lastPick = { model: pick.sel.model ?? '', effort: pick.sel.effort ?? '' };
      if (live) refreshFooter(); // the status bar shows the active model/effort
      else if (!executor || executor.stages.length === 1) note(`[${pick.route.tier} · ${pick.sel.model}/${pick.sel.effort}${pick.sticky ? ' · same as previous turn' : ''}]`);
      const name = (m?: string) => (m ? router.displayName(m) : '?');
      const mark = (st: Stage['status']) => ({ done: '✓', failed: '✗', skipped: '–', running: '●', pending: ' ' } as Record<string, string>)[st];
      const checklist = (list: Stage[], models: string[]) => {
        const w = Math.max(...list.map((x) => x.title.length));
        return list.map((x, k) => `[${mark(x.status)}] ${x.title.padEnd(w)}  ${name(x.model ?? models[k])}${x.ms !== undefined ? `  ${Math.round(x.ms / 1000)}s` : ''}`).join('\n');
      };
      /**
       * Executes through the stage engine: one turn for the request itself, more only when execution needs them. Every
       * model shown is the model actually sent for that turn.
       */
      const runStaged = (p: ExecutionPlan, skills: SkillInfo[]) => {
        stageCancel = false;
        cmdBusy = true;
        if (skills.length) note(skillNote(skills));
        if (imgs.length) note(`images: ${imgs.length} attached`);
        answer = '';
        activity.setLabel(chat.threadId ? 'Thinking...' : 'Connecting...');
        let many = p.stages.length > 1;
        const stagedItems: TurnItem[] = [];
        const exec = new StagedExecution(prompt, p, {
          cfg: router.config, catalog: router.models,
          send: (prompt, sel, o) => chat.send(prompt, sel, o.first ? skills : [], { isolated: o.isolated, images: o.first ? imgs : undefined }).then((res) => { stagedItems.push(...(res.items ?? [])); return res; }),
          interrupt: () => chat.interrupt(),
          cancelled: () => stageCancel,
          context: () => chat.contextTokens(),
          compact: stageCompact,
          log: stageLog,
          budget,
          requestId: diag?.id,
          hooks: {
            planned: (pl, models) => {
              if (pl.strategy === 'orchestrated') activity.notice(`Task: ${text.split('\n')[0].slice(0, 70)}\nStrategy: Orchestrated · Stages: ${pl.stages.length}\n${checklist(pl.stages, models)}`);
              else activity.notice(activity.dim(`Strategy: Direct · Model: ${name(models[0])} · Stages: 1`));
            },
            stageStart: (st, i, n, sel, sw) => {
              if (n > 1) many = true;
              if (sw) activity.notice(`↪ Switching model\n  ${name(sw.from)} → ${name(sw.to)}\n  ${activity.dim(`Reason: ${sw.reason}`)}`);
              if (many) activity.notice(`[●] ${i + 1}/${n} ${st.title} · ${name(sel.model)} · ${sel.effort}${st.thread === 'isolated' ? ' · fresh thread' : ''}`);
              activity.context = many ? `${i + 1}/${n} ${name(sel.model)} · ` : '';
              lastPick = { model: sel.model ?? '', effort: sel.effort ?? '' };
              showModel();
              activity.setLabel('Thinking...');
              refreshFooter();
            },
            stageEnd: (st, _i, n) => { if (n > 1) activity.notice(`[${mark(st.status)}] ${st.title} · ${name(st.model)} · ${Math.round((st.ms ?? 0) / 1000)}s`); },
            notice: (t) => note(t),
          },
        }, pick.sel, pick.route.risk === 'high' ? ['security-sensitive: keep existing safeguards'] : []);
        staged = exec;
        void exec.run().then((r) => {
          const used = r.stages.filter((x) => x.status !== 'skipped');
          if (used.length > 1) {
            const tok = r.usageReported ? ` · Tokens: in ${r.usage.inputTokens.toLocaleString('en-US')} (cached ${r.usage.cachedInputTokens.toLocaleString('en-US')}) out ${r.usage.outputTokens.toLocaleString('en-US')}` : '';
            activity.notice(`Strategy: ${r.strategy[0].toUpperCase()}${r.strategy.slice(1)} · Stages: ${used.length} · Models: ${used.map((x) => name(x.model)).join(' → ')} · Switches: ${r.switches}${r.escalations ? ` · Escalations: ${r.escalations}` : ''}${tok}`);
          }
          // the main thread did not see isolated stages: carry a compact note into the user's next turn
          if (r.stages.some((x) => x.thread === 'isolated')) chat.queueContext(`[Lumina context: ${JSON.stringify({ completed: exec.ctx.completed, modified_files: exec.ctx.modified_files, known_issues: exec.ctx.known_issues })}]`);
          activity.context = '';
          activity.end(r.status, r.error);
          if (tturn) afterTicketTurn(r.status === 'completed', []);
          recordMetrics({ memory: memStats, retrieval: ret, skills: skillInfo(skills), stages: used.length, switches: r.switches, usage: r.usageReported ? r.usage : undefined, items: stagedItems, status: r.status });
          for (const st of r.stages.filter((x) => x.status !== 'pending')) diag?.stage({ type: st.type, title: st.title, model: st.model, effort: st.effort, status: st.status, ms: st.ms, thread: st.thread, escalation: st.escalation });
          outcome = { status: r.status, error: r.error, usage: r.usageReported ? r.usage : undefined };
          if (r.stopped && budget) reportStop(budget, text);
          return r.status !== 'completed';
        }, (e: unknown) => {
          activity.context = '';
          activity.end('failed', e instanceof Error ? e.message : String(e));
          outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
          return true;
        }).then(async (cut) => { const m = await finishCheckpoint(cut); staged = undefined; if (!cut) await verifyAndHeal(turnChanges(m, stagedItems), text, stagedItems); })
          .finally(async () => { staged = undefined; await finishDiag(outcome.status, outcome.error, outcome.usage).catch(() => undefined); cmdBusy = false; interrupting = false; done(); });
      };
      const start = (skills: SkillInfo[]) => {
        if (executor) return runStaged(executor, skills);
        diag?.event('execution_started', { model: pick.sel.model, effort: pick.sel.effort });
        logRouting({ level: 'info', event: 'route_selected', request_id: diag?.id ?? `req_${Date.now().toString(36)}`, execution_id: diag?.id ?? '-', routing_strategy: 'single', selected_model: pick.sel.model, routing_reason: pick.route.tier, escalation_level: 0 }, router.config);
        if (skills.length) note(skillNote(skills));
        if (imgs.length) note(`images: ${imgs.length} attached`);
        answer = '';
        activity.setLabel(chat.threadId ? 'Thinking...' : 'Connecting...');
        budget?.beginTurn();
        void chat.send(prompt, pick.sel, skills, { images: imgs, readOnly: reading }).then((r) => {
          interrupting = false;
          activity.end(r.status === 'interrupted' ? 'cancelled' : r.status === 'failed' || r.error ? 'failed' : 'completed', r.error);
          if (tturn) afterTicketTurn(r.status === 'completed' && !r.error, (r.items ?? []).filter((i) => i.type === 'mcpToolCall').map((i) => i.tool ?? ''));
          recordMetrics({ memory: memStats, retrieval: ret, skills: skillInfo(skills), stages: 1, switches: 0, usage: r.usage, items: r.items ?? [], status: r.status });
          turnItems = r.items ?? [];
          const st = r.status === 'interrupted' ? 'cancelled' : r.status === 'failed' || r.error ? 'failed' : 'completed';
          diag?.stage({ type: 'task', title: 'Execute request', model: pick.sel.model, effort: pick.sel.effort, status: st === 'completed' ? 'done' : st === 'cancelled' ? 'skipped' : 'failed', ms: diag ? Date.now() - diag.rec.at : undefined, thread: 'shared' });
          outcome = { status: st, error: r.error, usage: r.usage };
          if (budget) { budget.stages = 1; budget.turn(r.usage); }
          return r.status !== 'completed' || Boolean(r.error);
        }, (e: unknown) => {
          interrupting = false;
          activity.end('failed', e instanceof Error ? e.message : String(e));
          outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e) };
          return true;
        }).then(async (cut) => {
          const m = await finishCheckpoint(cut);
          if (cut || reading) return;
          cmdBusy = true;
          await verifyAndHeal(turnChanges(m, turnItems), text, turnItems).finally(() => { cmdBusy = false; });
        }).finally(async () => { await finishDiag(outcome.status, outcome.error, outcome.usage).catch(() => undefined); done(); });
      };
      let ret: Retrieval | undefined; // this request's retrieval, for /context
      let turnItems: TurnItem[] = [];
      let outcome: { status: 'completed' | 'failed' | 'cancelled'; error?: string; usage?: TokenBreakdown } = { status: 'completed' };
      let memStats: RequestMetrics['memory'];
      const skillInfo = (sk: SkillInfo[]) => ({ names: sk.map((k) => k.name), mode: skillDecision?.mode ?? 'none' });
      /**
       * Before this turn starts (no inference is running): compact the conversation if it pays off, then restate the
       * critical context deterministically so it survives whatever the summary keeps.
       */
      const boundaryCompaction = async () => {
        if (!chat.threadId || reading) return;
        const ctx = chat.contextTokens();
        const d = compactor.decide(ctx);
        if (!d.compact) return;
        activity.setLabel('Compacting conversation...');
        const rec = await compactor.run('turn boundary', ctx, d.reason);
        diag?.event('context_compacted', { trigger: 'turn boundary', ok: rec.ok, before: rec.before ?? null, ms: rec.ms });
        if (!rec.ok) { note(`compaction did not complete (${rec.ms}ms); continuing with the full conversation`); return; }
        const mem = await openMemory();
        const decisions = mem instanceof Error ? [] : mem.list().filter((e) => e.source === 'user' && Date.parse(e.created) >= sessionStart && e.status !== 'stale').map((e) => e.content);
        const block = preservedContext({
          ticket: ticket.ticket ? { id: ticket.ticket.id, mode: ticket.mode, clarifications: ticket.clarifications } : undefined,
          decisions, files: [...sessionFiles], failures: knownFailures,
          pending: [...queue.map((q) => `queued request: ${q.split('\n')[0].slice(0, 80)}`), ...(ticket.mode === 'ready' ? ['ticket implementation awaits confirmation'] : [])],
          approval: `${approvalMode} mode${(opts.policy ?? DEFAULT_POLICY).sandbox === 'read-only' ? ', read-only sandbox' : ''}${workspace ? '; other workspace repositories are read-only unless workspace.allow_writes' : ''}`,
          constraints: pick.route.risk === 'high' ? ['security-sensitive work: keep existing safeguards'] : [],
        });
        if (block) chat.queueContext(block);
        note(`conversation compacted (${d.reason}; ${rec.ms}ms) · critical context restated · /context for details`);
      };
      // a turn that may modify files is wrapped in a checkpoint (not read-only ticket turns or a read-only session)
      const launch = (skills: SkillInfo[]) => {
        cmdBusy = true;
        const snapshot = reading || (opts.policy ?? DEFAULT_POLICY).sandbox === 'read-only' ? Promise.resolve() : beginCheckpoint(text.split('\n')[0]);
        // retrieval runs while the checkpoint is taken; it never fails the turn and is capped by its timeout
        // memory never delays a turn by more than the retrieval budget; decisions are still recorded when it is late
        const remember = (mem: ProjectMemory) => { for (const e of mem.rememberFromRequest(splitPrompt(text).instruction)) note(`remembered ${e.category} ${e.id}: ${e.content.slice(0, 80)} (/memory forget ${e.id} to undo)`); };
        const late = Symbol('late');
        const memo = Promise.race([openMemory(), new Promise<typeof late>((r) => setTimeout(() => r(late), router.config.retrieval.timeout_ms).unref())]).then((mem) => {
          if (mem === late) { void openMemory().then((m) => { if (!(m instanceof Error)) remember(m); }); return; }
          if (mem instanceof Error) return;
          remember(mem);
          const r = mem.retrieve(tturn?.routeText ?? text);
          memStats = r.block ? { entries: r.entries.length, chars: r.block.length, ms: r.ms } : undefined;
          if (diag && memStats) { diag.rec.context = { ...diag.rec.context, memoryEntries: memStats.entries }; diag.event('memory_retrieved', { entries: memStats.entries }); }
          if (r.block) { chat.queueContext(r.block); note(`project memory: ${r.entries.length} note${r.entries.length === 1 ? '' : 's'}`); }
        }, () => undefined);
        const hints = retriever.retrieve(tturn?.routeText ?? text).then((r) => {
          ret = r;
          if (diag) { const hinted = r.block ? r.hints.filter((h) => r.block!.includes(`- ${h.path}`)).length : 0; diag.rec.context = { ...diag.rec.context, retrievalMs: r.ms, hinted, candidates: r.stats?.candidates, skipped: r.skipped }; diag.event('context_retrieved', { ms: r.ms, hinted, skipped: r.skipped ?? null }); }
          if (r.block) { chat.queueContext(r.block); note(`context hints: ${r.block.split('\n').length - 1} file${r.block.split('\n').length === 2 ? '' : 's'}`); }
        });
        // related code in other configured repositories: only facts matching this request, only if already linked
        const ws = workspace && workspaceBuild ? Promise.race([workspaceBuild, new Promise<undefined>((r) => setTimeout(() => r(undefined), router.config.retrieval.timeout_ms).unref())]).then((w) => {
          const block = w instanceof Workspace ? w.hints(tturn?.routeText ?? text) : undefined;
          if (block) { chat.queueContext(block); note(`workspace: ${block.split('\n').length - 1} cross-repository fact${block.split('\n').length === 2 ? '' : 's'}`); }
        }, () => undefined) : Promise.resolve();
        void Promise.all([snapshot, hints, memo, ws]).then(() => boundaryCompaction()).catch(() => undefined).finally(() => { cmdBusy = false; start(skills); });
      };
      // immediate feedback: the turn is shown as started before checkpoints, skills or the thread are ready
      showModel();
      activity.begin('Preparing...');
      // skills: explicit $name items, or an automatic deterministic match; Codex loads the SKILL.md itself (lazily).
      // Skill metadata comes from the cached skills/list; if it is unavailable the turn simply runs without skills.
      const auto = router.config.skills;
      if (text.includes('$') || auto.auto_select) {
        cmdBusy = true;
        void catalog.load().then((all) => selectSkills(text, all, { auto: auto.auto_select, maxAuto: auto.max_auto }), () => undefined).then((d) => {
          skillDecision = d;
          if (d && diag) { diag.rec.skills = { mode: d.mode, names: (d.mode === 'explicit' ? d.explicit : d.selected.map((p) => p.skill)).map((s) => s.name) }; if (diag.rec.skills.names.length) diag.event('skill_selected', { skills: diag.rec.skills.names.join(' '), mode: d.mode }); }
          cmdBusy = false;
          launch(d ? (d.mode === 'explicit' ? d.explicit : d.selected.map((p) => p.skill)) : []);
        });
      } else { skillDecision = undefined; launch([]); }
      return true;
    };

    composer.setPlaceholder(IDLE_PLACEHOLDER);
    refreshFooter();
    composer.start();
    paintInput();
  });
}

const USAGE = `lumina [--cwd DIR] [--resume [ID]] [--read-only] [--approval manual|smart|auto] [--help] [--version]
  Interactive Codex chat with automatic model/reasoning routing (uses your existing Codex login).
  --resume [ID]  continue the latest (or given) conversation for this directory
  --read-only    read-only sandbox, never ask for approval
  --approval M   start in approval mode manual (default), smart or auto; change with /approval
  In chat: type / for commands (/help lists them) · Ctrl-C interrupts a turn, again to quit`;
function packageVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++, dir = path.dirname(dir)) {
      const f = path.join(dir, 'package.json');
      if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')) as { name?: string; version?: string }; if (j.name === 'lumina-mcp' && j.version) return j.version; }
    }
  } catch { /* fall through */ }
  return 'dev';
}
const VERSION = packageVersion();

export async function main(argv = process.argv.slice(2)): Promise<number> {
  // `--resume` without an id means "latest"
  const argvFixed = argv.flatMap((a, i) => (a === '--resume' && (i === argv.length - 1 || argv[i + 1].startsWith('-')) ? [a, 'last'] : [a]));
  let args;
  try {
    args = parseArgs({
      args: argvFixed, strict: true, allowPositionals: false,
      options: { cwd: { type: 'string' }, resume: { type: 'string' }, 'read-only': { type: 'boolean' }, approval: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } },
    }).values;
  } catch (e) {
    console.error(`lumina: ${e instanceof Error ? e.message : e}\n${USAGE}`);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.version) { console.log(`lumina ${VERSION}`); return 0; }
  if (args.approval && !(MODES as string[]).includes(args.approval)) {
    console.error(`lumina: --approval must be one of ${MODES.join(', ')}\n${USAGE}`);
    return 2;
  }
  const cwd = path.resolve(args.cwd ?? process.cwd());
  const policy: Policy = args['read-only'] ? { approvalPolicy: 'never', sandbox: 'read-only', approvalsReviewer: 'user' } : DEFAULT_POLICY;
  const spawnClient = async () => {
    const c = new AppServerClient({ cwd, clientVersion: VERSION });
    await c.start();
    return c;
  };
  let client: AppServerClient;
  try {
    client = await spawnClient();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`lumina: cannot start Codex App Server: ${msg}${/ENOENT/.test(msg) ? '\nIs the Codex CLI installed and on PATH? (npm i -g @openai/codex)' : '\nTry `codex login` and `codex doctor`.'}`);
    return 1;
  }
  try {
    // real benchmarks: a separate App Server per temporary repository, never this session's thread or repository
    const benchSession: RealDeps['session'] = async (dir) => {
      const c = new AppServerClient({ cwd: dir, clientVersion: VERSION });
      await c.start();
      const chat = new Chat(c, { cwd: dir, onDelta: () => undefined, policy: { approvalPolicy: 'never', sandbox: 'workspace-write' } });
      return { send: (p, sel, isolated) => chat.send(p, sel, [], { isolated }), context: () => chat.contextTokens(), compact: () => chat.compact(), close: async () => { await c.close(); } };
    };
    return await runTui(client, cwd, undefined, { benchSession, resume: args.resume, policy, approvalMode: args.approval as ApprovalMode | undefined, reconnect: spawnClient, version: VERSION, connection: `Codex ${/\/(\d+\.\d+\.\d+)/.exec(client.info?.userAgent ?? '')?.[1] ?? ''} connected`.replace('Codex  ', 'Codex ') });
  } catch (e) {
    console.error(`lumina: ${e instanceof Error ? e.message : e}`);
    await client.close();
    return 1;
  }
}

if (process.env.NODE_ENV !== 'test' && process.argv[1] && /lumina(\.js)?$|tui\/tui\.ts$/.test(process.argv[1])) {
  // exit code is set first so output flushes; the timer only forces an exit if something still holds the event loop
  main().then((c) => { process.exitCode = c; setTimeout(() => process.exit(c), 1500).unref(); });
}
