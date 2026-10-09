import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerMysqlController } from '../../tools/database/mysql/index.js';
import { registerPostgresqlController } from '../../tools/database/postgresql/index.js';
import { registerGithubController } from '../../tools/gitsystem/index.js';
import { registerGiteaController } from '../../tools/gitsystem/gitea/index.js';
import { registerProjectManagementController } from '../../tools/projectmanagement/index.js';
import { registerOrchestrationController } from '../../tools/orchestration/index.js';
import { registerTestingController } from '../../tools/testing/index.js';
import { applyPromptArgsPatch } from '../../utils/prompt-args.utils.js';
import { registerRagController } from '../../tools/rag/controller/rag.controller.js';
import { registerRouterController } from '../../tools/router/controller/router.controller.js';
import { getRuntimeStats, trackRequest } from './runtime-observability.js';

export const LUMINA_MCP_NAME = 'lumina-mcp';
export const LUMINA_MCP_VERSION = '1.3.2';

export function createLuminaMcpServer(): McpServer {
  const server = new McpServer({
    name: LUMINA_MCP_NAME,
    version: LUMINA_MCP_VERSION,
  });

  const registerTool = server.registerTool.bind(server);
  const registerInstrumentedTool = registerTool as unknown as (
    name: string,
    config: object,
    handler: (...args: never[]) => unknown,
  ) => unknown;
  server.registerTool = ((name, config, handler) =>
    registerInstrumentedTool(name, config, trackRequest(handler))) as typeof server.registerTool;

  registerMysqlController(server);
  registerPostgresqlController(server);
  registerGithubController(server);
  registerGiteaController(server);
  registerProjectManagementController(server);
  registerOrchestrationController(server);
  registerTestingController(server);
  registerRagController(server);
  registerRouterController(server);
  server.registerTool('lumina_memory_stats', {
    description: 'Use when diagnosing server memory or lifecycle; reports process memory, uptime, active requests, and database pool cache statistics.',
    inputSchema: {},
  }, async () => ({ content: [{ type: 'text', text: JSON.stringify(getRuntimeStats()) }] }));
  applyPromptArgsPatch(server);

  return server;
}
