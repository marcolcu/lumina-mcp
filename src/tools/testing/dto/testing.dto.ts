import { z } from 'zod';

export const TestingPromptSchema = {
  command: z
    .string()
    .optional()
    .describe('Additional instructions, context, or code to generate unit tests for'),
};
