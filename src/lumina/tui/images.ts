import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i;
const MAX_BYTES = 20 * 1024 * 1024;

const run = (cmd: string, args: string[], opts: { stdoutFile?: string } = {}) => new Promise<boolean>((resolve) => {
  const child = execFile(cmd, args, { encoding: 'buffer', maxBuffer: MAX_BYTES + 1024, timeout: 10000 }, (err, stdout) => {
    if (err) return resolve(false);
    if (opts.stdoutFile) { if (!stdout?.length) return resolve(false); fs.writeFileSync(opts.stdoutFile, stdout); }
    resolve(true);
  });
  child.on('error', () => resolve(false));
});

/** Where pasted images are kept for the session (outside the project). */
export const imageDir = (): string => path.join(os.tmpdir(), 'lumina-images');

/**
 * Saves the image currently on the system clipboard as a PNG and returns its path, or undefined when the clipboard
 * holds no image. macOS: osascript (no extra tools); Linux: wl-paste or xclip. No shell is involved.
 */
export async function readClipboardImage(dir = imageDir()): Promise<string | undefined> {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `clipboard-${randomUUID().slice(0, 8)}.png`);
  let ok = false;
  if (process.platform === 'darwin') {
    ok = await run('osascript', [
      '-e', 'try', '-e', 'set img to the clipboard as «class PNGf»', '-e', 'on error', '-e', 'error "no image"', '-e', 'end try',
      '-e', `set fh to open for access (POSIX file ${JSON.stringify(file)}) with write permission`,
      '-e', 'set eof fh to 0', '-e', 'write img to fh', '-e', 'close access fh',
    ]);
  } else if (process.platform === 'linux') {
    ok = await run('wl-paste', ['--type', 'image/png'], { stdoutFile: file }) || await run('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], { stdoutFile: file });
  }
  try {
    const size = fs.statSync(file).size;
    if (ok && size > 0 && size <= MAX_BYTES) return file;
  } catch { /* not written */ }
  fs.rmSync(file, { force: true });
  return undefined;
}

/**
 * A paste that is just the path of an image file (dragging a file into the terminal, or Cmd+V of a copied file)
 * → the absolute path; anything else → undefined. Handles quotes, `\ ` escapes and file:// URLs.
 */
export function imagePathFromPaste(text: string, cwd: string): string | undefined {
  let t = text.trim();
  if (!t || t.includes('\n')) return undefined;
  if (/^(['"]).*\1$/.test(t)) t = t.slice(1, -1);
  if (t.startsWith('file://')) { try { t = decodeURIComponent(new URL(t).pathname); } catch { return undefined; } }
  t = t.replace(/\\ /g, ' ');
  if (t.startsWith('~/')) t = path.join(os.homedir(), t.slice(2));
  if (!IMAGE_EXT.test(t)) return undefined;
  const abs = path.resolve(cwd, t);
  try {
    const st = fs.statSync(abs);
    return st.isFile() && st.size > 0 && st.size <= MAX_BYTES ? abs : undefined;
  } catch { return undefined; }
}
