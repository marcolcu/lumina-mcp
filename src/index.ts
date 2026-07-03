import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerMysqlController } from './tools/database/mysql/index.js';
import { registerPostgresqlController } from './tools/database/postgresql/index.js';
import { registerGithubController } from './tools/gitsystem/index.js';
import { registerGiteaController } from './tools/gitsystem/gitea/index.js';
import { registerProjectManagementController } from './tools/projectmanagement/index.js';
import { registerOrchestrationController } from './tools/orchestration/index.js';
import { registerTestingController } from './tools/testing/index.js';
import { applyPromptArgsPatch } from './utils/prompt-args.utils.js';

export const server = new McpServer({
  name: 'lumina-mcp',
  version: '1.0.0',
});

// Register feature controllers (tools + prompts)
registerMysqlController(server);
registerPostgresqlController(server);
registerGithubController(server);
registerGiteaController(server);
registerProjectManagementController(server);
registerOrchestrationController(server);
registerTestingController(server);

applyPromptArgsPatch(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Lumina MCP Database Server started running on Stdio transport');
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err: unknown) => {
    console.error('Fatal error starting lumina-mcp-db:', err);
    process.exit(1);
  });
}
