import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { startStdioMcpServer } from '../../src/lumina/mcp/transports/stdio.transport.js';

describe('stdio MCP transport lifecycle', () => {
  it('closes the MCP transport and resources when the client ends stdin', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const closeTransport = vi.fn(async () => {});
    const closeResources = vi.fn(async () => {});
    const fakeServer = {
      connect: async (transport: { start(): Promise<void> }) => transport.start(),
      close: closeTransport,
    };
    const handle = await startStdioMcpServer(
      fakeServer as never,
      closeResources,
      input,
      output,
    );

    input.end();
    await vi.waitFor(() => expect(closeResources).toHaveBeenCalledOnce());
    expect(closeTransport).toHaveBeenCalledOnce();
    await handle.close();
    expect(closeResources).toHaveBeenCalledOnce();
    input.destroy();
    output.destroy();
  });

  it('allows repeated initialization and cleanup without accumulating input listeners', async () => {
    for (let i = 0; i < 3; i += 1) {
      const input = new PassThrough();
      const output = new PassThrough();
      const closeResources = vi.fn(async () => {});
      const fakeServer = {
        connect: async (transport: { start(): Promise<void> }) => transport.start(),
        close: vi.fn(async () => {}),
      };
      const handle = await startStdioMcpServer(fakeServer as never, closeResources, input, output);

      expect(input.listenerCount('end')).toBe(1);
      await handle.close();
      expect(input.listenerCount('end')).toBe(0);
      expect(closeResources).toHaveBeenCalledOnce();
      input.destroy();
      output.destroy();
    }
  });
});
