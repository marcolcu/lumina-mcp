import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type Section = 'staged' | 'unstaged' | 'untracked';
export interface ChangedFile {
  section: Section;
  /** M modified · A added · D deleted · R renamed · C copied · T type change · ? untracked */
  status: string;
  path: string;
  origPath?: string;
  added: number | null; // null = binary or unknown
  removed: number | null;
  binary: boolean;
}

const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_LINES = 20000;

/** Runs git read-only (argv only, no shell). Exit code 1 is accepted for `diff --no-index`, which uses it for "differs". */
function git(cwd: string, args: string[], okCodes = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=off', '--no-pager', ...args], { cwd, maxBuffer: MAX_DIFF_BYTES, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code;
      if (err && !(typeof code === 'number' && okCodes.includes(code))) {
        if ((err as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('diff too large to display'));
        return reject(new Error((stderr || err.message).split('\n')[0].replace(/^fatal:\s*/, '')));
      }
      resolve(stdout);
    });
  });
}

function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const map = new Map<string, { added: number | null; removed: number | null }>();
  const f = out.split('\0');
  for (let i = 0; i < f.length; i++) {
    if (!f[i]) continue;
    const [a, d, p] = f[i].split('\t');
    let file = p;
    if (p === '' || p === undefined) { file = f[i + 2]; i += 2; } // rename: "a\td\t\0old\0new"
    map.set(file, { added: a === '-' ? null : Number(a), removed: d === '-' ? null : Number(d) });
  }
  return map;
}

function untrackedStats(cwd: string, file: string): { added: number | null; binary: boolean } {
  try {
    const full = path.join(cwd, file);
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return { added: null, binary: false };
    const buf = fs.readFileSync(full);
    if (buf.subarray(0, 8000).includes(0)) return { added: null, binary: true };
    const s = buf.toString('utf8');
    return { added: s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0, binary: false };
  } catch { return { added: null, binary: false }; }
}

/** Working-tree changes grouped as staged, unstaged and untracked. Read-only. */
export async function listChanges(cwd: string): Promise<ChangedFile[]> {
  // status first: outside a repository it fails with git's clear "not a git repository" message
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const [unstaged, staged] = await Promise.all([
    git(cwd, ['diff', '--numstat', '-z', '-M']),
    git(cwd, ['diff', '--cached', '--numstat', '-z', '-M']),
  ]);
  const un = parseNumstat(unstaged);
  const st = parseNumstat(staged);
  const files: ChangedFile[] = [];
  const f = status.split('\0');
  for (let i = 0; i < f.length; i++) {
    const e = f[i];
    if (e.length < 4) continue;
    const x = e[0], y = e[1], p = e.slice(3);
    let orig: string | undefined;
    if (x === 'R' || x === 'C') orig = f[++i];
    if (x === '?' && y === '?') { const u = untrackedStats(cwd, p); files.push({ section: 'untracked', status: '?', path: p, added: u.added, removed: 0, binary: u.binary }); continue; }
    if (x !== ' ' && x !== '!') { const n = st.get(p); files.push({ section: 'staged', status: x, path: p, origPath: orig, added: n?.added ?? null, removed: n?.removed ?? null, binary: Boolean(n && n.added === null) }); }
    if (y !== ' ' && y !== '!') { const n = un.get(p); files.push({ section: 'unstaged', status: y, path: p, added: n?.added ?? null, removed: n?.removed ?? null, binary: Boolean(n && n.added === null) }); }
  }
  const order: Record<Section, number> = { staged: 0, unstaged: 1, untracked: 2 };
  return files.sort((a, b) => order[a.section] - order[b.section] || a.path.localeCompare(b.path));
}

/** Diff text of one file (on demand, size-capped). Untracked files are compared with /dev/null. */
export async function fileDiff(cwd: string, file: ChangedFile): Promise<{ lines: string[]; truncated: boolean }> {
  let out: string;
  if (file.section === 'untracked') out = await git(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', file.path], [0, 1]);
  else out = await git(cwd, ['diff', '--no-color', '-M', ...(file.section === 'staged' ? ['--cached'] : []), '--', ...(file.origPath ? [file.origPath] : []), file.path]);
  const lines = out.replace(/\n$/, '').split('\n');
  return lines.length > MAX_DIFF_LINES ? { lines: lines.slice(0, MAX_DIFF_LINES), truncated: true } : { lines: out ? lines : [], truncated: false };
}
