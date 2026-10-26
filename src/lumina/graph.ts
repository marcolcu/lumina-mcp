import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../smart-codex/config.js';
import { listFiles } from './repomap.js';

/**
 * Code dependency graph for Go and TypeScript/JavaScript, built by lightweight static analysis (no model, no compiler
 * dependency): comments and strings are masked, then imports, exports, top-level declarations and identifier uses are
 * read. Every edge carries its evidence (file, line, kind); specifiers that cannot be resolved are reported as such,
 * never guessed. Files come from the repository map's listing (.gitignore, generated, secret and dependency
 * directories excluded); symlinks are never read. Parsed files are cached on disk and re-parsed only when they change.
 */
export type Lang = 'ts' | 'go';
export interface Import { spec: string; line: number; kind: 'static' | 'type' | 'dynamic' | 'require' | 'reexport' | 'side-effect'; names: { imported: string; local: string }[]; ns?: string }
export interface Decl { name: string; kind: string; start: number; end: number; exported: boolean }
export interface FileInfo {
  sig: string; lang: Lang; pkg?: string; imports: Import[]; decls: Decl[];
  /** Identifier (or `ns.Member`) → lines where it is used (comments and strings excluded). */
  uses: Record<string, number[]>;
  dynamicUnresolved: number; partial?: boolean; skipped?: string;
}
export interface Edge { from: string; to: string; line: number; kind: Import['kind'] | 'package'; names: string[]; evidence: string }
export interface Unresolved { from: string; spec: string; line: number; reason: string }

const MAX_FILES = 20_000;
const MAX_BYTES = 512 * 1024;
const MAX_LINES_PER_IDENT = 50;
const MAX_IDENTS = 3000;
const SOURCE = /\.(?:[cm]?[jt]sx?|go)$/;
const EXTS = ['', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];
const KEYWORDS = new Set('abstract as async await break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield chan defer fallthrough func go goto map range select struct nil string int bool error byte rune any'.split(' '));

/** Same-length copies of the source: comments masked (`code`), and comments + string contents masked (`bare`). */
export function mask(src: string, lang: Lang): { code: string; bare: string; balanced: boolean } {
  const code = src.split('');
  const bare = src.split('');
  const blank = (i: number, both: boolean) => { if (src[i] !== '\n') { bare[i] = ' '; if (both) code[i] = ' '; } };
  // template literals nest: `a ${ b ? `c` : d } e` — a stack of open templates and of brace depths inside `${…}`
  const stack: ('tpl' | number)[] = [];
  let i = 0;
  let prev = ''; // last significant code character (regex-literal heuristic)
  let balanced = true;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (stack.at(-1) === 'tpl') { // inside template text
      if (c === '\\') { blank(i, true); blank(i + 1, true); i += 2; continue; }
      if (c === '`') { stack.pop(); prev = '`'; i++; continue; }
      if (c === '$' && d === '{') { stack.push(0); i += 2; prev = '{'; continue; }
      blank(i, true); i++; continue;
    }
    if (lang === 'ts' && typeof stack.at(-1) === 'number') {
      if (c === '{') stack[stack.length - 1] = (stack.at(-1) as number) + 1;
      else if (c === '}') { if (stack.at(-1) === 0) { stack.pop(); i++; continue; } stack[stack.length - 1] = (stack.at(-1) as number) - 1; }
    }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') blank(i++, true); continue; }
    if (c === '/' && d === '*') { const s0 = i; i = src.indexOf('*/', i + 2); if (i < 0) { i = src.length; balanced = false; } else i += 2; for (let k = s0; k < i; k++) blank(k, true); continue; }
    if (c === '`' && lang === 'ts') { stack.push('tpl'); prev = '`'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { // strings (Go raw strings use backticks and have no escapes)
      const raw = c === '`';
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\' && !raw) j++; else if (src[j] === '\n' && !raw) break; j++; }
      if (j >= src.length || src[j] !== c) balanced = false;
      for (let k = i + 1; k < Math.min(j, src.length); k++) blank(k, raw);
      i = j + 1; prev = c; continue;
    }
    if (lang === 'ts' && c === '/' && (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev))) { // regex literal
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      for (let k = i + 1; k < Math.min(j, src.length); k++) blank(k, true);
      i = j + 1; prev = '/'; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  if (stack.length) balanced = false;
  return { code: code.join(''), bare: bare.join(''), balanced };
}

const lineAt = (starts: number[], off: number) => { let lo = 0; let hi = starts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; } return lo + 1; };
const lineStarts = (s: string) => { const out = [0]; for (let i = 0; i < s.length; i++) if (s[i] === '\n') out.push(i + 1); return out; };
/** Offset of the brace closing the one opened at `open` (in masked code); -1 when unbalanced. */
function closeBrace(bare: string, open: number): number {
  let depth = 0;
  for (let i = open; i < bare.length; i++) { if (bare[i] === '{') depth++; else if (bare[i] === '}' && --depth === 0) return i; }
  return -1;
}
/**
 * End of a declaration's body: the first brace group outside parentheses (parameter defaults are skipped); a group
 * followed by another "{" or "=" was a type annotation (return or variable type), so the next group is the body.
 */
