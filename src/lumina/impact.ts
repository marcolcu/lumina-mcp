import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Decl, DependencyGraph, FileInfo, mask, parseGo, parseTs } from './graph.js';
import { CRITICAL, Change, SHARED_DIR, TEST_FILE } from './verify.js';

/**
 * Change impact prediction over the dependency graph. CONFIRMED = files with an actual graph edge to the target
 * (an import of it, or a reference to the symbol); PREDICTED = files that reach those through further import edges
 * (bounded breadth-first walk). Predictions are possibilities, not failures. For actual changes, the HEAD version of
 * each changed file is parsed too, to report removed exports and changed signatures/contracts. No model calls.
 */
export type Risk = 'low' | 'medium' | 'high';
export interface Affected { file: string; by?: string; evidence: string; depth: number; via?: string[]; typeOnly?: boolean }
export interface Breaking { file: string; symbol: string; change: 'removed export' | 'signature changed' | 'contract changed'; users: number; before?: string; after?: string }
export interface ImpactReport {
  target: string;
  targets: string[];
  confirmed: Affected[];
  predicted: Affected[];
  tests: string[];
  modules: string[];
  breaking: Breaking[];
  risk: Risk;
  reasons: string[];
  notes: string[];
  truncated: boolean;
}

const MAX_DEPTH = 3;
const MAX_NODES = 300;
const CONTRACT = new Set(['interface', 'type', 'enum', 'class']);
const moduleOf = (f: string) => { const s = f.split('/'); return s.length > 2 && ['src', 'internal', 'apps', 'packages', 'pkg', 'services', 'cmd', 'lib'].includes(s[0]) ? `${s[0]}/${s[1]}` : s.length > 1 ? s[0] : '.'; };
const isGo = (g: DependencyGraph, f: string) => g.files.get(f)?.lang === 'go';
const node = (g: DependencyGraph, f: string) => (isGo(g, f) ? `${path.posix.dirname(f)}/` : f);

/** Files with an import edge to `f` (Go: to its package), with the edge as evidence. */
function importers(g: DependencyGraph, f: string): Affected[] {
  return (g.rdeps.get(node(g, f)) ?? []).map((e) => ({ file: e.from, evidence: `${e.kind === 'package' ? 'imports the package' : `${e.kind} import`} at ${e.from}:${e.line}`, depth: 1, typeOnly: e.kind === 'type' }));
}

/** Breadth-first over reverse import edges from the confirmed set; bounded by depth and node count. */
function expand(g: DependencyGraph, start: Affected[], exclude: Set<string>): { predicted: Affected[]; truncated: boolean } {
  const seen = new Set([...exclude, ...start.map((a) => a.file)]);
  const predicted: Affected[] = [];
  let frontier = start.map((a) => ({ file: a.file, via: [a.file] }));
  let truncated = false;
  for (let depth = 2; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: { file: string; via: string[] }[] = [];
    for (const f of frontier) {
      for (const imp of importers(g, f.file)) {
        if (seen.has(imp.file)) continue; // cycles and diamonds are visited once
        if (seen.size >= MAX_NODES) { truncated = true; break; }
        seen.add(imp.file);
        predicted.push({ ...imp, depth, via: [...f.via, imp.file], evidence: `reaches ${f.via[0]} through ${[...f.via].reverse().join(' ← ')} (${imp.evidence})` });
        next.push({ file: imp.file, via: [...f.via, imp.file] });
      }
    }
    frontier = next;
  }
  if (frontier.length && !truncated) truncated = frontier.some((f) => importers(g, f.file).some((i) => !seen.has(i.file)));
  return { predicted, truncated };
}

/** Tests among the affected files, plus tests named after the targets, plus Go tests of affected packages. */
function relatedTests(g: DependencyGraph, targets: string[], affected: string[]): string[] {
  const tests = new Set(affected.filter((f) => TEST_FILE.test(f)));
  const stems = new Set(targets.map((t) => path.posix.basename(t).replace(/(_test)?\.[^.]+$/, '').toLowerCase()));
  const goDirs = new Set([...targets, ...affected].filter((f) => f.endsWith('.go')).map((f) => path.posix.dirname(f)));
  for (const f of g.files.keys()) {
    if (!TEST_FILE.test(f)) continue;
    const stem = path.posix.basename(f).replace(/(_test)?\.[^.]+$/, '').replace(/\.(test|spec)$/, '').toLowerCase();
    if (stems.has(stem) || (f.endsWith('_test.go') && goDirs.has(path.posix.dirname(f)))) tests.add(f);
  }
  return [...tests].sort();
}

