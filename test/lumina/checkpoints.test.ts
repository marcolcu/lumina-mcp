import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/smart-codex/config.js';
import { CheckpointStore, safeRelative } from '../../src/lumina/checkpoints.js';

const cfg = (o: Record<string, unknown> = {}) => ConfigSchema.parse({ checkpoints: o }).checkpoints;
const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' });
let root: string;
const w = (f: string, c: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
const r = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f: string) => fs.existsSync(path.join(root, f));

beforeEach(() => {
  process.env.SMART_CODEX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-cphome-'));
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-cp-')));
  g(root, 'init', '-q'); g(root, 'config', 'user.email', 't@t'); g(root, 'config', 'user.name', 't');
  w('a.ts', 'a1\n'); w('b.ts', 'b1\n'); w('del.ts', 'bye\n'); w('img.bin', Buffer.from([0, 1, 2]));
  g(root, 'add', '-A'); g(root, 'commit', '-qm', 'init');
});
const open = async (o = {}) => CheckpointStore.open(root, cfg(o));

describe('checkpoint + rollback', () => {
  it('clean tree: modified, new, deleted and binary files are restored exactly; the tree is clean again', async () => {
    const s = await open();
    const cp = await s.begin('make changes');
    w('a.ts', 'a2\n'); w('new.ts', 'new\n'); fs.rmSync(path.join(root, 'del.ts')); w('img.bin', Buffer.from([9, 9]));
    const m = await s.finish(cp, false);
    expect(m.status).toBe('active');
    expect(m.changes.map((c) => c.path)).toEqual(['a.ts', 'del.ts', 'img.bin', 'new.ts']);
    expect(s.plan(cp.id).items.map((i) => `${i.action}:${i.path}`)).toEqual(['restore:a.ts', 'recreate:del.ts', 'restore:img.bin', 'delete:new.ts']);
    expect(s.plan(cp.id).blocked).toBeUndefined();
    expect(s.rollback(cp.id).restored).toBe(4);
    expect(g(root, 'status', '--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(root, 'img.bin'))).toEqual(Buffer.from([0, 1, 2]));
    expect(s.load(cp.id).status).toBe('rolled-back');
    expect(s.plan(cp.id).blocked).toMatch(/already rolled back/);
  });
  it('dirty tree: pre-existing user changes survive; a file both edited restores to the USER version, not HEAD', async () => {
    w('a.ts', 'user edit\n'); w('user-new.md', 'mine\n'); w('b.ts', 'user b\n');
    const s = await open();
    const cp = await s.begin('t');
    w('b.ts', 'lumina b\n'); w('lumina.ts', 'x\n');
    const m = await s.finish(cp, false);
    expect(m.changes.map((c) => c.path)).toEqual(['b.ts', 'lumina.ts']); // a.ts / user-new.md untouched by Lumina
    s.rollback(cp.id);
    expect([r('a.ts'), r('b.ts'), r('user-new.md'), exists('lumina.ts')]).toEqual(['user edit\n', 'user b\n', 'mine\n', false]);
  });
  it('manual edit after the checkpoint → conflict, rollback refused, nothing written', async () => {
    const s = await open();
    const cp = await s.begin('t');
    w('a.ts', 'lumina\n'); w('b.ts', 'lumina b\n');
    await s.finish(cp, false);
    w('a.ts', 'user changed it again\n');
    const plan = s.plan(cp.id);
    expect(plan.blocked).toMatch(/1 file changed since/);
    expect(plan.items.find((i) => i.path === 'a.ts')!.conflict).toMatch(/changed after Lumina edited it/);
    expect(() => s.rollback(cp.id)).toThrow(/changed since/);
    expect([r('a.ts'), r('b.ts')]).toEqual(['user changed it again\n', 'lumina b\n']);
  });
  it('a newer checkpoint touching the same file must be rolled back first', async () => {
    const s = await open();
    const c1 = await s.begin('one'); w('a.ts', 'v2\n'); await s.finish(c1, false);
    const c2 = await s.begin('two'); w('a.ts', 'v3\n'); await s.finish(c2, false);
    expect(s.plan(c1.id).blocked).toBeTruthy();
    s.rollback(c2.id);
    s.rollback(c1.id);
    expect(r('a.ts')).toBe('a1\n');
  });
  it('turns that commit: committed files are still tracked and restored (no git history rewritten)', async () => {
    const s = await open();
    const cp = await s.begin('t');
    w('a.ts', 'committed by lumina\n'); g(root, 'commit', '-qam', 'lumina');
    const m = await s.finish(cp, false);
    expect(m.changes.map((c) => c.path)).toEqual(['a.ts']);
    s.rollback(cp.id);
    expect(r('a.ts')).toBe('a1\n');
    expect(g(root, 'log', '--oneline').split('\n').filter(Boolean)).toHaveLength(2); // the commit stays; only the file is restored
  });
  it('interrupted turns are recorded and can be rolled back; a crashed (never finished) checkpoint cannot', async () => {
    const s = await open();
    const cp = await s.begin('t'); w('a.ts', 'half\n');
    expect((await s.finish(cp, true)).status).toBe('interrupted');
    s.rollback(cp.id);
    expect(r('a.ts')).toBe('a1\n');
    const crashed = await s.begin('t2'); w('b.ts', 'partial\n');
    expect(s.plan(crashed.id).blocked).toMatch(/never finished recording/);
  });
  it('no changes → checkpoint removed; checkpoints survive a restart (new store instance)', async () => {
    const s = await open();
    const empty = await s.begin('noop');
    expect((await s.finish(empty, false)).status).toBe('no-changes');
    const cp = await s.begin('keep'); w('a.ts', 'x\n'); await s.finish(cp, false);
    const again = await open();
    expect(again.list().map((m) => [m.id, m.task, m.status, m.changes.length])).toEqual([[cp.id, 'keep', 'active', 1]]);
    expect(again.dir.startsWith(process.env.SMART_CODEX_HOME!)).toBe(true); // stored outside the repository
    expect(g(root, 'status', '--porcelain')).toBe(' M a.ts\n');
  });
  it('failed restore mid-way: every file already restored is put back (no half-rolled-back tree)', async () => {
    const s = await open();
    const cp = await s.begin('t');
    w('a.ts', 'A\n'); w('b.ts', 'B\n'); w('new.ts', 'N\n');
    await s.finish(cp, false);
    expect(() => s.rollback(cp.id, { beforeWrite: (rel) => { if (rel === 'new.ts') throw new Error('disk full'); } })).toThrow(/rollback failed at new\.ts \(disk full\); all files were put back/);
    expect([r('a.ts'), r('b.ts'), r('new.ts')]).toEqual(['A\n', 'B\n', 'N\n']);
    expect(s.load(cp.id).status).toBe('active'); // can be retried
  });
  it('oversize files are not snapshotted: untouched ones are ignored, touched ones block rollback', async () => {
    w('big.log', 'x'.repeat(5000));
    const s = await open({ max_file_bytes: 1024 });
    const cp = await s.begin('t'); w('a.ts', 'z\n');
    const m = await s.finish(cp, false);
    expect(m.changes.map((c) => c.path)).toEqual(['a.ts']);
    const cp2 = await s.begin('t2'); w('big.log', 'y'.repeat(6000));
    await s.finish(cp2, false);
    expect(s.plan(cp2.id).blocked).toBeTruthy();
    expect(s.plan(cp2.id).items[0].conflict).toMatch(/too large/);
  });
  it('symlinks are never followed or restored; untouched pre-existing symlinks do not block', async () => {
    fs.symlinkSync('/etc/hosts', path.join(root, 'link'));
    const s = await open();
    const cp = await s.begin('t'); w('a.ts', 'q\n');
    expect((await s.finish(cp, false)).changes.map((c) => c.path)).toEqual(['a.ts']);
    const cp2 = await s.begin('t2'); fs.symlinkSync('/etc/passwd', path.join(root, 'evil'));
    await s.finish(cp2, false);
    expect(s.plan(cp2.id).items.find((i) => i.path === 'evil')!.conflict).toMatch(/symlink/);
  });
  it('retention keeps at most max_count checkpoints', async () => {
    const s = await open({ max_count: 2 });
    for (let i = 0; i < 4; i++) { const cp = await s.begin(`t${i}`); w('a.ts', `v${i}\n`); await s.finish(cp, false); }
    expect(s.list().length).toBeLessThanOrEqual(3); // cleanup runs before each new checkpoint
    expect(s.list()[0].task).toBe('t3');
  });
});

describe('safety of stored data', () => {
  it('rejects traversal, absolute paths and tampered manifests; rejects corrupted blobs', async () => {
    expect(() => safeRelative(root, '../outside')).toThrow(/unsafe path/);
    expect(() => safeRelative(root, '/etc/passwd')).toThrow(/unsafe path/);
    expect(() => safeRelative(root, 'a/../../x')).toThrow(/unsafe path/);
    fs.symlinkSync(os.tmpdir(), path.join(root, 'outlink'));
    expect(() => safeRelative(root, 'outlink/file')).toThrow(/escapes the repository via a symlink/);
    const s = await open();
    const cp = await s.begin('t'); w('a.ts', 'x\n'); await s.finish(cp, false);
    const mf = path.join(s.dir, cp.id, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    m.changes[0].path = '../../etc/hosts';
    fs.writeFileSync(mf, JSON.stringify(m));
    expect(() => s.plan(cp.id)).toThrow(/unsafe path/);
    expect(() => s.load('../x')).toThrow(/invalid checkpoint id/);
  });
  it('not a git repository → a clear error', async () => {
    await expect(CheckpointStore.open(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-nogit-')), cfg())).rejects.toThrow(/not a git repository/);
  });
});