function bodyEnd(bare: string, from: number): number {
  let paren = 0;
  for (let i = from; i < bare.length; i++) {
    const ch = bare[i];
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === ';' && paren === 0) return i;
    else if (ch === '{' && paren === 0) {
      const c = closeBrace(bare, i);
      if (c < 0) return -1;
      const next = /\S/.exec(bare.slice(c + 1, c + 200));
      if (next && (next[0] === '{' || next[0] === '=') && !bare.slice(c + 1, c + 1 + next.index + 2).includes('=>')) { i = c; continue; }
      return c;
    }
  }
  return -1;
}
/** Brace depth at each offset is not stored; top-level = depth 0 positions, computed once. */
function depthMap(bare: string): Uint16Array {
  const d = new Uint16Array(bare.length + 1);
  let depth = 0;
  for (let i = 0; i < bare.length; i++) { d[i] = depth; if (bare[i] === '{' || bare[i] === '(') depth++; else if ((bare[i] === '}' || bare[i] === ')') && depth > 0) depth--; }
  d[bare.length] = depth;
  return d;
}

function collectUses(bare: string, starts: number[]): Record<string, number[]> {
  const uses: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
  let n = 0;
  for (const m of bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?:\s*\.\s*([A-Za-z_$][\w$]*))?/g)) {
    const keys = [m[1], ...(m[2] ? [`${m[1]}.${m[2]}`] : [])];
    for (const k of keys) {
      if (KEYWORDS.has(k)) continue;
      const arr = uses[k] ?? (n++ < MAX_IDENTS ? (uses[k] = []) : undefined);
      if (!arr) continue;
      const l = lineAt(starts, m.index!);
      if (arr.length < MAX_LINES_PER_IDENT && arr.at(-1) !== l) arr.push(l);
    }
  }
  return uses;
}