/** What the graph cannot see: computed dynamic imports elsewhere, unresolved specifiers that may mean the target, unindexed files. */
function blindSpots(g: DependencyGraph, targets: string[]): string[] {
  const notes: string[] = [];
  const unindexed = targets.filter((t) => !g.files.has(t) || g.files.get(t)!.skipped);
  if (unindexed.length) notes.push(`not in the dependency graph (only Go and TS/JS are indexed, large files and symlinks are skipped): ${unindexed.join(', ')}`);
  const dyn = [...g.files.values()].filter((i) => i.dynamicUnresolved > 0).length;
  if (dyn) notes.push(`${dyn} file${dyn === 1 ? '' : 's'} use dynamic imports with computed paths; dependencies through them are invisible`);
  const stems = targets.map((t) => path.posix.basename(t).replace(/\.[^.]+$/, ''));
  for (const u of g.unresolved) if (stems.some((s) => s.length > 2 && u.spec.includes(s))) notes.push(`unresolved import '${u.spec}' in ${u.from}:${u.line} may refer to the target`);
  return notes.slice(0, 6);
}

function classify(r: Omit<ImpactReport, 'risk' | 'reasons'>, decls: { file: string; decl: Decl }[]): { risk: Risk; reasons: string[] } {
  const reasons: string[] = [];
  const outside = new Set(r.confirmed.map((a) => moduleOf(a.file)).filter((m) => !r.targets.map(moduleOf).includes(m)));
  const used = r.breaking.filter((b) => b.users > 0);
  // interfaces, types and enums are contracts; a class's dependents depend on its implementation too, so it is not one by itself
  const contracts = decls.filter((d) => d.decl.exported && CONTRACT.has(d.decl.kind) && d.decl.kind !== 'class' && r.confirmed.length > 0);
  const shared = r.targets.some((t) => SHARED_DIR.test(t)) && r.confirmed.length >= 3;
  const critical = r.targets.some((t) => CRITICAL.test(t)) && r.confirmed.length > 0;
  if (used.length) reasons.push(`${used.length} possibly breaking change${used.length === 1 ? '' : 's'} to symbols still used elsewhere (${used.slice(0, 3).map((b) => `${b.symbol}: ${b.change}`).join(', ')})`);
  if (contracts.length && r.confirmed.length >= 2) reasons.push(`shared contract (${contracts.slice(0, 3).map((d) => `${d.decl.kind} ${d.decl.name}`).join(', ')}) used by ${r.confirmed.length} files`);
  if (shared) reasons.push(`shared library code used by ${r.confirmed.length} files`);
  if (critical) reasons.push('security/payment-sensitive component with dependents');
  if (reasons.length) return { risk: 'high', reasons };
  if (r.confirmed.length >= 10) return { risk: 'high', reasons: [`${r.confirmed.length} files depend on it directly`] };
  if (outside.size >= 1 || r.confirmed.length >= 3 || r.predicted.length >= 5) {
    return { risk: 'medium', reasons: [`${r.confirmed.length} direct dependent${r.confirmed.length === 1 ? '' : 's'}${outside.size ? ` in ${outside.size} other module${outside.size === 1 ? '' : 's'} (${[...outside].slice(0, 3).join(', ')})` : ''}${r.predicted.length ? `, ${r.predicted.length} more reachable` : ''}`] };
  }
  return { risk: 'low', reasons: [r.confirmed.length ? `only ${r.confirmed.length} nearby dependent${r.confirmed.length === 1 ? '' : 's'} in the same module` : 'no dependents found: a local change'] };
}

/** Planned change to a file or symbol (before editing). */
export function predictImpact(g: DependencyGraph, query: string): ImpactReport | string {
  const q = query.trim();
  const fileHits = q.includes('/') || /\.(?:[cm]?[jt]sx?|go)$/.test(q) ? g.matchFiles(q) : [];
  const symbols = fileHits.length ? [] : g.findSymbol(q);
  if (!fileHits.length && !symbols.length) return `No file or symbol "${q}" in the dependency graph (Go and TS/JS are indexed); nothing to predict from.`;
  if (fileHits.length > 1 && !fileHits.includes(q)) return `"${q}" matches ${fileHits.length} files: ${fileHits.slice(0, 8).join(', ')}${fileHits.length > 8 ? ', …' : ''}. Use a longer path.`;
  if (fileHits.length) return analyze(g, q, [fileHits[0]], [], g.files.get(fileHits[0])?.decls.filter((d) => d.exported).map((decl) => ({ file: fileHits[0], decl })) ?? []);
  const decls = symbols.filter((s) => s.decl.exported || symbols.length === 1).slice(0, 5);
  return analyze(g, q, [...new Set(decls.map((d) => d.file))], [], decls, true);
}

