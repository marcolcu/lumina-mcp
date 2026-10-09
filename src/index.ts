import { createLuminaMcpServer } from './lumina/mcp/mcp_server.js';
import { runManagementCommand } from './lumina/cli/cli.js';
import { parseServeOptions } from './lumina/mcp/serve-options.js';
import { startHttpMcpServer } from './lumina/mcp/transports/http.transport.js';
import { startStdioMcpServer } from './lumina/mcp/transports/stdio.transport.js';
import { closeDatabasePools } from './lumina/mcp/lifecycle.js';

export const server = createLuminaMcpServer();

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (await runManagementCommand(args)) {
    return;
  }

  const options = parseServeOptions(args, process.env);

  if (options.transport === 'http') {
    const httpServer = await startHttpMcpServer(options);
    registerShutdown(async () => {
      await httpServer.close();
      await closeDatabasePools();
    });
    console.error(`Lumina MCP listening on http://${options.host}:${options.port}/mcp`);
    return;
  }

  const stdioServer = await startStdioMcpServer(server, closeDatabasePools);
  registerShutdown(() => stdioServer.close());
  console.error('Lumina MCP running on stdio transport');
}

function registerShutdown(close: () => Promise<void>): void {
  let closing: Promise<void> | undefined;
  const handleSignal = (signal: NodeJS.Signals) => {
    closing ??= close().catch((error: unknown) => {
      console.error('Error during Lumina MCP shutdown:', error);
      process.exitCode = 1;
    });
    void closing.then(() => {
      if (!process.exitCode) process.exitCode = signal === 'SIGINT' ? 130 : 143;
    });
  };
  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err: unknown) => {
    console.error('Fatal error starting lumina-mcp:', err);
    process.exit(1);
  });
}
