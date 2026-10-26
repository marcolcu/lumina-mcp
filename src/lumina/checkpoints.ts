import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RouterConfig } from '../smart-codex/config.js';
import { stateDir } from '../smart-codex/config.js';

/**
 * Checkpoints: before a code-modifying turn Lumina records the working tree's DIRTY state (contents of modified and
 * untracked files; clean files are covered by HEAD). After the turn it records exactly which files changed and their
 * before/after content hashes (git blob ids) plus the "before" bytes. Rollback restores a file only if it still has
 * the content Lumina left (so later manual edits, other processes and untouched files are never overwritten), and
 * is all-or-nothing. Stored under the state dir, never in the repository; no git commands that change anything.
 */

type Sha = string | null; // null = file absent
export type CheckpointStatus = 'pending' | 'active' | 'no-changes' | 'interrupted' | 'incomplete' | 'rolled-back';
interface PreEntry { sha: Sha; stored: boolean; unsafe?: 'oversize' | 'symlink'; /** size+mtime of files too large to snapshot */ fp?: string }
export interface FileChange { path: string; before: Sha; after: Sha; unsafe?: string }
export interface Manifest {
  version: 1; id: string; root: string; createdAt: number; task: string; status: CheckpointStatus;
  head: string | null; pre: Record<string, PreEntry>; changes: FileChange[]; finishedAt?: number; rolledBackAt?: number;
}
export interface PlanItem { path: string; action: 'restore' | 'delete' | 'recreate'; conflict?: string }
export interface RollbackPlan { checkpoint: Manifest; items: PlanItem[]; blocked?: string }

const blobSha = (buf: Buffer) => createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function git(cwd: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', '--no-pager', ...args], { cwd, encoding, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).split('\n')[0].replace(/^fatal:\s*/, '')));
      resolve(stdout);
    });
  });
}
const gitText = async (cwd: string, args: string[]) => String(await git(cwd, args, 'utf8'));

/** Repo-relative path that can never leave the repository (rejects absolute paths, `..`, NUL). */
export function safeRelative(root: string, rel: string): string {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === '..')) throw new Error(`unsafe path in checkpoint: ${JSON.stringify(rel)}`);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error(`path outside the repository: ${rel}`);
  // no symlinked ancestor may lead outside the repository
  let dir = path.dirname(abs);
  while (dir.startsWith(root) && dir !== root) {
    if (fs.existsSync(dir)) { if (!fs.realpathSync(dir).startsWith(root)) throw new Error(`path escapes the repository via a symlink: ${rel}`); break; }
    dir = path.dirname(dir);
  }
  return abs;
}

/** Current content hash of a working-tree file; 'symlink' for symlinks (never followed). */
function currentSha(abs: string): Sha | 'symlink' {
  try {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) return 'symlink';
    if (!st.isFile()) return null;
    return blobSha(fs.readFileSync(abs));
  } catch { return null; }
}

async function dirtyPaths(root: string): Promise<string[]> {
  const out = await gitText(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const f = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < f.length; i++) {
    if (f[i].length < 4) continue;
    paths.push(f[i].slice(3));
    if (f[i][0] === 'R' || f[i][0] === 'C') paths.push(f[++i]); // the old name of a rename/copy is affected too
  }
  return paths;
}

async function headBlobs(root: string, head: string | null, paths: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!head) return map;
  for (let i = 0; i < paths.length; i += 200) {
    const out = await gitText(root, ['ls-tree', '-z', head, '--', ...paths.slice(i, i + 200)]);
    for (const e of out.split('\0')) { const m = /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(e); if (m && m[2] === 'blob') map.set(m[4], m[3]); }
  }
  return map;
}

export class CheckpointStore {
  readonly root: string;
  readonly dir: string;
  private constructor(root: string, private readonly cfg: RouterConfig['checkpoints']) {
    this.root = root;
    this.dir = path.join(stateDir(), 'checkpoints', createHash('sha1').update(root).digest('hex').slice(0, 16));
  }

  /** Store for the git repository containing `cwd`, or an error explaining why checkpoints are unavailable. */
  static async open(cwd: string, cfg: RouterConfig['checkpoints']): Promise<CheckpointStore> {
    const top = (await gitText(cwd, ['rev-parse', '--show-toplevel'])).trim();
    return new CheckpointStore(fs.realpathSync(top), cfg);
  }

