import { createLuminaMcpServer } from './lumina/mcp/mcp_server.js';
import { runManagementCommand } from './lumina/cli/cli.js';
import { parseServeOptions } from './lumina/mcp/serve-options.js';
import { startHttpMcpServer } from './lumina/mcp/transports/http.transport.js';
import { startStdioMcpServer } from './lumina/mcp/transports/stdio.transport.js';

export const server = createLuminaMcpServer();

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (await runManagementCommand(args)) {
    return;
  }

  const options = parseServeOptions(args, process.env);

  if (options.transport === 'http') {
    await startHttpMcpServer(options);
    console.error(`Lumina MCP listening on http://${options.host}:${options.port}/mcp`);
    return;
  }

  await startStdioMcpServer(server);
  console.error('Lumina MCP running on stdio transport');
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err: unknown) => {
    console.error('Fatal error starting lumina-mcp:', err);
    process.exit(1);
  });
}
