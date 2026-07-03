import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTestingController } from '../../../src/tools/testing/controller/testing.controller.js';
import {
  CREATE_UNIT_TEST_PROMPT,
  CREATE_E2E_TEST_PROMPT,
  CREATE_INTEGRATION_TEST_PROMPT,
} from '../../../src/tools/testing/prompts/index.js';

describe('Testing Controller', () => {
  let mockServer: {
    registerPrompt: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockServer = {
      registerPrompt: vi.fn(),
    };
  });

  it('should register create-unit-test prompt', () => {
    registerTestingController(mockServer as unknown as McpServer);

    expect(mockServer.registerPrompt).toHaveBeenCalledWith(
      'create-unit-test',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('should register create-e2e-test prompt', () => {
    registerTestingController(mockServer as unknown as McpServer);

    expect(mockServer.registerPrompt).toHaveBeenCalledWith(
      'create-e2e-test',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('should register create-integration-test prompt', () => {
    registerTestingController(mockServer as unknown as McpServer);

    expect(mockServer.registerPrompt).toHaveBeenCalledWith(
      'create-integration-test',
      expect.any(Object),
      expect.any(Function),
    );
  });

  describe('create-unit-test prompt', () => {
    let createUnitTestCallback: (args: {
      command?: string;
    }) => Promise<{ messages: { role: string; content: { text: string } }[] }>;

    beforeEach(() => {
      registerTestingController(mockServer as unknown as McpServer);
      createUnitTestCallback = mockServer.registerPrompt.mock.calls[0][2];
    });

    it('should replace {{context}} with the provided command', async () => {
      const commandText = 'function sum(a, b) { return a + b; }';
      const result = await createUnitTestCallback({ command: commandText });
      const expectedText = CREATE_UNIT_TEST_PROMPT.replace('{{context}}', () => commandText);

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toBe(expectedText);
    });

    it('should handle undefined command gracefully', async () => {
      const result = await createUnitTestCallback({});
      const expectedText = CREATE_UNIT_TEST_PROMPT.replace(
        '{{context}}',
        () => 'Please paste the source code you want to test here.',
      );

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toBe(expectedText);
    });
  });

  describe('create-e2e-test prompt', () => {
    let createE2ETestCallback: (args: {
      command?: string;
    }) => Promise<{ messages: { role: string; content: { text: string } }[] }>;

    beforeEach(() => {
      registerTestingController(mockServer as unknown as McpServer);
      createE2ETestCallback = mockServer.registerPrompt.mock.calls[1][2];
    });

    it('should replace {{context}} with the provided command', async () => {
      const commandText = 'describe("E2E", () => {})';
      const result = await createE2ETestCallback({ command: commandText });
      const expectedText = CREATE_E2E_TEST_PROMPT.replace('{{context}}', () => commandText);

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toBe(expectedText);
    });

    it('should handle undefined command gracefully', async () => {
      const result = await createE2ETestCallback({});
      const expectedText = CREATE_E2E_TEST_PROMPT.replace(
        '{{context}}',
        () => 'Please paste the source code you want to test here.',
      );

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toBe(expectedText);
    });
  });

  describe('create-integration-test prompt', () => {
    let createIntegrationTestCallback: (args: {
      command?: string;
    }) => Promise<{ messages: { role: string; content: { text: string } }[] }>;

    beforeEach(() => {
      registerTestingController(mockServer as unknown as McpServer);
      // integration-test is the 3rd registered prompt (index 2)
      createIntegrationTestCallback = mockServer.registerPrompt.mock.calls[2][2];
    });

    it('should replace {{context}} with the provided command', async () => {
      const commandText = 'POST /api/users - Create a new user with name and email';
      const result = await createIntegrationTestCallback({ command: commandText });
      const expectedText = CREATE_INTEGRATION_TEST_PROMPT.replace(
        '{{context}}',
        () => commandText,
      );

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toBe(expectedText);
    });

    it('should handle undefined command gracefully', async () => {
      const result = await createIntegrationTestCallback({});
      const expectedText = CREATE_INTEGRATION_TEST_PROMPT.replace(
        '{{context}}',
        () =>
          'Please paste the API endpoint definitions or controller source code you want to test here.',
      );

      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.text).toBe(expectedText);
    });
  });
});
