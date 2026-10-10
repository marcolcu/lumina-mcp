import { spawn } from 'node:child_process';

const run = (cmd: string, args: string[], text: string) => new Promise<boolean>((resolve) => {
  try {
    const p = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
    p.stdin?.on('error', () => undefined);
    p.stdin?.end(text);
  } catch { resolve(false); }
});

/**
 * Copies text to the system clipboard (pbcopy / wl-copy / xclip / clip; argv only, no shell). Falls back to the
 * terminal's OSC 52 clipboard sequence, which works in iTerm2, kitty, WezTerm, Ghostty and over SSH.
 * Returns how it was copied.
 */
export async function copyToClipboard(text: string, out: NodeJS.WritableStream): Promise<string> {
  const tools: [string, string[]][] = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tools) if (await run(cmd, args, text)) return 'clipboard';
  out.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
  return 'terminal clipboard (OSC 52)';
}
