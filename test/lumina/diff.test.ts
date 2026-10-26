import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { ChangedFile, fileDiff, listChanges } from '../../src/lumina/diff.js';
import { DiffViewer } from '../../src/lumina/tui/diffview.js';
import { KeyParser } from '../../src/lumina/tui/keys.js';

const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: 'pipe' });
function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-diff-'));
  g(d, 'init', '-q'); g(d, 'config', 'user.email', 't@t'); g(d, 'config', 'user.name', 't');
  const w = (f: string, c: string | Buffer) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
  w('keep.ts', 'a\nb\nc\n'); w('gone.ts', 'x\n'); w('old-name.ts', 'same content here\nline 2\nline 3\n'); w('img.bin', Buffer.from([0, 1, 2, 3]));
  g(d, 'add', '-A'); g(d, 'commit', '-qm', 'init');
  w('keep.ts', 'a\nB changed\nc\nd added\n'); // unstaged modify
  fs.rmSync(path.join(d, 'gone.ts')); // unstaged delete
  g(d, 'mv', 'old-name.ts', 'new-name.ts'); // staged rename
  w('staged-new.ts', 'hello\n'); g(d, 'add', 'staged-new.ts'); // staged add
  w('img.bin', Buffer.from([0, 9, 9, 9, 9])); // unstaged binary change
  w('notes/untracked.md', 'one\ntwo\n'); w('raw.dat', Buffer.from([0, 0, 1]));
  return d;
}

describe('listChanges / fileDiff (real git, read-only)', () => {
  let d: string;
  let files: ChangedFile[];
  beforeAll(async () => { d = repo(); files = await listChanges(d); });
  const find = (section: string, p: string) => files.find((f) => f.section === section && f.path === p)!;

  it('groups staged, unstaged and untracked with status and line stats', () => {
    expect(files.map((f) => `${f.section}:${f.status}:${f.path}`)).toEqual([
      'staged:R:new-name.ts', 'staged:A:staged-new.ts',
      'unstaged:D:gone.ts', 'unstaged:M:img.bin', 'unstaged:M:keep.ts',
      'untracked:?:notes/untracked.md', 'untracked:?:raw.dat',
    ]);
    expect(find('staged', 'new-name.ts').origPath).toBe('old-name.ts');
    expect(find('unstaged', 'keep.ts')).toMatchObject({ added: 2, removed: 1, binary: false });
    expect(find('unstaged', 'gone.ts')).toMatchObject({ added: 0, removed: 1 });
    expect(find('unstaged', 'img.bin')).toMatchObject({ binary: true, added: null });
    expect(find('untracked', 'notes/untracked.md')).toMatchObject({ added: 2, binary: false });
    expect(find('untracked', 'raw.dat').binary).toBe(true);
  });
  it('per-file diffs for modified, deleted, added, renamed, untracked and binary files', async () => {
    expect((await fileDiff(d, find('unstaged', 'keep.ts'))).lines).toEqual(expect.arrayContaining(['-b', '+B changed', '+d added']));
    expect((await fileDiff(d, find('unstaged', 'gone.ts'))).lines).toEqual(expect.arrayContaining(['deleted file mode 100644', '-x']));
    expect((await fileDiff(d, find('staged', 'staged-new.ts'))).lines).toContain('+hello');
    expect((await fileDiff(d, find('staged', 'new-name.ts'))).lines).toEqual(expect.arrayContaining(['rename from old-name.ts', 'rename to new-name.ts']));
    expect((await fileDiff(d, find('untracked', 'notes/untracked.md'))).lines).toEqual(expect.arrayContaining(['+one', '+two']));
    expect((await fileDiff(d, find('unstaged', 'img.bin'))).lines.join('\n')).toMatch(/Binary files .* differ/);
  });
  it('never changes the repository', () => {
    const before = execFileSync('git', ['status', '--porcelain'], { cwd: d, encoding: 'utf8' });
    expect(before).toContain('R  old-name.ts -> new-name.ts');
    expect(fs.existsSync(path.join(d, 'gone.ts'))).toBe(false);
  });
  it('clean tree → no changes; not a repo → clear error', async () => {
    const clean = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-clean-'));
    g(clean, 'init', '-q');
    expect(await listChanges(clean)).toEqual([]);
    await expect(listChanges(fs.mkdtempSync(path.join(os.tmpdir(), 'lum-norepo-')))).rejects.toThrow(/not a git repository/);
  });
  it('large diffs are capped and flagged as truncated', async () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'lum-big-'));
    g(big, 'init', '-q');
    fs.writeFileSync(path.join(big, 'big.txt'), Array.from({ length: 30000 }, (_, i) => `line ${i}`).join('\n'));
    const f = (await listChanges(big))[0];
    const r = await fileDiff(big, f);
    expect(r.truncated).toBe(true);
    expect(r.lines.length).toBe(20000);
  });
});

