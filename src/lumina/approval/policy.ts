import path from 'node:path';

export type ApprovalMode = 'manual' | 'smart' | 'auto';
export const MODES: ApprovalMode[] = ['manual', 'smart', 'auto'];
export type Decision = 'approve' | 'ask' | 'deny';
export interface Evaluation { decision: Decision; reason: string; }
export interface EvalInput {
  command: string;
  cwd: string;
  mode: ApprovalMode;
  /** The request asks for network access: never automatic. */
  network?: boolean;
  /** Directory the command will run in, when it differs from the session cwd. */
  commandCwd?: string | null;
}

// Per-command verdict: 'safe' is approved by smart+auto, 'auto' only by auto.
type Level = 'safe' | 'auto' | 'ask' | 'deny';
interface Verdict { level: Level; reason: string; }
const v = (level: Level, reason: string): Verdict => ({ level, reason });
const SAFE = (reason: string) => v('safe', reason);
const AUTO = (reason: string) => v('auto', reason);
const ASK = (reason: string) => v('ask', reason);
const DENY = (reason: string) => v('deny', reason);

const SECRET = /(^|[/=:])(\.env(\..*)?|\.ssh|id_(rsa|ed25519|ecdsa|dsa)|\.aws|\.npmrc|\.netrc|\.pgpass|auth\.json|\.git-credentials|\.gnupg|\.kube|\.docker|\.codex|\.pem|\.p12|\.keychain)(\/|$|\b)|credentials?|secrets?\b|\.key$/i;
const RAW_DENY = /\bsudo\b|\bsu\s+-|\bdoas\b|\brm\s+(-\w*[rf]|--recursive|--force|--no-preserve-root)|git\s+push\b[^|;&]*(--force|\s-f\b|\s\+)|reset\s+--hard|git\s+clean\s+-\w*f|(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b|\bsandbox-exec\b|\bmkfs|\bdd\s+if=/;

// ---- shell parsing (conservative: anything that could hide or add commands is rejected) ----------------
type Parsed = { segments: string[][]; ops: string[] } | { unsafe: string };

function parse(script: string): Parsed {
  // harmless stderr/stdout discards are the only redirects tolerated
  const s = script.replace(/(?<=\s)(?:2>&1|[12]?>\/dev\/null|&>\/dev\/null)(?=\s|$)/g, '');
  const segments: string[][] = [];
  const ops: string[] = [];
  let words: string[] = [];
  let word = '';
  let has = false;
  let quote: '' | "'" | '"' = '';
  const endWord = () => { if (has) { words.push(word); } word = ''; has = false; };
  const endSeg = (op: string) => {
    endWord();
    if (words.length === 0) return false;
    segments.push(words); ops.push(op); words = [];
    return true;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = ''; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = '';
      else if (c === '$' || c === '`' || c === '\\') return { unsafe: 'expansion or escape inside quotes' };
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\') return { unsafe: 'backslash escape' };
    if (c === '$' || c === '`') return { unsafe: 'variable or command substitution' };
    if (c === '(' || c === ')' || c === '{' || c === '}') return { unsafe: 'subshell or grouping' };
    if (c === '<' || c === '>') return { unsafe: 'redirection' };
    if (c === '*' || c === '?' || c === '[') return { unsafe: 'glob pattern' };
    if (c === '~' && !has) return { unsafe: 'home expansion' };
    if (c === '#' && !has) return { unsafe: 'comment' };
    if (c === '&') {
      if (s[i + 1] !== '&') return { unsafe: 'background execution' };
      if (!endSeg('&&')) return { unsafe: 'empty command' };
      i++; continue;
    }
    if (c === '|') {
      const op = s[i + 1] === '|' ? '||' : '|';
      if (!endSeg(op)) return { unsafe: 'empty command' };
      if (op === '||') i++;
      continue;
    }
    if (c === ';' || c === '\n') { if (!endSeg(';') && c === ';') return { unsafe: 'empty command' }; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); continue; }
    word += c; has = true;
  }
  if (quote) return { unsafe: 'unterminated quote' };
  if (words.length || has) { endWord(); if (words.length) { segments.push(words); ops.push(''); } }
  return segments.length ? { segments, ops } : { unsafe: 'empty command' };
}

/**
 * Strips a `sh|bash|zsh -c <script>` wrapper (how Codex runs commands: the script is shell-quoted when it needs
 * quoting, bare otherwise, e.g. `/bin/zsh -lc pwd`) and returns the script; anything else is returned unchanged.
 */