function analyze(g: DependencyGraph, target: string, targets: string[], breaking: Breaking[], decls: { file: string; decl: Decl }[], bySymbol = false): ImpactReport {
  const confirmed = new Map<string, Affected>();
  if (bySymbol) {
    for (const { file, decl } of decls) for (const u of g.symbolUsers(file, decl)) if (!targets.includes(u.file) || u.by) confirmed.set(u.file, confirmed.get(u.file) ?? { file: u.file, by: u.by, evidence: `${u.evidence} at ${u.file}:${u.line}`, depth: 1 });
  } else for (const t of targets) for (const a of importers(g, t)) if (!targets.includes(a.file)) confirmed.set(a.file, confirmed.get(a.file) ?? a);
  // removed symbols: whoever still imports them is confirmed affected
  for (const b of breaking) for (const u of symbolUsersByName(g, b.file, b.symbol)) if (!confirmed.has(u.file)) confirmed.set(u.file, { file: u.file, by: u.by, evidence: `${u.evidence} at ${u.file}:${u.line}`, depth: 1 });
  const direct = [...confirmed.values()].filter((a) => !targets.includes(a.file)).sort((a, b) => a.file.localeCompare(b.file));
  const { predicted, truncated } = expand(g, direct, new Set(targets));
  const base = { target, targets, confirmed: direct, predicted, breaking, truncated, modules: [...new Set([...targets, ...direct.map((a) => a.file), ...predicted.map((a) => a.file)].map(moduleOf))].sort(), tests: relatedTests(g, targets, [...direct, ...predicted].map((a) => a.file)), notes: blindSpots(g, targets) };
  const { risk, reasons } = classify(base, decls);
  return { ...base, risk, reasons };
}

function symbolUsersByName(g: DependencyGraph, file: string, name: string) {
  if (!g.files.has(file)) return [];
  return g.symbolUsers(file, { name, kind: 'removed', start: -1, end: -1, exported: true }).filter((u) => u.file !== file);
}

const git = (cwd: string, args: string[]) => new Promise<string | null>((resolve) => { execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 8 << 20 }, (err, out) => resolve(err ? null : out)); });