describe('DiffViewer', () => {
  const k = (s: string) => new KeyParser().feed(s)[0];
  const tag = { add: (s: string) => `<+>${s}`, del: (s: string) => `<->${s}`, hunk: (s: string) => `<@>${s}`, head: (s: string) => `<h>${s}`, dim: (s: string) => `<d>${s}`, accent: (s: string) => `<a>${s}` };
  const F = (section: ChangedFile['section'], status: string, p: string, extra: Partial<ChangedFile> = {}): ChangedFile => ({ section, status, path: p, added: 1, removed: 0, binary: false, ...extra });
  const files = [F('staged', 'A', 'a.ts'), F('unstaged', 'M', 'b.ts', { added: 3, removed: 2 }), F('unstaged', 'D', 'c.ts', { added: 0, removed: 4 }), F('untracked', '?', 'd.md')];

  it('file list: sections, stats, selection, wrap-around, Enter opens, Esc closes', () => {
    const v = new DiffViewer(files);
    const rows = v.rows(60, 20, tag);
    expect(rows[0]).toContain('Changes · 4 files · +5 −6 · read-only');
    expect(rows).toContain('<d>  Staged');
    expect(rows).toContain('<d>  Untracked');
    expect(rows.find((r) => r.includes('b.ts'))).toMatch(/M b\.ts\s+\+3 −2$/);
    expect(rows.find((r) => r.includes('c.ts'))!.startsWith('<->')).toBe(true);
    v.handle(k('\x1b[A'), 10);
    expect(v.index).toBe(3); // wrapped to the last file
    expect(v.handle(k('\r'), 10)).toEqual({ type: 'open', file: files[3] });
    expect(v.handle(k('\x1b'), 10)).toEqual({ type: 'close' });
  });
  it('file view: colours, PageUp/PageDown scrolling, Esc back to the list', () => {
    const v = new DiffViewer(files);
    v.showDiff(files[1], ['diff --git a/b.ts b/b.ts', '@@ -1,3 +1,3 @@', ' ctx', '-old', '+new', ...Array.from({ length: 40 }, (_, i) => ` line ${i}`)], false);
    let rows = v.rows(60, 10, tag);
    expect(rows[0]).toMatch(/M b\.ts · unstaged · \+3 −2 · 1–9\/45/);
    expect(rows.slice(1, 6)).toEqual(['<d>diff --git a/b.ts b/b.ts', '<@>@@ -1,3 +1,3 @@', ' ctx', '<->-old', '<+>+new']);
    v.handle(k('\x1b[6~'), 9);
    expect(v.top).toBe(8);
    v.handle(k('\x1b[6~'), 9); v.handle(k('\x1b[6~'), 9); v.handle(k('\x1b[6~'), 9); v.handle(k('\x1b[6~'), 9); v.handle(k('\x1b[6~'), 9);
    expect(v.top).toBe(36); // never past the end
    v.handle(k('\x1b[5~'), 9);
    expect(v.top).toBe(28);
    v.handle(k('\x1b'), 9);
    expect(v.file).toBeUndefined();
    rows = v.rows(60, 10, tag);
    expect(rows[0]).toContain('Changes');
  });
  it('empty, binary and narrow cases', () => {
    expect(new DiffViewer([]).rows(40, 10, tag)[1]).toContain('No changes');
    const v = new DiffViewer(files);
    v.showDiff(F('unstaged', 'M', 'img.png', { binary: true, added: null, removed: null }), [], false);
    expect(v.rows(40, 10, tag)[1]).toContain('Binary file');
    const n = new DiffViewer([F('unstaged', 'M', 'src/very/long/path/to/some/deeply/nested/component/file.tsx')]);
    for (const r of n.rows(30, 10, tag)) expect(r.replace(/<.>/g, '').length).toBeLessThanOrEqual(30);
  });
});