export function unwrap(command: string): string {
  const m = /^\s*(?:\/\S*\/)?(?:ba|z|)sh\s+-[a-z]*c[a-z]*\s+([\s\S]+?)\s*$/.exec(command);
  if (!m) return command;
  const rest = m[1];
  const q = rest[0];
  if ((q === "'" || q === '"') && rest.length >= 2 && rest.endsWith(q) && !rest.slice(1, -1).includes(q)) return rest.slice(1, -1);
  return /^[\w./:=+@%,-]+$/.test(rest) ? rest : command;
}

// ---- per-program rules -----------------------------------------------------------------------------------
const flagsOnly = (args: string[]) => args.every((a) => a.startsWith('-'));

function pathVerdict(arg: string, cwd: string): Verdict | undefined {
  if (arg.startsWith('-')) return undefined;
  if (SECRET.test(arg)) return ASK('touches a credential-like path');
  if (arg.startsWith('~')) return ASK('outside the workspace');
  const abs = path.resolve(cwd, arg);
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) return ASK('path outside the workspace');
  return undefined;
}
const firstBad = (args: string[], cwd: string) => args.map((a) => pathVerdict(a, cwd)).find(Boolean);

const READ_ONLY = new Set(['ls', 'tree', 'stat', 'file', 'wc', 'head', 'tail', 'cat', 'diff', 'du', 'basename', 'dirname', 'realpath', 'readlink', 'uniq', 'cut', 'tr']);
const NO_ARGS = new Set(['pwd', 'whoami', 'date', 'uname', 'hostname', 'id', 'true', 'false']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'shortlog', 'describe', 'rev-list', 'grep', 'ls-tree', 'cat-file', 'diff-tree', 'name-rev', 'merge-base']);
const GIT_BAD_FLAG = /^(--output|--ext-diff|--no-index|--open-files-in-pager|-c$|--exec|--upload-pack|--git-dir|--work-tree)/;
const SAFE_SCRIPT = /^(test|lint|typecheck|type-check|check)(:[\w-]+)?$/;
const AUTO_SCRIPT = /^(build|format|format:check|fmt)(:[\w-]+)?$/;
const INFRA = new Set(['kubectl', 'helm', 'terraform', 'pulumi', 'ansible', 'ansible-playbook', 'serverless', 'sls', 'vercel', 'netlify', 'fly', 'flyctl', 'heroku', 'gcloud', 'aws', 'az', 'docker', 'podman']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'python', 'python3', 'node', 'perl', 'ruby']);

function git(args: string[], cwd: string): Verdict {
  const sub = args[0];
  if (!sub || sub.startsWith('-')) return ASK('git global options are not auto-approved');
  const rest = args.slice(1);
  const has = (re: RegExp) => rest.some((a) => re.test(a));
  // history rewriting / destructive: never automatic
  if (sub === 'push' && (has(/^(-f|--force.*|--delete|-d)$/) || rest.some((a) => a.startsWith('+') || a.startsWith(':')))) return DENY('git force push / ref deletion');
  if (sub === 'reset' && has(/^--(hard|merge|keep)$/)) return DENY('git reset --hard');
  if (sub === 'clean' && has(/^-\w*[fx]/)) return DENY('git clean removes untracked files');
  if (['rebase', 'filter-branch', 'filter-repo', 'update-ref', 'replace'].includes(sub)) return DENY('git history rewriting');
  if (sub === 'commit' && has(/^--amend$/)) return DENY('git history rewriting (--amend)');
  if (sub === 'branch' && has(/^(-D|--delete|-M|--move|-f|--force)$/)) return DENY('git branch deletion/force');
  if (sub === 'reflog' && rest[0] && rest[0] !== 'show') return DENY('git reflog modification');
  if (sub === 'gc' && has(/prune/)) return DENY('git gc --prune');
  if (rest.some((a) => SECRET.test(a))) return ASK('touches a credential-like path');

  if (GIT_READ.has(sub)) return rest.some((a) => GIT_BAD_FLAG.test(a)) ? ASK('git flag writes files or runs programs') : SAFE(`git ${sub} is read-only`);
  if (sub === 'branch') return rest.every((a) => /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--verbose)$/.test(a)) ? SAFE('git branch listing') : ASK('git branch with arguments');
  if (sub === 'remote') return rest.length === 0 || (rest.length === 1 && /^(-v|--verbose)$/.test(rest[0])) ? SAFE('git remote listing') : ASK('git remote change');
  if (sub === 'tag') return rest.length === 0 || rest.every((a) => /^(-l|--list|-n\d*)$/.test(a)) ? SAFE('git tag listing') : ASK('git tag change');
  if (sub === 'stash') return rest[0] === 'list' || rest[0] === 'show' ? SAFE('git stash listing') : ASK('git stash changes the working tree');
  if (sub === 'add') {
    if (has(/^(-f|--force|-i|-p|--interactive|--patch|--intent-to-add)$/)) return ASK('git add with force/interactive options');
    return firstBad(rest, cwd) ?? AUTO('git add within the workspace');
  }
  if (sub === 'commit') {
    // allowed: -m <msg>, -a, -s, -am; anything bypassing hooks/signing or editing history is manual
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--message' || /^-[as]*m$/.test(a)) { i++; continue; } // -m, -am, -sm … take the message next
      if (/^--message=/.test(a) || /^-[as]+$/.test(a)) continue;
      return ASK(`git commit option ${a.slice(0, 20)} is not auto-approved`);
    }
    return AUTO('git commit (no hook bypass, no amend)');
  }
  if ((sub === 'checkout' && rest[0] === '-b') || (sub === 'switch' && rest[0] === '-c')) return AUTO('create a local branch');
  return ASK(`git ${sub} is not on the allowlist`);
}