/** Signature text of a declaration: header (functions, methods, classes) or whole body (types, interfaces, structs). */
export function signatures(src: string, info: FileInfo): Map<string, { kind: string; sig: string }> {
  const lines = mask(src, info.lang).code.split('\n');
  const out = new Map<string, { kind: string; sig: string }>();
  for (const d of info.decls) {
    if (!d.exported) continue;
    const text = lines.slice(d.start - 1, d.end).join('\n');
    const whole = d.kind === 'interface' || d.kind === 'type' || d.kind === 'enum';
    const head = whole ? text : text.slice(0, (() => { const i = text.search(/\{|=>/); return i < 0 ? text.length : i; })());
    out.set(d.name, { kind: d.kind, sig: head.replace(/\s+/g, ' ').replace(/^export\s+(default\s+)?/, '').trim() });
  }
  return out;
}

/** Actual changes (working tree vs HEAD): removed exports and changed signatures/contracts, then their impact. */
export async function analyzeChanges(g: DependencyGraph, changes: Change[]): Promise<ImpactReport> {
  const breaking: Breaking[] = [];
  const decls: { file: string; decl: Decl }[] = [];
  const targets = changes.map((c) => c.path).filter((f) => /\.(?:[cm]?[jt]sx?|go)$/.test(f));
  for (const c of changes) {
    if (!/\.(?:[cm]?[jt]sx?|go)$/.test(c.path) || c.kind === 'added') { const info = g.files.get(c.path); for (const d of info?.decls ?? []) if (d.exported) decls.push({ file: c.path, decl: d }); continue; }
    const before = await git(g.root, ['show', `HEAD:${c.path}`]);
    if (before === null) continue;
    const go = c.path.endsWith('.go');
    const oldInfo = go ? parseGo(before) : parseTs(before);
    const oldSigs = signatures(before, oldInfo);
    const nowInfo = g.files.get(c.path);
    let nowSrc = '';
    if (nowInfo && c.kind !== 'deleted') { try { nowSrc = fs.readFileSync(path.join(g.root, c.path), 'utf8'); } catch { /* gone */ } }
    const nowSigs = nowInfo && nowSrc ? signatures(nowSrc, nowInfo) : new Map<string, { kind: string; sig: string }>();
    for (const [name, old] of oldSigs) {
      const now = nowSigs.get(name);
      const users = () => symbolUsersByName(g, c.path, name).length;
      if (!now) breaking.push({ file: c.path, symbol: name, change: 'removed export', users: users(), before: old.sig.slice(0, 160) });
      else if (now.sig !== old.sig) breaking.push({ file: c.path, symbol: name, change: CONTRACT.has(old.kind) && old.kind !== 'class' ? 'contract changed' : 'signature changed', users: users(), before: old.sig.slice(0, 160), after: now.sig.slice(0, 160) });
    }
    for (const d of nowInfo?.decls ?? []) if (d.exported && breaking.some((b) => b.file === c.path && b.symbol === d.name)) decls.push({ file: c.path, decl: d });
  }
  // a deleted file leaves its importers with unresolved imports: those are confirmed affected
  const gone = changes.filter((c) => c.kind === 'deleted').map((c) => c.path.replace(/\.[^.]+$/, ''));
  const report = analyze(g, changes.length === 1 ? changes[0].path : `${changes.length} changed files`, targets, breaking, decls);
  for (const u of g.unresolved) {
    const p = path.posix.normalize(path.posix.join(path.posix.dirname(u.from), u.spec)).replace(/\.[^.]+$/, '');
    if (gone.includes(p) || gone.includes(`${p}/index`)) report.confirmed.push({ file: u.from, evidence: `imports '${u.spec}' (deleted) at ${u.from}:${u.line}`, depth: 1 });
  }
  if (report.confirmed.some((a) => a.evidence.includes('(deleted)')) && report.risk !== 'high') { report.risk = 'high'; report.reasons.unshift('a deleted file is still imported'); }
  return report;
}

const LIMIT = 15;
const list = (xs: string[]) => (xs.length > LIMIT ? [...xs.slice(0, LIMIT), `… ${xs.length - LIMIT} more`] : xs);

/** /impact output: confirmed (graph edges) separated from predicted (reachable), risk with reasons. */
export function formatImpact(r: ImpactReport): string {
  const out = [`Target: ${r.target}${r.targets.length && r.targets[0] !== r.target ? `  (${r.targets.slice(0, 3).join(', ')}${r.targets.length > 3 ? ', …' : ''})` : ''}`, '', `Risk: ${r.risk[0].toUpperCase()}${r.risk.slice(1)}`, ...r.reasons.map((x) => `  - ${x}`)];
  if (r.breaking.length) out.push('', 'Possibly breaking changes:', ...list(r.breaking.map((b) => `  - ${b.symbol} (${b.file}): ${b.change}${b.users ? ` · still used by ${b.users}` : ' · no users found'}${b.after ? `\n      before: ${b.before}\n      after:  ${b.after}` : ''}`)));
  out.push('', `Confirmed dependents (graph edges): ${r.confirmed.length}`, ...list(r.confirmed.map((a) => `  - ${a.by ? `${a.by} · ` : ''}${a.file}${a.typeOnly ? ' (type only)' : ''} — ${a.evidence}`)));
  out.push('', `Potential impact (reachable through imports, not confirmed): ${r.predicted.length}${r.truncated ? ' (search bounded; more may exist)' : ''}`, ...list(r.predicted.map((a) => `  - ${a.file} — via ${a.via!.slice(0, -1).join(' ← ')}`)));
  if (r.tests.length) out.push('', 'Relevant tests:', ...list(r.tests.map((t) => `  - ${t}`)));
  if (r.modules.length > 1) out.push('', `Modules: ${r.modules.join(', ')}`);
  if (r.notes.length) out.push('', 'Blind spots:', ...r.notes.map((n) => `  - ${n}`));
  out.push('', 'Predictions show what could be affected, not what will fail; Codex can inspect other files as needed.');
  return out.join('\n');
}
