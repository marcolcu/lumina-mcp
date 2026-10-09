import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { loadConfig, TIERS } from '../../../smart-codex/config.js';
import { explain, route } from '../../../smart-codex/router.js';
import { stats } from '../../../smart-codex/run.js';

const RouteSchema = {
  task: z.string().min(1).max(20000),
  repository: z.string().optional(),
  context: z.string().max(20000).optional(),
  preferences: z.object({ model: z.string().optional(), reasoning: z.string().optional(), tier: z.enum(TIERS).optional() }).optional(),
};
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export function registerRouterController(server: McpServer): void {
  server.registerTool('route_task', {
    description: 'Use before starting a coding task to pick Codex model, reasoning effort, and relevant files locally (no LLM call). Returns compact JSON.',
    inputSchema: RouteSchema,
  }, async (a) => text(JSON.stringify(route(a, loadConfig(a.repository)))));

  server.registerTool('explain_route', {
    description: 'Use when you need to explain a local routing decision in plain text (no LLM call).',
    inputSchema: RouteSchema,
  }, async (a) => text(explain(route(a, loadConfig(a.repository)))));

  server.registerTool('get_router_config', {
    description: 'Use when you need the active smart-codex routing configuration.',
    inputSchema: {},
  }, async () => text(JSON.stringify(loadConfig())));

  server.registerTool('get_router_stats', {
    description: 'Use when you need historical smart-codex routing statistics from local analytics.',
    inputSchema: {},
  }, async () => text(JSON.stringify(stats())));
}