function runner(prog: string, args: string[]): Verdict | undefined {
  const sub = args[0] ?? '';
  const extra = args.slice(1);
  if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'bun') {
    if (sub === 'test' && extra.length === 0) return SAFE(`${prog} test`);
    const script = sub === 'run' ? args[1] : prog !== 'npm' ? sub : undefined;
    const tail = sub === 'run' ? args.slice(2) : args.slice(1);
    if (script && tail.length === 0) {
      if (SAFE_SCRIPT.test(script)) return SAFE(`${prog} ${script}`);
      if (AUTO_SCRIPT.test(script)) return AUTO(`${prog} ${script}`);
    }
    if (/^(publish|login|logout|token|adduser|owner|access|deprecate|unpublish)$/.test(sub)) return DENY(`${prog} ${sub}: publishing or credentials`);
    return undefined;
  }
  if (prog === 'go') {
    if (extra.some((a) => /^-(exec|toolexec|overlay|modfile)/.test(a))) return ASK('go flag runs external programs');
    if (sub === 'test' || sub === 'vet') return SAFE(`go ${sub}`);
    if (sub === 'build') return AUTO('go build');
    if (sub === 'version' && extra.length === 0) return SAFE('go version');
    return undefined;
  }
  if (prog === 'cargo') {
    if (sub === 'test' || sub === 'check' || sub === 'clippy') return SAFE(`cargo ${sub}`);
    if (sub === 'build') return AUTO('cargo build');
    if (sub === 'publish' || sub === 'login') return DENY(`cargo ${sub}`);
    return undefined;
  }
  if (prog === 'pytest' || (/^python3?$/.test(prog) && sub === '-m' && args[1] === 'pytest')) {
    return args.some((a) => a === '-p' || a.startsWith('-p=')) ? ASK('pytest plugin loading') : SAFE('pytest');
  }
  if (prog === 'make') return args.length === 1 && /^(test|lint|check)$/.test(sub) ? SAFE(`make ${sub}`) : undefined;
  if (/^(node|npm|go|python3?|cargo)$/.test(prog) && args.length === 1 && /^(-v|--version|version)$/.test(sub)) return SAFE(`${prog} version`);
  return undefined;
}

