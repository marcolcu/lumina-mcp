import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  GetOrchestrationPhaseSchema,
  OrchestrationPromptSchema,
} from '../dto/orchestration.dto.js';
import { OrchestrationService } from '../service/orchestration.service.js';

export function registerOrchestrationController(server: McpServer) {
  const orchestrationService = new OrchestrationService();

  // Tools
  server.registerTool(
    'get_orchestration_phase',
    {
      description: 'Get instructions for a specific orchestration phase (1-6).',
      inputSchema: GetOrchestrationPhaseSchema,
    },
    async ({ phase, includeTest, tokenBudget, previousPhaseSummary }) => {
      const { instructions, error } = orchestrationService.getOrchestrationPhase(
        phase,
        includeTest,
        tokenBudget,
        previousPhaseSummary,
      );

      if (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error }],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: instructions!,
          },
        ],
      };
    },
  );

  // Prompts
  server.registerPrompt(
    'lumina_orchestrate',
    {
      title: 'Senior SWE End-to-End Orchestration',
      description:
        'Run an end-to-end AI workflow across 5 or 6 phases depending on test inclusion, like a Senior Software Engineer.',
      argsSchema: OrchestrationPromptSchema,
    },
    async ({ command, tokenBudget }) => {
      const promptText = orchestrationService.getOrchestrationPrompt(command, tokenBudget);

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: promptText,
            },
          },
        ],
      };
    },
  );
}
