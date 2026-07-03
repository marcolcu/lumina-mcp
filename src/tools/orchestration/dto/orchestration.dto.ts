import { z } from 'zod';

export const OrchestrationPromptSchema = {
  command: z.string().optional().describe('General instructions or context for the orchestration'),
  tokenBudget: z
    .enum(['save-tokens', 'full-detail'])
    .optional()
    .default('full-detail')
    .describe('Token usage mode for the orchestration workflow.'),
};

export const GetOrchestrationPhaseSchema = {
  phase: z.number().min(1).max(6).describe('The phase number to get instructions for'),
  includeTest: z.boolean().describe('Whether tests are included in this orchestration'),
  tokenBudget: z
    .enum(['save-tokens', 'full-detail'])
    .optional()
    .default('full-detail')
    .describe(
      'Token usage mode. "save-tokens" = save tokens (concise, bullet-points, no code echo). "full-detail" = complete explanation as usual.',
    ),
  previousPhaseSummary: z
    .string()
    .optional()
    .describe(
      'Brief summary of the previous phase (≤150 words). Used to carry forward context without bringing the entire raw output.',
    ),
};
