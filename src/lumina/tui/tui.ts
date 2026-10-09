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
import { ExecutionPlan, Stage, StagedExecution, logRouting, planExecution } from '../stages.js';
import { Composer } from './composer.js';
import { Screen } from './screen.js';
import { AppClient, ApprovalRequest, Chat, DEFAULT_POLICY, Decision, Policy, ThreadSummary } from './chat.js';
import { TurnRouter } from './routing.js';
import { COMMANDS, CommandPalette, commandNames, helpText } from './commands.js';
import { SkillCatalog, SkillInfo, SkillPicker, mentionedSkills, scopeLabel } from './skills.js';
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
  /** Real connection info for the welcome header (omitted when unknown). */
  connection?: string;
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
  const screen = new Screen(output, { live, color });
  const h = { key: (_k: Key) => false, submit: (_t: string) => true, interrupt: () => undefined as void, eof: () => undefined as void };
  const paintInput = () => { if (live) screen.setInput(composer.view(screen.columns)); };
  // slash-command palette: local, driven by the input text; overlay is shared with the skills picker
  const palette = new CommandPalette();
  let paintOverlay = () => undefined as void;
  const onInputChange = () => { paintInput(); palette.update(composer.text); paintOverlay(); };
  const composer = new Composer(input as never, output, { onSubmit: (t) => h.submit(t), onInterrupt: () => h.interrupt(), onEof: () => h.eof(), onChange: onInputChange, onKey: (k) => h.key(k) }, live);
  const activity = new Activity(screen, { animate, color });
  composer.setDim((x) => activity.dim(x));
  const IDLE_PLACEHOLDER = 'Ask Lumina anything...';
  let pendingApproval: ((d: Decision) => void) | undefined;
  let interrupting = false;
  let closing = false;
  const write = (s: string) => activity.text(s);
  const note = (m: string) => write(`${m.split('\n').map((l) => activity.dim(l)).join('\n')}\n`);
  const askManual = (r: ApprovalRequest) => new Promise<Decision>((resolve) => {
    pendingApproval = resolve;
    activity.pause();
    composer.stash(); // answers use a fresh buffer; the user's draft comes back afterwards
    composer.setPlaceholder('y approve · a for session · n reject · c cancel');
    write(`\n${activity.paintStatus('warn', '⚠')} Approval Required\n\n${r.kind === 'command' ? 'Command' : r.kind === 'mcpTool' ? 'MCP tool' : 'Changes'}:\n  ${r.summary}\n${r.detail ? `  ${activity.dim(r.detail)}\n` : ''}\n[y] Approve once   [a] Always this session   [n] Reject   [c] Cancel\n`);
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
  const chat = new Chat(client, { cwd, onDelta: write, onEvent: (m, p) => activity.event(m, p), onApproval: ask, policy: opts.policy ?? DEFAULT_POLICY });
  const router = opts.router ?? new TurnRouter(loadConfig(cwd), cwd);
  let listed: ThreadSummary[] = [];
  // Skills: metadata from Codex's own skills/list; Codex itself loads SKILL.md bodies when a skill is used.
  const catalog = new SkillCatalog(client, cwd);
  let picker: SkillPicker | undefined;
  const paint = { accent: (x: string) => activity.accent(x), dim: (x: string) => activity.dim(x) };
  // suggestions shown: up to 8, fewer on short terminals so the input always stays on screen
  const paletteRows = () => Math.max(2, Math.min(8, (output.rows || 24) - 12));
  paintOverlay = () => screen.setOverlay(picker ? picker.rows(screen.columns - 1, paint) : live && palette.open ? palette.rows(screen.columns - 1, paletteRows(), paint) : undefined);
  const paintPicker = paintOverlay;
  h.key = (k) => {
    if (!picker) {
      if (!live) return false;
      const r = palette.handle(k);
      if (typeof r === 'string') composer.replace(r); // filled, not executed: Enter again runs it
      if (r !== false) paintOverlay();
      return r !== false;
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
  let staged: StagedExecution | undefined;
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

  // ---- status bar (below the input): real routing state only ----
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const statusBar = (): string => {
    const model = router.model ?? lastPick?.model;
    const name = model ? router.displayName(model) : router.configuredModels().map((m) => router.displayName(m)).join(' ⇄ ');
    const effort = router.reasoning ? `${cap(router.reasoning)} (manual)` : lastPick ? cap(lastPick.effort) : '';
    return `  ◉ ${router.model ? 'Manual model' : 'Auto Routing'} · ${[name, effort].filter(Boolean).join(' · ')}${approvalMode !== 'manual' ? ` · Approval: ${cap(approvalMode)}` : ''}`;
  };
  const refreshFooter = () => { if (live) screen.setFooter([activity.dim(screen.fit(statusBar())), activity.dim(screen.fit(`  ${COMMANDS.filter((c) => c.hint).map((c) => c.name).join('  ')}`))]); };

  // ---- welcome ----
  const home = os.homedir();
  const shownCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  write(`${activity.accent('◆')} Lumina CLI${opts.version ? ` v${opts.version}` : ''}\n${activity.dim('  Adaptive AI Coding Assistant')}\n\n  ${router.configuredModels().map((m) => router.displayName(m)).join(' ⇄ ')} · Auto Routing\n  ${shownCwd}${opts.connection ? activity.dim(`  ·  ${opts.connection}`) : ''}\n${tty ? '' : `${activity.dim(`  ${commandNames()}`)}\n`}\n`);

  // Terminal resize: re-wrap the input area (keeping the draft), re-fit the status row, repaint the region.
  const onResize = () => { paintInput(); refreshFooter(); activity.refresh(); paintOverlay(); screen.onResize(); };
  output.on('resize', onResize);

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
          note(skills.filter((x) => !f || x.name.toLowerCase().includes(f) || x.description.toLowerCase().includes(f)).map((x) => `$${x.name} [${scopeLabel(x.scope)}] ${x.description.slice(0, 100)}`).join('\n') || 'no matching skills');
          return true;
        }
        picker = new SkillPicker(skills, arg);
        paintPicker();
        return true;
      }
      case '/help':
        note(helpText());
        return true;
      case '/usage': {
        note(formatUsage(await fetchUsage(client), chat.usage));
        return true;
      }
      case '/new':
        chat.reset(); router.reset();
        resetApproval();
        note('new conversation');
        return true;
      case '/resume': {
        let id = arg;
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
        await chat.resume(id); router.reset();
        resetApproval();
        note(`resumed ${id.slice(0, 8)} (${chat.model ?? '?'})`);
        await showHistory(id);
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
    let cmdBusy = false; // a slash command's request is in flight
    const finish = async (code: number) => {
      if (finished) return;
      finished = true;
      closing = true;
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
      pendingApproval?.('decline');
      pendingApproval = undefined;
      if (chat.busy || cmdBusy) quitWhenIdle = true; else void finish(0);
    };
    // Ctrl-C: interrupt a running turn (declining any pending approval); with a draft, clear it; otherwise quit.
    h.interrupt = () => {
      const running = chat.busy || Boolean(staged); // a staged request is running even between its turns
      if (!running && !cmdBusy && !composer.isEmpty) return composer.clear();
      if (!running || interrupting) return void finish(130);
      interrupting = true;
      stageCancel = true; // no further stages start
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
    const done = () => { if (quitWhenIdle) void finish(0); };

    /** Returns false when the draft must be kept (a turn is running). */
    h.submit = (raw: string): boolean => {
      const text = trimBlank(raw);
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
      let pick;
      try { pick = router.pick(text); } catch (e) { note(e instanceof Error ? e.message : String(e)); done(); return true; }
      // a pinned /model or /reasoning means the user chose one model: no staging
      // a pinned /model or /reasoning (or execution_strategy=direct) means plain single turns
      const plan: ExecutionPlan | undefined = router.model || router.reasoning ? undefined : planExecution(text, pick.route, router.config, pick.sel);
      const executor = plan && plan.strategy !== 'direct' ? plan : undefined;
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
        if (skills.length) note(`skills: ${skills.map((k) => `$${k.name}`).join(' ')}`);
        activity.begin(chat.threadId ? 'Thinking...' : 'Connecting...');
        let many = p.stages.length > 1;
        const exec = new StagedExecution(text, p, {
          cfg: router.config, catalog: router.models,
          send: (prompt, sel, o) => chat.send(prompt, sel, o.first ? skills : [], { isolated: o.isolated }),
          interrupt: () => chat.interrupt(),
          cancelled: () => stageCancel,
          context: () => chat.contextTokens(),
          compact: () => chat.compact(),
          hooks: {
            planned: (pl, models) => {
              if (pl.strategy === 'orchestrated') activity.notice(`Task: ${text.split('\n')[0].slice(0, 70)}\nStrategy: Orchestrated · Stages: ${pl.stages.length}\n${checklist(pl.stages, models)}`);
              else activity.notice(activity.dim(`Strategy: Direct · Model: ${name(models[0])} · Stages: 1`));
            },
            stageStart: (st, i, n, sel, sw) => {
              if (n > 1) many = true;
              if (sw) activity.notice(`↪ Switching model: ${name(sw.from)} → ${name(sw.to)}\n  Reason: ${sw.reason}`);
              if (many) activity.notice(`[●] ${i + 1}/${n} ${st.title} · ${name(sel.model)} · ${sel.effort}${st.thread === 'isolated' ? ' · fresh thread' : ''}`);
              activity.context = many ? `${i + 1}/${n} ${name(sel.model)} · ` : '';
              lastPick = { model: sel.model ?? '', effort: sel.effort ?? '' };
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
        }, (e: unknown) => {
          activity.context = '';
          activity.end('failed', e instanceof Error ? e.message : String(e));
        }).finally(() => { staged = undefined; cmdBusy = false; interrupting = false; done(); });
      };
      const launch = (skills: SkillInfo[]) => {
        if (executor) return runStaged(executor, skills);
        logRouting({ level: 'info', event: 'route_selected', request_id: `req_${Date.now().toString(36)}`, execution_id: '-', routing_strategy: 'single', selected_model: pick.sel.model, routing_reason: pick.route.tier, escalation_level: 0 }, router.config);
        if (skills.length) note(`skills: ${skills.map((k) => `$${k.name}`).join(' ')}`);
        activity.begin(chat.threadId ? 'Thinking...' : 'Connecting...');
        void chat.send(text, pick.sel, skills).then((r) => {
          interrupting = false;
          activity.end(r.status === 'interrupted' ? 'cancelled' : r.status === 'failed' || r.error ? 'failed' : 'completed', r.error);
        }, (e: unknown) => {
          interrupting = false;
          activity.end('failed', e instanceof Error ? e.message : String(e));
        }).finally(done);
      };
      if (text.includes('$')) {
        // explicit $skill invocations become native skill items; metadata only, cached per session
        cmdBusy = true;
        void catalog.load().then((all) => mentionedSkills(text, all), () => [] as SkillInfo[]).then((sk) => { cmdBusy = false; launch(sk); });
      } else launch([]);
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
    return await runTui(client, cwd, undefined, { resume: args.resume, policy, approvalMode: args.approval as ApprovalMode | undefined, reconnect: spawnClient, version: VERSION, connection: `Codex ${/\/(\d+\.\d+\.\d+)/.exec(client.info?.userAgent ?? '')?.[1] ?? ''} connected`.replace('Codex  ', 'Codex ') });
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
