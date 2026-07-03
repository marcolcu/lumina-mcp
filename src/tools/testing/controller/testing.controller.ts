import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TestingPromptSchema } from '../dto/testing.dto.js';
import {
  CREATE_E2E_TEST_PROMPT,
  CREATE_INTEGRATION_TEST_PROMPT,
  CREATE_UNIT_TEST_PROMPT,
} from '../prompts/index.js';

export function registerTestingController(server: McpServer) {
  // Prompts
  server.registerPrompt(
    'create-unit-test',
    {
      title: 'Senior SDET Create Unit Test',
      description:
        'Generate high-quality unit tests covering happy path, negative path, and edge cases with >80% coverage for any programming language.',
      argsSchema: TestingPromptSchema,
    },
    async ({ command }) => {
      const promptText = CREATE_UNIT_TEST_PROMPT.replace(
        '{{context}}',
        () => command ?? 'Please paste the source code you want to test here.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'create-e2e-test',
    {
      title: 'Senior SDET Create E2E Test',
      description:
        'Generate high-quality e2e tests covering happy path user journeys, negative path flows, edge cases, and UI stability for any programming language.',
      argsSchema: TestingPromptSchema,
    },
    async ({ command }) => {
      const promptText = CREATE_E2E_TEST_PROMPT.replace(
        '{{context}}',
        () => command ?? 'Please paste the source code you want to test here.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'create-integration-test',
    {
      title: 'Senior SDET Create Integration Test',
      description:
        'Generate production-grade API integration tests covering happy path, negative path, auth, edge cases, and data integrity — with environment setup for local and CI/CD execution.',
      argsSchema: TestingPromptSchema,
    },
    async ({ command }) => {
      const promptText = CREATE_INTEGRATION_TEST_PROMPT.replace(
        '{{context}}',
        () => command ?? 'Please paste the API endpoint definitions or controller source code you want to test here.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );
}