  private cpDir(id: string): string {
    if (!/^[a-z0-9]{8,32}$/.test(id)) throw new Error(`invalid checkpoint id: ${id}`);
    return path.join(this.dir, id);
  }
  private save(m: Manifest): void {
    fs.mkdirSync(this.cpDir(m.id), { recursive: true });
    const file = path.join(this.cpDir(m.id), 'manifest.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(m));
    fs.renameSync(`${file}.tmp`, file); // atomic
  }
  private storeBlob(id: string, sha: string, buf: Buffer): void {
    const f = path.join(this.cpDir(id), 'blobs', sha);
    if (fs.existsSync(f)) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, buf);
  }
  private readBlob(id: string, sha: string): Buffer {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('invalid blob id');
    const buf = fs.readFileSync(path.join(this.cpDir(id), 'blobs', sha));
    if (blobSha(buf) !== sha) throw new Error(`checkpoint data for ${sha.slice(0, 8)} is corrupted`);
    return buf;
  }

  load(id: string): Manifest {
    const m = JSON.parse(fs.readFileSync(path.join(this.cpDir(id), 'manifest.json'), 'utf8')) as Manifest;
    if (m.version !== 1 || m.id !== id || m.root !== this.root) throw new Error(`checkpoint ${id} does not belong to this repository`);
    for (const c of m.changes) safeRelative(this.root, c.path); // never trust stored paths
    return m;
  }

