import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Readable, Writable } from 'node:stream';

export interface StdioMcpServerHandle {
  close(): Promise<void>;
}

export async function startStdioMcpServer(
  server: McpServer,
  onClose: () => Promise<void> = async () => {},
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<StdioMcpServerHandle> {
  const transport = new StdioServerTransport(input, output);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      input.off('end', handleDisconnect);
      input.off('close', handleDisconnect);
      await server.close();
      await onClose();
    })();
    return closing;
  };
  const handleDisconnect = () => {
    void close().catch((error: unknown) => console.error('Failed to close Lumina MCP:', error));
  };

  input.once('end', handleDisconnect);
  input.once('close', handleDisconnect);
  try {
    await server.connect(transport);
  } catch (error) {
    input.off('end', handleDisconnect);
    input.off('close', handleDisconnect);
    throw error;
  }
  return { close };
}
