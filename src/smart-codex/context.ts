import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface DiscoveryLimits { maxFiles: number; maxScanned: number; maxDepth: number; maxReadBytes: number; }
export interface Discovery { files: string[]; confident: boolean; components: number; }

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'fix', 'add', 'create', 'update', 'make', 'bug', 'new', 'use', 'change', 'implement']);
const SKIP = /(^|\/)(node_modules|dist|coverage|build|\.git)\//;
const BINARY = /\.(lock|png|jpe?g|gif|svg|ico|map|woff2?|pdf|zip)$/i;
const IS_TEST = /\.(test|spec)\.[a-z]+$/i;
const EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
const IMPORT = /(?:from|import|require\()\s*['"](\.{1,2}\/[^'"\n]+)['"]/g;
const MAX_SEED_READS = 10;

// git ls-files is the only subprocess; cache it per repo until .git/index changes.
const listCache = new Map<string, { stamp: number; files: string[] }>();

function listFiles(repo: string): string[] | null {
  let stamp = 0;
  try { stamp = fs.statSync(path.join(repo, '.git', 'index')).mtimeMs; } catch { /* worktree/subdir: no caching */ }
  const hit = stamp ? listCache.get(repo) : undefined;
  if (hit?.stamp === stamp) return hit.files;
  try {
    const files = execFileSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8', maxBuffer: 32 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
    if (stamp) listCache.set(repo, { stamp, files });
    return files;
  } catch {
    return null;
  }
}

/** Reads at most `bytes` from a regular file that resolves inside `root`. Never follows symlinks out of the repo. */
function readHead(root: string, rel: string, bytes: number): string {
  try {
    const full = path.join(root, rel);
    if (fs.lstatSync(full).isSymbolicLink() || !fs.realpathSync(full).startsWith(root)) return '';
    const fd = fs.openSync(full, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0));
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
}

function resolveImports(rel: string, head: string, known: Set<string>): string[] {
  const out: string[] = [];
  for (const m of head.matchAll(IMPORT)) {
    const base = path.posix.join(path.posix.dirname(rel), m[1].replace(/\.(m|c)?js$/, ''));
    const hit = EXT.map((e) => base + e).find((c) => known.has(c));
    if (hit && hit !== rel) out.push(hit);
  }
  return out;
}

export function discover(task: string, repoInput: string, lim: DiscoveryLimits): Discovery {
  const none = { files: [], confident: false, components: 0 };
  if (lim.maxFiles === 0) return none;
  let root: string;
  try { root = fs.realpathSync(repoInput); } catch { return none; }
  const listing = listFiles(root)?.slice(0, lim.maxScanned);
  if (!listing) return none;

  const words = [...new Set(task.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
  if (!words.length) return none;
  const scored = listing
    .filter((f) => !SKIP.test(f) && !BINARY.test(f) && !IS_TEST.test(f))
    .map((f) => {
      const base = path.basename(f).toLowerCase();
      const dir = path.dirname(f).toLowerCase();
      return { f, s: words.reduce((n, w) => n + (base.includes(w) ? 3 : dir.includes(w) ? 1 : 0), 0) };
    })
    .filter((x) => x.s > 0);
  if (!scored.length) return none;
  // directory proximity: files sharing a directory with the best matches rank slightly higher
  const topDirs = new Set(scored.sort((a, b) => b.s - a.s).slice(0, 3).map((x) => path.dirname(x.f)));
  for (const x of scored) if (topDirs.has(path.dirname(x.f))) x.s += 1;
  scored.sort((a, b) => b.s - a.s || a.f.localeCompare(b.f));

  const seeds = scored.slice(0, 5);
  const result = new Set(seeds.map((x) => x.f));
  const known = new Set(listing);

  // bounded import analysis: relative imports of the seeds, up to maxDepth hops
  let frontier = seeds.map((x) => x.f);
  let reads = 0;
  for (let depth = 0; depth < lim.maxDepth && frontier.length && reads < MAX_SEED_READS; depth++) {
    const next: string[] = [];
    for (const f of frontier) {
      if (reads++ >= MAX_SEED_READS) break;
      for (const dep of resolveImports(f, readHead(root, f, lim.maxReadBytes), known)) {
        if (!result.has(dep)) { result.add(dep); next.push(dep); }
      }
    }
    frontier = next;
  }
  // related tests for the seeds
  const stems = seeds.map((x) => path.basename(x.f).replace(/\.[^.]+$/, '').toLowerCase());
  const tests = listing.filter((f) => IS_TEST.test(f) && !SKIP.test(f) && stems.some((s) => path.basename(f).toLowerCase().startsWith(`${s}.`))).slice(0, 2);

  const files = [...result, ...tests].slice(0, lim.maxFiles);
  const components = new Set(files.map((f) => f.split('/').slice(0, 2).join('/'))).size;
  return { files, confident: seeds[0].s >= 4, components };
}