/** TypeScript/JavaScript: imports, re-exports, require, dynamic import, exports and top-level declarations. */
export function parseTs(src: string, sig = ''): FileInfo {
  const { code, bare, balanced } = mask(src, 'ts');
  const starts = lineStarts(src);
  const at = (off: number) => lineAt(starts, off);
  const imports: Import[] = [];
  // a match is code only if its first character is not inside a string literal (e.g. fixture text in tests)
  const real = (m: RegExpMatchArray) => !(bare[m.index!] === ' ' && code[m.index!] !== ' ');
  const named = (list: string) => list.split(',').map((x) => x.trim().replace(/^type\s+/, '')).filter(Boolean).map((x) => { const [a, b] = x.split(/\s+as\s+/); return { imported: a.trim(), local: (b ?? a).trim() }; }).filter((x) => /^[\w$]+$/.test(x.imported) && /^[\w$]+$/.test(x.local));
  for (const m of code.matchAll(/(?<![\w$.])import\s+(type\s+)?([\w$]+\s*,?\s*)?(\{[^}]*\}|\*\s+as\s+[\w$]+)?\s*from\s*(['"])([^'"\n]+)\4/g)) {
    if (!real(m)) continue;
    const names: Import['names'] = [];
    let ns: string | undefined;
    const def = m[2]?.replace(/[,\s]/g, '');
    if (def) names.push({ imported: 'default', local: def });
    if (m[3]?.startsWith('{')) names.push(...named(m[3].slice(1, -1)));
    else if (m[3]) ns = m[3].replace(/^\*\s+as\s+/, '').trim();
    imports.push({ spec: m[5], line: at(m.index!), kind: m[1] ? 'type' : 'static', names, ns });
  }
  for (const m of code.matchAll(/(?<![\w$.])import\s*(['"])([^'"\n]+)\1/g)) { if (!real(m)) continue; imports.push({ spec: m[2], line: at(m.index!), kind: 'side-effect', names: [] }); }
  for (const m of code.matchAll(/(?<![\w$.])export\s+(type\s+)?(\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\3/g)) {
    if (!real(m)) continue;
    imports.push({ spec: m[4], line: at(m.index!), kind: 'reexport', names: m[2].startsWith('{') ? named(m[2].slice(1, -1)) : [{ imported: '*', local: '*' }] });
  }
  for (const m of code.matchAll(/(?:(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*)?(?<![\w$.])require\s*\(\s*(['"])([^'"\n]+)\2\s*\)/g)) {
    if (!real(m)) continue;
    const lhs = m[1];
    imports.push({ spec: m[3], line: at(m.index!), kind: 'require', names: lhs?.startsWith('{') ? named(lhs.slice(1, -1).replace(/:/g, ' as ')) : [], ns: lhs && !lhs.startsWith('{') ? lhs : undefined });
  }
  let dynamicUnresolved = 0;
  for (const m of code.matchAll(/(?<![\w$.])import\s*\(\s*(['"`])?([^'"`)\n]*)/g)) {
    if (!real(m)) continue;
    if ((m[1] === "'" || m[1] === '"') && m[2]) imports.push({ spec: m[2], line: at(m.index!), kind: 'dynamic', names: [] });
    else dynamicUnresolved++; // computed specifier: not followed
  }

  const depth = depthMap(bare);
  const decls: Decl[] = [];
  const exportedNames = new Set<string>();
  for (const m of bare.matchAll(/(?<![\w$.])(export\s+)?(default\s+)?(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    if (depth[m.index!] !== 0) continue;
    const kind = m[3].replace('*', '');
    const after = m.index! + m[0].length;
    // the body: the first "{" before the statement ends (arrow functions, classes, objects); else the line
    let end = after;
    const semi = bare.indexOf(';', after);
    const nl = bare.indexOf('\n', after);
    const brace = bare.indexOf('{', after);
    const stmtEnd = kind === 'type' || kind === 'const' || kind === 'let' || kind === 'var' ? Math.min(...[semi, bare.indexOf('\n\n', after)].filter((x) => x >= 0), bare.length) : bare.length;
    if (brace >= 0 && brace < stmtEnd) { const c = bodyEnd(bare, after); end = c < 0 ? bare.length : c; } else end = Math.max(nl, after);
    decls.push({ name: m[4], kind, start: at(m.index!), end: at(end), exported: Boolean(m[1]) });
    if (m[1]) exportedNames.add(m[4]);
  }
  for (const m of bare.matchAll(/(?<![\w$.])export\s*\{([^}]*)\}(?!\s*from)/g)) for (const x of named(m[1])) { const d = decls.find((y) => y.name === x.imported); if (d) d.exported = true; else decls.push({ name: x.local, kind: 'export', start: at(m.index!), end: at(m.index!), exported: true }); }
  for (const m of bare.matchAll(/(?<![\w$.])export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/gm)) { const d = decls.find((y) => y.name === m[1]); if (d) d.exported = true; }
  for (const m of bare.matchAll(/(?<![\w$.])(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) decls.push({ name: m[1], kind: 'export', start: at(m.index!), end: at(m.index!), exported: true });
  return { sig, lang: 'ts', imports, decls, uses: collectUses(bare, starts), dynamicUnresolved, ...(balanced && depth[bare.length] === 0 ? {} : { partial: true }) };
}

/** Go: package clause, imports (single and grouped, with aliases), top-level declarations (methods as Type.Method). */
export function parseGo(src: string, sig = ''): FileInfo {
  const { code, bare, balanced } = mask(src, 'go');
  const starts = lineStarts(src);
  const at = (off: number) => lineAt(starts, off);
  const pkg = /^\s*package\s+([A-Za-z_]\w*)/m.exec(bare)?.[1];
  const imports: Import[] = [];
  const one = (s: string, off: number) => { const m = /^\s*([A-Za-z_]\w*|\.|_)?\s*"([^"\n]+)"/.exec(s); if (m) imports.push({ spec: m[2], line: at(off), kind: 'static', names: [], ns: m[1] }); };
  for (const m of code.matchAll(/^[ \t]*import\s*\(([\s\S]*?)\)/gm)) { let off = m.index! + m[0].indexOf('(') + 1; for (const l of m[1].split('\n')) { one(l, off); off += l.length + 1; } }
  for (const m of code.matchAll(/^[ \t]*import[ \t]+((?:[A-Za-z_]\w*|\.|_)?[ \t]*"[^"\n]+")/gm)) one(m[1], m.index!);
  // a package's name is usually the last path element (v2 suffixes and go- prefixes aside); aliases override it
  for (const imp of imports) if (imp.ns === undefined || imp.ns === '') imp.ns = imp.spec.split('/').filter((x) => !/^v\d+$/.test(x)).pop()!.replace(/^go-/, '').replace(/[.-].*$/, '');
  const depth = depthMap(bare);
  const decls: Decl[] = [];
  for (const m of bare.matchAll(/^func\s+(?:\(\s*[\w]*\s*\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)/gm)) {
    const brace = bare.indexOf('{', m.index!);
    const nl = bare.indexOf('\n', m.index!);
    const end = brace >= 0 ? closeBrace(bare, brace) : nl;
    const name = m[1] ? `${m[1]}.${m[2]}` : m[2];
    decls.push({ name, kind: m[1] ? 'method' : 'func', start: at(m.index!), end: at(end < 0 ? bare.length : end), exported: /^[A-Z]/.test(m[2]) && (!m[1] || /^[A-Z]/.test(m[1])) });
  }
  for (const m of bare.matchAll(/^(type|var|const)\s+(\(|[A-Za-z_]\w*)/gm)) {
    if (m[2] === '(') { // grouped: names at the start of lines inside the group
      const close = bare.indexOf(')', m.index!);
      const body = bare.slice(m.index! + m[0].length, close < 0 ? undefined : close);
      let off = m.index! + m[0].length;
      for (const l of body.split('\n')) { const n = /^\s*([A-Za-z_]\w*)\b/.exec(l); if (n && depth[off] === 1) decls.push({ name: n[1], kind: m[1], start: at(off), end: at(off), exported: /^[A-Z]/.test(n[1]) }); off += l.length + 1; }
      continue;
    }
    const brace = bare.indexOf('{', m.index!);
    const nl = bare.indexOf('\n', m.index!);
    const end = m[1] === 'type' && brace >= 0 && brace < nl ? closeBrace(bare, brace) : nl;
    decls.push({ name: m[2], kind: m[1], start: at(m.index!), end: at(end < 0 ? bare.length : end), exported: /^[A-Z]/.test(m[2]) });
  }
  decls.sort((a, b) => a.start - b.start);
  return { sig, lang: 'go', pkg, imports, decls, uses: collectUses(bare, starts), dynamicUnresolved: 0, ...(balanced && depth[bare.length] === 0 ? {} : { partial: true }) };
}

/** Lines where a name is used; own keys only ("constructor", "toString"… are names too). */
export const lines = (info: Pick<FileInfo, 'uses'>, key: string): number[] => (Object.prototype.hasOwnProperty.call(info.uses, key) && Array.isArray(info.uses[key]) ? info.uses[key] : []);

const json = (s: string): Record<string, unknown> => { try { return JSON.parse(s.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>; } catch { return {}; } };

export class DependencyGraph {
  files = new Map<string, FileInfo>();
  deps = new Map<string, Edge[]>();
  rdeps = new Map<string, Edge[]>();
  external = new Map<string, Set<string>>();
  unresolved: Unresolved[] = [];
  stats = { files: 0, parsed: 0, reused: 0, skipped: 0, truncated: false, ms: 0 };
  private cacheFile: string;

  constructor(readonly root: string) {
    this.cacheFile = path.join(stateDir(), 'graph', `${createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`);
    try {
      const c = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) as { version: number; root: string; files: Record<string, FileInfo> };
      if (c.version === 1 && c.root === root) this.files = new Map(Object.entries(c.files));
    } catch { /* no or unreadable cache: full build */ }
  }

  private read(rel: string): { text: string; sig: string } | { skipped: string } {
    const full = path.join(this.root, rel);
    let st: fs.Stats;
    try { st = fs.lstatSync(full); } catch { return { skipped: 'missing' }; }
    if (!st.isFile()) return { skipped: st.isSymbolicLink() ? 'symlink' : 'not a file' };
    const sig = `${st.size}:${st.mtimeMs}`;
    if (st.size > MAX_BYTES) return { skipped: 'too large' };
    return { text: fs.readFileSync(full, 'utf8'), sig };
  }

  /** Incremental: unchanged files (same size and mtime) keep their parse; removed files drop out. */
  async update(): Promise<this> {
    const t0 = Date.now();
    const everything = (await listFiles(this.root)).files;
    this.manifests = everything.filter((f) => /(^|\/)(go\.mod|package\.json|tsconfig\.json)$/.test(f));
    const listed = everything.filter((f) => SOURCE.test(f) && !f.endsWith('.d.ts'));
    const files = listed.slice(0, MAX_FILES);
    const keep = new Set(files);
    for (const f of [...this.files.keys()]) if (!keep.has(f)) this.files.delete(f);
    let parsed = 0; let reused = 0; let skipped = 0;
    for (let i = 0; i < files.length; i++) {
      const rel = files[i];
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(path.join(this.root, rel)); } catch { /* gone */ }
      if (!st) { this.files.delete(rel); continue; } // deleted in the working tree but still in the git index
      const sig = `${st.size}:${st.mtimeMs}`;
      if (this.files.get(rel)?.sig === sig) { reused++; continue; }
      const r = this.read(rel);
      const lang: Lang = rel.endsWith('.go') ? 'go' : 'ts';
      if ('skipped' in r) { this.files.set(rel, { sig, lang, imports: [], decls: [], uses: {}, dynamicUnresolved: 0, skipped: r.skipped }); skipped++; continue; }
      try { this.files.set(rel, lang === 'go' ? parseGo(r.text, r.sig) : parseTs(r.text, r.sig)); } catch { this.files.set(rel, { sig, lang, imports: [], decls: [], uses: {}, dynamicUnresolved: 0, skipped: 'unparseable' }); }
      parsed++;
      if (i % 200 === 199) await new Promise((res) => setImmediate(res)); // keep the UI responsive
    }
    this.link();
    this.stats = { files: files.length, parsed, reused, skipped, truncated: listed.length > MAX_FILES, ms: Date.now() - t0 };
    if (parsed || skipped || this.stats.files !== reused) this.save();
    return this;
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${this.cacheFile}.tmp`, JSON.stringify({ version: 1, root: this.root, files: Object.fromEntries(this.files) }), { mode: 0o600 });
      fs.renameSync(`${this.cacheFile}.tmp`, this.cacheFile);
    } catch { /* the cache is optional */ }
  }

  // ---- resolution ------------------------------------------------------------------------------------------------
  private known = new Set<string>();
  private manifests: string[] = [];
  private goModules: { dir: string; module: string }[] = [];
  private workspaces = new Map<string, string>(); // package name → dir
  private tsconfigs = new Map<string, { base: string; paths: [string, string[]][] } | null>();
  private readText = (rel: string) => { const r = this.read(rel); return 'text' in r ? r.text : ''; };

  private link(): void {
    this.known = new Set(this.files.keys());
    this.deps.clear(); this.rdeps.clear(); this.external.clear(); this.unresolved = [];
    this.tsconfigs.clear();
    const manifests = (name: string) => this.manifests.filter((f) => path.posix.basename(f) === name);
    this.goModules = [];
    for (const f of manifests('go.mod')) { const t = this.readText(f); const m = /^module\s+(\S+)/m.exec(t); if (m && !this.goModules.some((x) => x.dir === path.posix.dirname(f))) this.goModules.push({ dir: path.posix.dirname(f), module: m[1] }); }
    this.workspaces.clear();
    for (const f of manifests('package.json')) { const pj = json(this.readText(f)); if (typeof pj.name === 'string') this.workspaces.set(pj.name, path.posix.dirname(f)); }
    const goPkgs = new Map<string, string[]>();
    for (const [f, info] of this.files) if (info.lang === 'go') { const d = path.posix.dirname(f); goPkgs.set(d, [...(goPkgs.get(d) ?? []), f]); }

    for (const [from, info] of this.files) {
      for (const imp of info.imports) {
        const add = (to: string, kind: Edge['kind'], evidence: string) => {
          const e: Edge = { from, to, line: imp.line, kind, names: imp.names.map((n) => n.imported), evidence };
          (this.deps.get(from) ?? this.deps.set(from, []).get(from)!).push(e);
          (this.rdeps.get(to) ?? this.rdeps.set(to, []).get(to)!).push(e);
        };
        if (info.lang === 'go') {
          const mod = this.goModules.filter((m) => imp.spec === m.module || imp.spec.startsWith(`${m.module}/`)).sort((a, b) => b.module.length - a.module.length)[0];
          if (!mod) { (this.external.get(from) ?? this.external.set(from, new Set()).get(from)!).add(imp.spec); continue; }
          const dir = path.posix.join(mod.dir, imp.spec.slice(mod.module.length + 1));
          if (goPkgs.has(dir)) add(`${dir}/`, 'package', `import "${imp.spec}" (${from}:${imp.line})`);
          else this.unresolved.push({ from, spec: imp.spec, line: imp.line, reason: 'no Go files in that package directory' });
          continue;
        }
        const to = this.resolveTs(from, imp.spec);
        if (to === null) continue; // external package (recorded inside)
        if (to) add(to, imp.kind, `${imp.kind === 'dynamic' ? 'import()' : imp.kind === 'require' ? 'require()' : imp.kind === 'reexport' ? 'export … from' : 'import'} '${imp.spec}' (${from}:${imp.line})`);
        else this.unresolved.push({ from, spec: imp.spec, line: imp.line, reason: 'module not found in the repository' });
      }
    }
    // Go: a package node is used through its files
    for (const [dir, fs_] of goPkgs) this.deps.set(`${dir}/`, fs_.map((f) => ({ from: `${dir}/`, to: f, line: 0, kind: 'package' as const, names: [], evidence: `file of package ${dir}/` })));
  }

  private tsconfigFor(dir: string): { base: string; paths: [string, string[]][] } | null {
    if (this.tsconfigs.has(dir)) return this.tsconfigs.get(dir)!;
    const file = dir === '.' ? 'tsconfig.json' : `${dir}/tsconfig.json`;
    const t = this.readText(file);
    let res: { base: string; paths: [string, string[]][] } | null;
    if (t) {
      const co = (json(t).compilerOptions ?? {}) as { baseUrl?: string; paths?: Record<string, string[]> };
      res = { base: path.posix.normalize(path.posix.join(dir, co.baseUrl ?? '.')), paths: Object.entries(co.paths ?? {}) };
    } else res = dir === '.' ? null : this.tsconfigFor(path.posix.dirname(dir));
    this.tsconfigs.set(dir, res);
    return res;
  }

  private find(base: string): string | undefined {
    const b = path.posix.normalize(base).replace(/\/$/, '');
    if (b.startsWith('..')) return undefined; // outside the repository
    const stem = b.replace(/\.(m|c)?js$/, '');
    for (const cand of [...EXTS.map((e) => b + e), ...EXTS.map((e) => stem + e)]) if (this.known.has(cand)) return cand;
    return undefined;
  }

  /** File for a specifier; undefined = not found; null = external package (recorded). */
  private resolveTs(from: string, spec: string): string | undefined | null {
    const dir = path.posix.dirname(from);
    if (spec.startsWith('.')) return this.find(path.posix.join(dir, spec));
    if (spec.startsWith('/')) return undefined;
    const tc = this.tsconfigFor(dir);
    for (const [pattern, targets] of tc?.paths ?? []) {
      const star = pattern.endsWith('*');
      const prefix = star ? pattern.slice(0, -1) : pattern;
      if (star ? !spec.startsWith(prefix) : spec !== pattern) continue;
      for (const t of targets) { const hit = this.find(path.posix.join(tc!.base, star ? t.replace('*', spec.slice(prefix.length)) : t)); if (hit) return hit; }
    }
    // workspace packages of a monorepo (by package.json name), then baseUrl-relative modules
    const ws = [...this.workspaces.keys()].filter((n) => spec === n || spec.startsWith(`${n}/`)).sort((a, b) => b.length - a.length)[0];
    if (ws) {
      const wdir = this.workspaces.get(ws)!;
      const sub = spec.slice(ws.length + 1);
      if (sub) return this.find(path.posix.join(wdir, sub)) ?? this.find(path.posix.join(wdir, 'src', sub));
      const pj = json(this.readText(wdir === '.' ? 'package.json' : `${wdir}/package.json`));
      const exp = pj.exports as unknown;
      const entry = [typeof exp === 'string' ? exp : (exp as Record<string, unknown> | undefined)?.['.'], pj.types, pj.module, pj.main].find((x): x is string => typeof x === 'string');
      return (entry && this.find(path.posix.join(wdir, entry.replace(/^\.\//, '').replace(/^dist\//, 'src/').replace(/\.d\.ts$/, '')))) ?? this.find(path.posix.join(wdir, 'src/index')) ?? this.find(path.posix.join(wdir, 'index'));
    }
    if (tc && tc.base !== '.' && this.find(path.posix.join(tc.base, spec))) return this.find(path.posix.join(tc.base, spec));
    (this.external.get(from) ?? this.external.set(from, new Set()).get(from)!).add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    return null;
  }

  // ---- queries --------------------------------------------------------------------------------------------------
  /** Files matching a path (exact, or a unique-ish suffix). */
  matchFiles(q: string): string[] {
    const n = q.replace(/^\.\//, '').replace(/\/$/, '');
    if (this.files.has(n)) return [n];
    return [...this.files.keys()].filter((f) => f === n || f.endsWith(`/${n}`) || f.replace(/\.[^.]+$/, '').endsWith(`/${n}`) || (path.posix.dirname(f) === n)).slice(0, 50);
  }

  /** Where a symbol is declared (exported first). `Type.Method` works for Go methods. */
  findSymbol(name: string): { file: string; decl: Decl }[] {
    const out: { file: string; decl: Decl }[] = [];
    for (const [file, info] of this.files) for (const d of info.decls) if (d.name === name || (name.includes('.') && d.name === name)) out.push({ file, decl: d });
    return out.sort((a, b) => Number(b.decl.exported) - Number(a.decl.exported) || a.file.localeCompare(b.file));
  }

  /** The top-level declaration containing a line, if any. */
  enclosing(file: string, line: number): Decl | undefined {
    return this.files.get(file)?.decls.filter((d) => d.start <= line && line <= d.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
  }

  /** What a symbol's body uses: imported names and namespace members (resolved to their files), same-file and same-package declarations. */
  symbolDeps(file: string, decl: Decl): { name: string; file?: string; line: number; evidence: string }[] {
    const info = this.files.get(file)!;
    const within = (lines: number[]) => lines.find((l) => l >= decl.start && l <= decl.end);
    const out = new Map<string, { name: string; file?: string; line: number; evidence: string }>();
    const edges = this.deps.get(file) ?? [];
    for (const imp of info.imports) {
      const edge = edges.find((e) => e.line === imp.line);
      for (const n of imp.names) { const l = within(lines(info, n.local)); if (l) out.set(n.imported === 'default' ? n.local : n.imported, { name: n.imported === 'default' ? n.local : n.imported, file: edge?.to, line: l, evidence: `${n.local} imported from '${imp.spec}' (L${imp.line}), used at L${l}` }); }
      if (imp.ns) for (const [k, ls] of Object.entries(info.uses)) if (k.startsWith(`${imp.ns}.`) && Array.isArray(ls)) { const l = within(ls); if (l) out.set(k, { name: k, file: edge?.to, line: l, evidence: `${imp.ns} = '${imp.spec}' (L${imp.line}), ${k} at L${l}` }); }
    }
    const local = info.lang === 'go' ? [...this.files].filter(([f, i]) => i.lang === 'go' && path.posix.dirname(f) === path.posix.dirname(file) && i.pkg === info.pkg) : [[file, info] as const];
    for (const [f, i] of local) for (const d of i.decls) {
      if (d === decl || d.name.includes('.') || out.has(d.name)) continue;
      const l = lines(info, d.name).find((x) => x >= decl.start && x <= decl.end && x !== decl.start);
      if (l) out.set(d.name, { name: d.name, file: f, line: l, evidence: `${f === file ? 'same file' : 'same package'} declaration, used at L${l}` });
    }
    return [...out.values()];
  }

  /** Who uses a symbol: by named import or namespace member (TS), package selector or same-package reference (Go). */
  symbolUsers(file: string, decl: Decl): { file: string; line: number; by?: string; evidence: string }[] {
    const info = this.files.get(file)!;
    const name = decl.name.includes('.') ? decl.name.split('.')[1] : decl.name;
    const out: { file: string; line: number; by?: string; evidence: string }[] = [];
    const push = (f: string, l: number | undefined, evidence: string) => { if (l !== undefined) out.push({ file: f, line: l, by: this.enclosing(f, l)?.name, evidence }); };
    if (info.lang === 'go') {
      for (const e of this.rdeps.get(`${path.posix.dirname(file)}/`) ?? []) {
        const imp = this.files.get(e.from)?.imports.find((x) => x.line === e.line);
        if (imp) push(e.from, lines(this.files.get(e.from)!, `${imp.ns}.${name}`)[0], `${imp.ns}.${name} (package import L${imp.line})`);
      }
      for (const [f, i] of this.files) if (f !== file && i.lang === 'go' && path.posix.dirname(f) === path.posix.dirname(file) && i.pkg === info.pkg) push(f, lines(i, name)[0], 'same-package reference');
    } else this.importersOf(file, name, push, new Set([file]), 0);
    for (const l of lines(info, name).filter((x) => x < decl.start || x > decl.end)) { const by = this.enclosing(file, l); if (by && by.name !== decl.name) { out.push({ file, line: l, by: by.name, evidence: 'same file' }); break; } }
    return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  }

  /** TS/JS importers of `name` from `file`, following re-exports (barrel files) a few levels deep. */
  private importersOf(file: string, name: string, push: (f: string, l: number | undefined, evidence: string) => void, seen: Set<string>, depth: number): void {
    for (const e of this.rdeps.get(file) ?? []) {
      const ui = this.files.get(e.from);
      const imp = ui?.imports.find((x) => x.line === e.line && (x.kind === e.kind || (x.kind === 'type' && e.kind === 'type')));
      if (!ui || !imp) continue;
      const n = imp.names.find((x) => x.imported === name);
      const via = depth ? ` via a re-export` : '';
      if (imp.kind === 'reexport' && (n || imp.names.some((x) => x.imported === '*'))) {
        push(e.from, imp.line, `re-exports ${n ? name : 'everything'} from '${imp.spec}'`);
        if (depth < 3 && !seen.has(e.from)) { seen.add(e.from); this.importersOf(e.from, n?.local ?? name, push, seen, depth + 1); }
      } else if (n) push(e.from, lines(ui, n.local).find((l) => l !== imp.line) ?? imp.line, `imports ${name}${n.local !== name ? ` as ${n.local}` : ''} (L${imp.line})${via}`);
      else if (imp.ns) push(e.from, lines(ui, `${imp.ns}.${name}`)[0], `${imp.ns}.${name} (namespace import L${imp.line})${via}`);
    }
  }

  /** A shortest import cycle through `file` (Go: through its package), bounded search; type-only imports ignored. */
  cycle(file: string): string[] | undefined {
    const go = this.files.get(file)?.lang === 'go';
    const start = go ? `${path.posix.dirname(file)}/` : file;
    const succ = (n: string): string[] => (n.endsWith('/')
      ? (this.deps.get(n) ?? []).flatMap((f) => (this.deps.get(f.to) ?? []).map((e) => e.to))
      : (this.deps.get(n) ?? []).filter((e) => e.kind !== 'type').map((e) => e.to));
    const prev = new Map<string, string>();
    const queue = [start];
    for (let steps = 0; queue.length && steps < 5000; steps++) {
      const n = queue.shift()!;
      for (const to of succ(n)) {
        if (to === start) { const p = [n]; let c = n; while (prev.has(c)) { c = prev.get(c)!; p.unshift(c); } return [...p, start]; }
        if (!prev.has(to)) { prev.set(to, n); queue.push(to); }
      }
    }
    return undefined;
  }
}

// ---- /graph rendering -----------------------------------------------------------------------------------------------
const LIMIT = 25;
function tree(title: string, sections: [string, string[]][]): string {
  const out = [title];
  const shown = sections.filter(([, items]) => items.length);
  shown.forEach(([head, items], i) => {
    const last = i === shown.length - 1;
    out.push(`${last ? '└──' : '├──'} ${head}`);
    const list = items.length > LIMIT ? [...items.slice(0, LIMIT), `… ${items.length - LIMIT} more`] : items;
    list.forEach((it, j) => out.push(`${last ? '    ' : '│   '}${j === list.length - 1 ? '└──' : '├──'} ${it}`));
  });
  return out.join('\n');
}

export function formatGraph(g: DependencyGraph, query: string): string {
  const q = query.trim();
  if (!q) return 'usage: /graph <file-or-symbol>';
  const files = q.includes('/') || SOURCE.test(q) ? g.matchFiles(q) : [];
  const symbols = files.length ? [] : g.findSymbol(q);
  if (!files.length && !symbols.length) {
    const asFile = g.matchFiles(q);
    if (asFile.length) return formatGraph(g, asFile[0]);
    return `No file or symbol "${q}" found in the dependency graph (Go and TypeScript/JavaScript files are indexed).`;
  }
  if (files.length > 1 && !files.includes(q)) return `"${q}" matches ${files.length} files:\n${files.slice(0, 15).map((f) => `  ${f}`).join('\n')}\nUse a longer path.`;
  if (files.length) {
    const f = files[0];
    const info = g.files.get(f)!;
    if (info.skipped) return `${f}: not analysed (${info.skipped}).`;
    const isGo = info.lang === 'go';
    const deps = (g.deps.get(f) ?? []).map((e) => `${e.to}  (${e.kind}, L${e.line})`);
    const ext = [...(g.external.get(f) ?? [])].map((p) => `${p}  (external package)`);
    const users = (isGo ? g.rdeps.get(`${path.posix.dirname(f)}/`) ?? [] : g.rdeps.get(f) ?? []).map((e) => `${e.from}  (${e.kind === 'package' ? 'imports the package' : e.kind}, L${e.line})`).sort();
    const sameFile = info.decls.filter((d) => d.exported).map((d) => `${d.name}  (${d.kind}, L${d.start})`);
    const notes: string[] = [];
    for (const u of g.unresolved.filter((x) => x.from === f)) notes.push(`unresolved '${u.spec}' (L${u.line}): ${u.reason}`);
    if (info.dynamicUnresolved) notes.push(`${info.dynamicUnresolved} dynamic import${info.dynamicUnresolved === 1 ? '' : 's'} with a computed path (not followed)`);
    if (info.partial) notes.push('the file looks syntactically incomplete; results may be partial');
    const cyc = g.cycle(f);
    if (cyc) notes.push(`import cycle: ${(cyc.length > 8 ? [...cyc.slice(0, 3), `… ${cyc.length - 6} more …`, ...cyc.slice(-3)] : cyc).join(' → ')}`);
    return tree(`${f}${isGo && info.pkg ? ` (package ${info.pkg})` : ''}`, [['Depends on', [...deps, ...ext]], ['Used by', users], ['Exports', sameFile], ['Notes', notes]]);
  }
  const out: string[] = [];
  for (const { file, decl } of symbols.slice(0, 3)) {
    const deps = g.symbolDeps(file, decl).map((d) => `${d.name}${d.file ? `  ${d.file}` : ''}  (L${d.line})`);
    const users = g.symbolUsers(file, decl).map((u) => `${u.by ?? '(top level)'}  ${u.file}:${u.line}  (${u.evidence})`);
    out.push(tree(`${decl.name}  (${decl.kind}${decl.exported ? ', exported' : ''} · ${file}:${decl.start})`, [['Depends on', deps.length ? deps : ['nothing detected in its body']], ['Used by', users.length ? users : ['no references found']]]));
  }
  if (symbols.length > 3) out.push(`… ${symbols.length - 3} more declarations named ${q}`);
  return out.join('\n\n');
}
