import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerProjectManagementController } from '../../../src/tools/projectmanagement/controller/projectmanagement.controller.js';

describe('Project Management Controller', () => {
  let mockServer: {
    registerTool: ReturnType<typeof vi.fn>;
    registerPrompt: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockServer = {
      registerTool: vi.fn(),
      registerPrompt: vi.fn(),
    };
  });

  it('should register project management tools and prompts', () => {
    registerProjectManagementController(mockServer as unknown as McpServer);

    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'get_jira_ticket_comments',
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'get_openproject_work_package_comments',
      expect.any(Object),
      expect.any(Function),
    );

    expect(mockServer.registerPrompt).toHaveBeenCalledWith(
      'dev_check_comment',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('should execute dev_check_comment prompt handler correctly', async () => {
    registerProjectManagementController(mockServer as unknown as McpServer);

    const devCheckCall = mockServer.registerPrompt.mock.calls.find(
      (call) => call[0] === 'dev_check_comment',
    );
    expect(devCheckCall).toBeDefined();

    const handler = devCheckCall![2];
    const result = await handler({ command: 'PRJ-100' });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.text).toContain('PRJ-100');
    expect(result.messages[0].content.text).toContain('get_jira_ticket_comments');
  });
});
