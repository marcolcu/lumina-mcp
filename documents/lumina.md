# Lumina

Interactive Codex chat with automatic per-turn model/reasoning routing (Smart Codex router, no LLM calls). Talks to `codex app-server`; uses your existing Codex login. No API key, nothing under `~/.codex` is modified.

## Install
    npm install && npm run build
    node dist/lumina.js            # or `npm link` → `lumina`
Requires Codex CLI ≥ 0.162 on PATH and `codex login` done.

## Layout
Welcome header (version from package.json, routing mode, directory, real Codex connection) · conversation (`›` your prompts, `◆ Lumina` replies with indented activity lines) · a persistent bottom region: spinner/status row, input between two rules, and a status bar (`◉ Auto Routing · <model> · <effort>`, `Manual model`, `(manual)` reasoning, `Approval: Smart|Auto`) with command hints. The bottom region stays put while text streams; only changed rows are repainted.
Scrolling uses the terminal's own scrollback (mouse wheel, Shift+PageUp, Cmd/Ctrl+↑ depending on terminal): Lumina is an inline UI, not a full-screen app, so history, selection/copy and resize reflow stay native. Non-TTY/`TERM=dumb`: plain sequential output; `NO_COLOR` disables colors; `LUMINA_NO_ANIMATION=1` disables the spinner timer.

## Use
    lumina [--cwd DIR] [--resume [ID]] [--read-only]
- Type a message; the router picks model/effort per turn (shown as `[tier · model/effort]`).
- Slash commands: `/model [name|auto]`, `/reasoning [level|auto]`, `/new`, `/resume [n|id]`, `/exit`.
- Approvals: commands/file changes outside the sandbox prompt `[y]es / [a]lways this session / [n]o / [c]ancel turn`. Default sandbox is workspace-write with on-request approvals; `--read-only` = read-only, never ask.
- Approval modes (`/approval [manual|smart|auto|status]`, or `--approval M` at startup): **manual** (default) prompts for everything; **smart** auto-approves clearly safe read/test commands (`pwd`, `ls`, `git status|diff|log`, `npm test`, `npm run lint`, `go test` …); **auto** also approves workspace-local `git add`, `git commit` (no amend/`--no-verify`), builds and formatters (`gofmt -w`, `go fmt`, `cargo fmt`). `npm run verify[:x]` counts as a test script; `caveman shrink -- <cmd>` is judged by the wrapped `<cmd>`. Dangerous commands (force push, `reset --hard`, history rewrite, `rm -rf`, sudo, deploys, download-and-run) are auto-rejected in smart/auto; unknown commands, chains with any unknown part, substitutions/redirects/globs, credential-like or out-of-workspace paths, network requests and all file-change approvals still prompt. Rules are local and deterministic (no LLM); the mode is per session and resets to manual on `/new`, `/resume` and restart.
- Skills: `/skills [filter]` lists Codex's own skills (project `.agents/skills`, global, system) from the App Server's `skills/list`; ↑/↓ select, type to filter, Enter/Tab inserts `$name` into the draft (nothing is sent), Esc closes. Writing `$skill-name` in a prompt attaches a native skill item so Codex loads that SKILL.md; unknown `$names` are left as text. Codex decides automatic activation itself (verified for a project skill at medium effort). Only name/description/path are cached per session; `skills/changed` refreshes them. Non-TTY: `/skills` prints a plain list.
- Ctrl-C interrupts the running turn (declines any pending approval); Ctrl-C again, or when idle, quits (exit 130). `/exit` and Ctrl-D wait for a running turn.
- Conversations are persisted by Codex itself; `/resume` and `--resume` reattach with full context.
- If the App Server dies, Lumina restarts it (max 3 times) and resumes the thread; resend the last message if it did not finish.
- Piped stdin works (`echo "question" | lumina`), but approvals need an interactive terminal.

## Ticket workflow (understand → clarify → implement)
- "Check OP-559 and explain…", "Jelaskan tiket ini…", "Apa yang kamu pahami?" → **Understanding**: one read-only turn (sandbox `readOnly` for that turn — no file edits, migrations or commits) on the efficient model (Luna low/medium; Sol medium only when the request itself is complex). OpenProject work packages (`OP-123`, `work package 123`) are fetched once through lumina-mcp; Jira keys too when the text mentions a ticket. The answer covers: what it asks, expected behaviour, components, considerations, open questions — stated vs assumed.
- Any follow-up while discussing ("Correct, but…", "Bukan, maksudnya…", questions) → **Clarifying**: also read-only; the correction is stored and the state becomes *Ready for implementation*. The ticket is not fetched again.
- "Oke, kerjakan" / "implement it" / "proceed" → **Implementing**: model and reasoning are re-routed on the understood scope + your corrections (not the raw ticket), the sandbox returns to the session's own policy, approvals apply as usual, and the prompt restates every clarification so they override the original ticket.
- A direct "Kerjakan OP-560" implements immediately (no forced confirmation). `/new` ends the ticket context. The status bar shows `OP-559: Understanding|Ready|Implementing`.