  /** All checkpoints of this repository, newest first. A pending one from a crashed session is reported as incomplete. */
  list(): Manifest[] {
    if (!fs.existsSync(this.dir)) return [];
    const out: Manifest[] = [];
    for (const id of fs.readdirSync(this.dir)) {
      try {
        const m = this.load(id);
        if (m.status === 'pending' && Date.now() - m.createdAt > 6 * 3600 * 1000) m.status = 'incomplete';
        out.push(m);
      } catch { /* unreadable entry: ignored */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Before a code-modifying turn: record the dirty part of the working tree. */
  async begin(task: string): Promise<Manifest> {
    this.cleanup();
    const id = randomUUID().replace(/-/g, '').slice(0, 12);
    const head = (await gitText(this.root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null;
    const m: Manifest = { version: 1, id, root: this.root, createdAt: Date.now(), task: task.replace(/\s+/g, ' ').trim().slice(0, 160), status: 'pending', head, pre: {}, changes: [] };
    let total = 0;
    for (const rel of await dirtyPaths(this.root)) {
      const abs = safeRelative(this.root, rel);
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(abs); } catch { st = undefined; }
      if (!st) { m.pre[rel] = { sha: null, stored: true }; continue; }
      if (st.isSymbolicLink()) { m.pre[rel] = { sha: null, stored: false, unsafe: 'symlink' }; continue; }
      if (!st.isFile()) continue;
      if (st.size > this.cfg.max_file_bytes || total + st.size > this.cfg.max_total_bytes) { m.pre[rel] = { sha: null, stored: false, unsafe: 'oversize', fp: `${st.size}:${st.mtimeMs}` }; continue; }
      const buf = fs.readFileSync(abs);
      const sha = blobSha(buf);
      this.storeBlob(id, sha, buf);
      total += buf.length;
      m.pre[rel] = { sha, stored: true };
    }
    this.save(m);
    return m;
  }

  /** After the turn: record what changed (and keep the "before" bytes). */
  async finish(m: Manifest, interrupted: boolean): Promise<Manifest> {
    const headNow = (await gitText(this.root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim() || null;
    const candidates = new Set([...Object.keys(m.pre), ...await dirtyPaths(this.root)]);
    if (m.head && headNow && headNow !== m.head) { // the turn committed: files in those commits changed too
      for (const p of (await gitText(this.root, ['diff', '--name-only', '-z', m.head, headNow])).split('\0')) if (p) candidates.add(p);
    }
    const inHead = await headBlobs(this.root, m.head, [...candidates].filter((p) => !(p in m.pre)));
    const changes: FileChange[] = [];
    for (const rel of candidates) {
      const abs = safeRelative(this.root, rel);
      const pre = m.pre[rel];
      if (pre?.unsafe === 'oversize') { // not snapshotted: untouched → ignore; touched → cannot be restored
        let fp = '';
        try { const st = fs.lstatSync(abs); fp = `${st.size}:${st.mtimeMs}`; } catch { /* gone */ }
        if (fp === pre.fp) continue;
        changes.push({ path: rel, before: null, after: null, unsafe: 'too large to snapshot before the change' });
        continue;
      }
      const before: Sha = pre ? pre.sha : inHead.get(rel) ?? null;
      const now = currentSha(abs);
      if (pre?.unsafe === 'symlink' && now === 'symlink') continue; // untouched pre-existing symlink
      if (now !== 'symlink' && pre?.unsafe !== 'symlink' && before === now) continue;
      const change: FileChange = { path: rel, before, after: now === 'symlink' ? null : now };
      if (now === 'symlink') change.unsafe = 'is a symlink now';
      else if (pre?.unsafe === 'symlink') change.unsafe = 'was a symlink';
      if (!pre && before && !change.unsafe) { // clean before the turn: keep the HEAD bytes so rollback never depends on git history
        try { this.storeBlob(m.id, before, await git(this.root, ['cat-file', 'blob', before], 'buffer') as Buffer); } catch { change.unsafe = 'original content unavailable'; }
      }
      changes.push(change);
    }
    m.changes = changes.sort((a, b) => a.path.localeCompare(b.path));
    m.status = !changes.length ? 'no-changes' : interrupted ? 'interrupted' : 'active';
    m.finishedAt = Date.now();
    if (m.status === 'no-changes') this.remove(m.id); else this.save(m);
    return m;
  }

  /** What a rollback would do; `blocked` explains why it cannot run automatically. */
  plan(id: string): RollbackPlan {
    const m = this.load(id);
    if (m.status === 'rolled-back') return { checkpoint: m, items: [], blocked: 'this checkpoint was already rolled back' };
    if (m.status === 'pending' || m.status === 'incomplete') return { checkpoint: m, items: [], blocked: 'the execution never finished recording its changes (Lumina was stopped), so Lumina cannot tell its edits from yours' };
    const items: PlanItem[] = m.changes.map((c) => {
      const abs = safeRelative(this.root, c.path);
      const action: PlanItem['action'] = c.before === null ? 'delete' : c.after === null ? 'recreate' : 'restore';
      if (c.unsafe) return { path: c.path, action, conflict: c.unsafe };
      const now = currentSha(abs);
      if (now === 'symlink') return { path: c.path, action, conflict: 'is a symlink now' };
      if (now !== c.after) return { path: c.path, action, conflict: now === null ? 'deleted after the checkpoint' : 'changed after Lumina edited it (newer manual edit or another process)' };
      return { path: c.path, action };
    });
    const conflicts = items.filter((i) => i.conflict).length;
    return { checkpoint: m, items, blocked: conflicts ? `${conflicts} file${conflicts === 1 ? '' : 's'} changed since — rolling back would overwrite work that is not Lumina's` : undefined };
  }

  /**
   * Applies a conflict-free plan all-or-nothing: current bytes are backed up first; if any write fails, every file
   * already touched is put back. Only working-tree files are changed (no git index, no commits, no remotes).
   */
  rollback(id: string, hooks: { beforeWrite?: (rel: string) => void } = {}): { restored: number } {
    const plan = this.plan(id);
    if (plan.blocked) throw new Error(plan.blocked);
    const m = plan.checkpoint;
    const backup = path.join(this.cpDir(id), `rollback-${Date.now()}`);
    fs.mkdirSync(backup, { recursive: true });
    const done: { rel: string; abs: string; had: boolean; bak: string }[] = [];
    try {
      for (const c of m.changes) {
        const abs = safeRelative(this.root, c.path);
        const bak = path.join(backup, createHash('sha1').update(c.path).digest('hex'));
        const had = fs.existsSync(abs);
        if (had) fs.copyFileSync(abs, bak);
        done.push({ rel: c.path, abs, had, bak });
        hooks.beforeWrite?.(c.path);
        if (c.before === null) { if (had) fs.unlinkSync(abs); continue; }
        const buf = this.readBlob(id, c.before);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = path.join(path.dirname(abs), `.lumina-rollback-${randomUUID().slice(0, 8)}`);
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, abs); // atomic per file
      }
    } catch (e) {
      const failedAt = done.at(-1)?.rel ?? '?';
      // undo everything already applied, newest first
      for (const d of [...done].reverse()) {
        try { if (d.had) fs.copyFileSync(d.bak, d.abs); else if (fs.existsSync(d.abs)) fs.unlinkSync(d.abs); } catch { /* reported below */ }
      }
      throw new Error(`rollback failed at ${failedAt} (${e instanceof Error ? e.message : String(e)}); all files were put back as they were`);
    }
    m.status = 'rolled-back';
    m.rolledBackAt = Date.now();
    this.save(m);
    return { restored: m.changes.length };
  }

  private remove(id: string): void { fs.rmSync(this.cpDir(id), { recursive: true, force: true }); }

  /** Retention: keep at most max_count checkpoints and none older than max_age_days (only Lumina's own storage). */
  cleanup(): void {
    const all = this.list();
    const cutoff = Date.now() - this.cfg.max_age_days * 86400000;
    all.forEach((m, i) => { if (i >= this.cfg.max_count || m.createdAt < cutoff) this.remove(m.id); });
  }
}
