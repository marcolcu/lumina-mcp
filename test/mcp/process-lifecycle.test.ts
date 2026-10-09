import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('MCP process lifecycle', () => {
  it('closes transports and database resources on SIGTERM', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    const started = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${stderr}`)), 5000);
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes('Lumina MCP running on stdio transport')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.once('exit', (code) => {
        clearTimeout(timeout);
        reject(new Error(`Server exited before startup (${code}): ${stderr}`));
      });
    });
    await started;

    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
  }, 10000);
});
