import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMysqlController } from '../../tools/database/mysql/index.js';
import { registerPostgresqlController } from '../../tools/database/postgresql/index.js';
import { registerGithubController } from '../../tools/gitsystem/index.js';
import { registerGiteaController } from '../../tools/gitsystem/gitea/index.js';
import { registerProjectManagementController } from '../../tools/projectmanagement/index.js';
import { registerOrchestrationController } from '../../tools/orchestration/index.js';
import { registerTestingController } from '../../tools/testing/index.js';
import { applyPromptArgsPatch } from '../../utils/prompt-args.utils.js';

export const LUMINA_MCP_NAME = 'lumina-mcp';
export const LUMINA_MCP_VERSION = '1.3.2';

export function createLuminaMcpServer(): McpServer {
  const server = new McpServer({
    name: LUMINA_MCP_NAME,
    version: LUMINA_MCP_VERSION,
  });

  registerMysqlController(server);
  registerPostgresqlController(server);
  registerGithubController(server);
  registerGiteaController(server);
  registerProjectManagementController(server);
  registerOrchestrationController(server);
  registerTestingController(server);
  applyPromptArgsPatch(server);

  return server;
}
