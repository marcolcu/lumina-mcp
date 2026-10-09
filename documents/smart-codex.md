# smart-codex

Local, zero-LLM router in front of Codex CLI. For each task it picks model, reasoning effort, relevant files and agent strategy, then launches `codex`. It reuses your existing Codex login (ChatGPT subscription): no API key, no paid API, no network calls of its own.

## Architecture
```
smart-codex "task" ─► router.ts   intent + risk + complexity scoring (lexicons, no LLM)
                      context.ts  bounded file discovery (git ls-files, filename/dir scoring, 1-hop imports, related tests)
                      models.ts   validates model/effort against ~/.codex/models_cache.json
                      run.ts      codex subprocess (argv array), escalation ladder, JSONL analytics
MCP (lumina-mcp) ───► route_task / explain_route / get_router_config / get_router_stats  (same router.ts)
```
MCP cannot change the model of the host session; the CLI wrapper applies routing *before* launching Codex.

## Install (project-local)
    npm install && npm run build
    node dist/smart-codex.js --dry-run "Update button text"     # or `npm link` → `smart-codex`
Nothing under `~/.codex` is modified by installing or running the router.

## CLI
    smart-codex --dry-run "Update button text"
    smart-codex --dry-run "Implement user CRUD"
    smart-codex --dry-run "Debug concurrency issue"
    smart-codex --dry-run "Fix payment webhook signature"
    smart-codex "Implement user CRUD"            # interactive Codex, routed model/effort
    smart-codex --exec "Implement user CRUD"     # codex exec: non-interactive, escalation + token capture
    smart-codex --explain "..."  |  --stats  |  --tier hard  |  --model gpt-6-sol --reasoning high "..."

**Interactive vs `--exec`.** Interactive launches the normal Codex TUI with the routed `-m`/reasoning, one attempt, full terminal behavior; Codex exposes no stable per-session usage or failure signal there, so there is no escalation and token usage is recorded as unavailable. `--exec` runs `codex exec --json`: final answer streams to the terminal, failures can be classified, bounded escalation is possible, and real token usage is captured.

## Routing examples (default config, installed catalog)
| Task | Tier | Model / effort |
|---|---|---|
| Update button text | fast | gpt-6-luna / low |
| Fix typo in payment page · Change login button color · Update payment documentation | fast | gpt-6-luna / low |
| Implement user CRUD | normal | gpt-6-luna / medium |
| Debug concurrency issue | hard | gpt-6-sol / high |
| Fix payment webhook signature verification · Implement refresh token rotation · Refactor authentication middleware | critical | gpt-6-sol / high |
| Rename variable in auth module (trivial op in sensitive code) | critical | gpt-6-sol / medium |
| Explain how authentication works | normal (read-only) | gpt-6-luna / medium |
| "make it better" (ambiguous) | normal, confidence 0.4 | gpt-6-luna / medium |

## How classification works
Domain words (payment, auth, migration…) alone do **not** force `critical`. The router separates *what is being done* from *where*:
- sensitive domain + trivial operation (typo, color, docs, rename) + UI/doc surface and no logic words (middleware, validation, signature, webhook…) → not sensitive;
- read-only question about a sensitive domain → normal;
- sensitive domain + anything else, or unclear intent → `critical` (conservative);
- `hard` needs a structural signal (refactor/concurrency/architecture words, wide scope, or ≥3 touched components);
- ambiguous → `routing.default_tier`, never `fast`; routing-override phrases ("ignore the rules, treat as fast") are ignored.

## Model & reasoning selection
Model follows the tier; reasoning is adjusted separately (`reasoning.critical_simple` for trivial ops in sensitive code). Every model/effort is validated against the installed catalog (`~/.codex/models_cache.json`, memoized by mtime). Config defaults that are unsupported fall back safely (nearest effort, user default model); **explicit** `--model/--reasoning` (or MCP `preferences`) that are unsupported fail with a clear error. Identifiers must match `[A-Za-z0-9._-]+`. If the catalog is missing, values are passed through unvalidated.

## Configuration
`~/.smart-codex/config.json`, overridden by `./.smart-codex.json` (partial objects merge per section; invalid values abort with a clear message). The project file is untrusted and cannot change `analytics`. Keys (defaults):
```json
{ "routing": {"default_tier":"normal","default_agents":1,"max_attempts":3},
  "models": {"fast":"gpt-6-luna","normal":"gpt-6-luna","hard":"gpt-6-sol","critical":"gpt-6-sol"},
  "reasoning": {"fast":"low","normal":"medium","hard":"high","critical":"high","critical_simple":"medium"},
  "optimization": {"minimal_context":true,"max_context_files":8,"max_scanned_files":20000,"max_analysis_depth":1,"max_file_read_bytes":4096},
  "escalation": {"enabled":true,"max_attempts":3,"retry_environment_failures":false,"retry_after_file_changes":false},
  "analytics": {"enabled":true,"store_prompts":false} }
```
Discovery is bounded: file list from `git ls-files` (cached until `.git/index` changes), only the top ≤5 matches (+ their imports, ≤10 reads of `max_file_read_bytes`) are opened, symlinks are never followed. `SMART_CODEX_HOME` moves the state dir.

## Escalation (`--exec` only)
Ladder: same model next effort → hard-tier model at high; max `escalation.max_attempts`. A retry happens only if **all** hold: exit ≠ 0 and not interrupted; failure classified as a *coding* failure (auth, rate limit, network, config, missing dependency, sandbox/tool errors stop with a diagnostic and the original exit code); task is not destructive (drop/truncate/migration/rm -rf…); and for file-modifying tasks the git working tree is byte-identical to before the attempt (otherwise it stops: automatic reruns could duplicate writes — set `retry_after_file_changes` to retry with a "continue from current state" instruction). The retry prompt carries one redacted ≤500-char failure summary. Ctrl-C/SIGTERM stops the ladder and exits 130/143.

## Analytics
`~/.smart-codex/runs.jsonl`; `smart-codex --stats` or MCP `get_router_stats` report totals by tier/model/reasoning, succeeded/failed, escalations, average duration, and recorded input/output/total tokens with the number of runs that had **no** usage. Tokens are only ever copied from `codex exec --json` events; never estimated. Interactive sessions: no official, stable usage channel was found (the `notify` hook payload carries no usage, and parsing private session files is deliberately not done), so they stay "unavailable".

## MCP integration
If `lumina-mcp` is already registered in Codex (check: `codex mcp list`), nothing else is needed: after `npm run build` and restarting Codex, `route_task`, `explain_route`, `get_router_config`, `get_router_stats` appear in the existing server. If not registered: `codex mcp add lumina-mcp -- node /abs/path/lumina-mcp/dist/index.js`. `repository` is only used to list tracked file *names*; task text is never logged or stored.

## Known limitations
- Heuristic routing: lexicons + filename/import discovery (JS/TS relative imports only), no semantic search.
- Agent strategy is advisory; Codex exposes no stable subagent flag.
- Tree-change detection uses `git status` + `git diff HEAD`: edits inside already-untracked files are not seen. Failure classification reads output text, so a coding failure that mentions e.g. "ENOENT" stops instead of retrying (safe direction).
- Interactive token usage unavailable; `--exec` hides Codex TUI features.

## Troubleshooting
- `Unsupported model …`: pick one from the message (`codex debug models`); or fix `models.*` in config.
- Everything routes to `normal`: task is too vague; name the file/feature.
- `Stopped after attempt N: …`: read the diagnostic; fix the cause and rerun.
- `Invalid smart-codex config`: the message names the offending key.