function segment(words: string[], cwd: string): Verdict {
  const [prog0, ...args] = words;
  const prog = path.basename(prog0);
  if (prog0.includes('=') && !prog0.startsWith('/')) return ASK('environment assignment prefix');
  if (['sudo', 'su', 'doas', 'sandbox-exec', 'mkfs', 'dd', 'shred', 'passwd', 'chpasswd', 'security'].includes(prog)) return DENY(`${prog}: privileged, destructive or credential operation`);
  if (prog === 'rm' && args.some((a) => /^-\w*[rf]/.test(a) || /^--(recursive|force|no-preserve-root)/.test(a))) return DENY('recursive/forced file removal');
  if (args.some((a) => /^--(prod|production)$/.test(a))) return DENY('production target');
  if (INFRA.has(prog) || (['npm', 'yarn', 'pnpm'].includes(prog) && args[0] === 'publish')) {
    if (args.some((a) => /^(apply|deploy|publish|destroy|delete|install|upgrade|uninstall|push|rollout|release)$/.test(a))) return DENY('deployment or infrastructure change');
    return ASK(`${prog} is not on the allowlist`);
  }
  if (NO_ARGS.has(prog)) return flagsOnly(args) ? SAFE(`${prog} prints local info`) : ASK(`${prog} with arguments`);
  if (prog === 'cd') return args.length === 1 ? (pathVerdict(args[0], cwd) ?? SAFE('cd within the workspace')) : ASK('cd without a single path');
  if (prog === 'echo' || prog === 'printf') return SAFE(`${prog} prints text`);
  if (prog === 'which' || (prog === 'command' && args[0] === '-v')) return SAFE('locates a command');
  if (prog === 'git') return git(args, cwd);
  if (READ_ONLY.has(prog)) {
    if (prog === 'tail' && args.some((a) => /^-\w*f|^--follow/.test(a))) return ASK('tail -f never terminates');
    return firstBad(args, cwd) ?? SAFE(`${prog} is read-only`);
  }
  if (prog === 'grep' || prog === 'rg') {
    if (args.some((a) => /^--(pre|pre-glob|hostname-bin)/.test(a))) return ASK('rg can run external programs');
    const nonFlags = args.filter((a) => !a.startsWith('-'));
    return firstBad(nonFlags.slice(1).filter((a) => !/^\d+$/.test(a)), cwd) ?? SAFE(`${prog} is read-only`);
  }
  if (prog === 'find') {
    if (args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/.test(a))) return ASK('find can execute or delete');
    return firstBad(args.filter((a, i) => i === 0 && !a.startsWith('-') && a !== '!' ), cwd) ?? SAFE('find is read-only');
  }
  if (prog === 'sort') return args.some((a) => /^(-o|--output)/.test(a)) ? ASK('sort writes a file') : SAFE('sort is read-only');
  return runner(prog, args) ?? ASK(`${prog} is not on the allowlist`);
}

/**
 * Deterministic approval policy. Never executes anything and never calls an LLM.
 * manual → always ask. smart → approve clearly safe read/test commands. auto → also approve a small set of
 * workspace-local writes. Dangerous commands are denied in smart/auto; anything unknown or unparseable asks.
 */
export function evaluate(input: EvalInput): Evaluation {
  const { mode } = input;
  if (mode === 'manual') return { decision: 'ask', reason: 'manual mode' };
  if (input.network) return { decision: 'ask', reason: 'network access request' };
  const cwd = path.resolve(input.cwd);
  if (input.commandCwd && input.commandCwd !== '' && path.resolve(input.commandCwd) !== cwd && !path.resolve(input.commandCwd).startsWith(cwd + path.sep)) {
    return { decision: 'ask', reason: 'command runs outside the workspace' };
  }
  const script = unwrap(input.command);
  const parsed = parse(script);
  if ('unsafe' in parsed) {
    return RAW_DENY.test(script) ? { decision: 'deny', reason: 'dangerous command' } : { decision: 'ask', reason: `unparseable shell (${parsed.unsafe})` };
  }
  if (parsed.segments.length > 6) return { decision: 'ask', reason: 'too many chained commands' };

  const verdicts = parsed.segments.map((w) => segment(w, cwd));
  // downloaded content piped into an interpreter
  parsed.segments.forEach((w, i) => {
    if (i > 0 && parsed.ops[i - 1] === '|' && INTERPRETERS.has(path.basename(w[0])) && /^(curl|wget)$/.test(path.basename(parsed.segments[i - 1][0]))) verdicts.push(DENY('downloaded script piped into an interpreter'));
  });
  const deny = verdicts.find((x) => x.level === 'deny');
  if (deny) return { decision: 'deny', reason: deny.reason };
  const ask = verdicts.find((x) => x.level === 'ask');
  if (ask) return { decision: 'ask', reason: ask.reason };
  const autoOnly = verdicts.find((x) => x.level === 'auto');
  if (autoOnly && mode === 'smart') return { decision: 'ask', reason: `${autoOnly.reason} (auto mode only)` };
  return { decision: 'approve', reason: (autoOnly ?? verdicts[0]).reason };
}

const TRUSTED_MCP = new Set(['lumina-mcp']);
const READ_TOOL = /^(get|list|search|find|inspect|read)_[a-z0-9_]+$/;

/**
 * MCP tool-call policy. Only `auto` mode approves, and only read-style tools of the trusted Lumina MCP server.
 * Everything else (writes, queries that execute SQL, unknown tools, other servers, smart/manual modes) asks the user.
 */
export function evaluateMcp(input: { server: string; tool: string; mode: ApprovalMode }): Evaluation {
  if (input.mode !== 'auto') return { decision: 'ask', reason: `${input.mode} mode does not auto-approve MCP tools` };
  if (!TRUSTED_MCP.has(input.server)) return { decision: 'ask', reason: 'MCP server is not trusted for auto-approval' };
  return READ_TOOL.test(input.tool) ? { decision: 'approve', reason: 'read-only MCP tool' } : { decision: 'ask', reason: 'MCP tool may write or is unknown' };
}