## Long prompts with pasted tickets/docs
The router judges your **request**, not the material pasted with it. Fenced code, Markdown headings/tables/quotes, labelled sections (`Description:`, `Tiket:`, `API:`…) and long paragraphs count as reference: the model still receives everything, but those words (auth, JWT, migration, payment…) no longer push the task to the expensive tier. Explicitly narrow requests ("only this page", "cuma 1 halaman") lower complexity. If the request itself is vague ("kerjakan tiket ini"), the whole prompt is judged, conservatively. Safety checks (injection phrases, destructive commands) always read the whole prompt. Lumina shows `routed on your request · Nk chars of pasted ticket/docs passed as context only`.

## Execution strategies (model routing inside one prompt)
Codex cannot change the model inside a running turn; a stage is one `turn/start` with its own `model`/`effort`, and every model Lumina shows is the model actually sent.
- **Direct / adaptive (default)**: the request runs as ONE turn, verbatim, on the router's model (risk raises the model, not the stage count; "security review" names an activity, not a sensitive domain). Stages are added only when execution needs them: a failed turn (coding error) retries one tier up; tests still failing at the end, or a model reporting it is stuck, adds a fix stage (fast → balanced → advanced); a high-risk change the user asked to have reviewed gets one review stage, only if files were actually modified. Environment failures (auth, rate limit, network, timeout) stop without retry.
- **Orchestrated**: only for genuinely complex work (several distinct deliverables such as design + migrations + tests + docs): design (balanced) → implement (fast unless very complex). Tests/docs are part of the implement stage.
- **Context**: extra stages share the main thread while its context is small; above `isolate_min_context_tokens` they run on a fresh ephemeral thread (same cwd, sandbox, approvals) with only the request + a compact JSON hand-off, and their results are carried into your next turn. The thread is compacted (`thread/compact/start`) before a shared stage only when it is ≥ `compact_threshold` of the context window.
- **Model switch penalty**: a final review stage does not step down to a cheaper model (no cold start for a short check).
- **Config** (`stages` in `~/.smart-codex/config.json` / `.smart-codex.json`): `execution_strategy` (direct|adaptive|orchestrated, default adaptive), `tiers.fast|balanced|advanced` (gpt-6-luna / gpt-6-sol / gpt-6-astra, validated with fallback), `max_stages` 3, `max_switches` 4, `max_escalations` 2, `max_retries` 2, `stage_timeout_ms`, `context_strategy` (auto|shared|isolated), `isolate_min_context_tokens` 40000, `compaction_strategy` (auto|never), `compact_threshold` 0.7, `model_switch_penalty` true. A pinned `/model` or `/reasoning` gives plain single turns.
- **Logs**: `~/.smart-codex/routing.jsonl` — plan_created, stage_started, model_switched, switch_skipped, model_fallback, model_rejected, escalated, stage_added, context_compacted, stage_completed, execution_finished (strategy, stages, models, switches, escalations, compactions, retries, duration, provider-reported input/cached/output tokens or `token_source: unavailable`). No prompt text.
- **Benchmark**: `npx tsx bench/routing.bench.ts` (mock, exact stage/turn/switch counts) or `--real 1,2,3` (real Codex runs, provider token usage; uses your quota). Compares against a frozen copy of the previous routing in `bench/legacy/`.

## Input
Multi-line editor (grows to 8 rows, then scrolls). `Enter` submits · newline: `Shift+Enter`, `Option+Enter`, `Ctrl+J`, or `\` then `Enter` · `Ctrl+Enter` submits · arrows/Home/End/Delete/Backspace, `Ctrl+A/E/U/K/W`, `Alt+B/F` · `Ctrl+D` on empty input exits · `Ctrl+C` cancels the turn (clears a draft when idle).
- Bracketed paste is used where available (multi-line paste never submits); without it, a chunk containing a newline followed by more text is still treated as one paste.
- Shift/Ctrl+Enter need a terminal that reports modified keys (kitty keyboard protocol or xterm modifyOtherKeys: kitty, Ghostty/cmux, WezTerm, iTerm2, recent Warp). Terminals that cannot (e.g. macOS Terminal) send a plain Enter: use `Ctrl+J` or `\`+`Enter` there. Option+Enter works only if the terminal sends ESC+Enter.
- While a turn runs the draft is kept but not drawn; it reappears when the turn ends (or after an approval answer). Tabs become 2 spaces; wide (CJK/emoji) characters may misalign the cursor; resize redraw assumes the terminal reflows wrapped lines.

## Queue and images
- **Tab** queues the current draft while a turn is running (shown above the input as `Queued (n)`); queued prompts run in order when the turn ends. Tab when idle just sends; Ctrl-C cancels the turn and clears the queue. (Tab no longer inserts indentation.)
- **Ctrl+V** pastes an image from the clipboard (macOS via `osascript`, Linux via `wl-paste`/`xclip`) as an `[Image #n]` token; dragging an image file into the terminal (its path is pasted) attaches it too. On send, each token present becomes a native `localImage` input; delete the token to drop the image. Images are saved under the system temp dir (`lumina-images/`). Cmd+V is handled by the terminal itself and only pastes text, so use Ctrl+V for images.

## Limits
Approval requests other than command/file-change (extra permissions, MCP elicitations, tool calls) are declined. Lines pasted while a turn runs are ignored. The App Server protocol is experimental in Codex.
