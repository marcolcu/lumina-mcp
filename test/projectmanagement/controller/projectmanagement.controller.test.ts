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
    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'add_jira_comment',
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'add_openproject_work_package_comment',
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'add_trello_comment',
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'add_trello_attachment',
      expect.any(Object),
      expect.any(Function),
    );
    expect(mockServer.registerTool).toHaveBeenCalledWith(
      'add_github_issue_comment',
      expect.any(Object),
      expect.any(Function),
    );

    expect(mockServer.registerPrompt).toHaveBeenCalledWith(
      'pm_testing_ticket',
      expect.any(Object),
      expect.any(Function),
    );

    expect(mockServer.registerPrompt).toHaveBeenCalledWith(
      'dev_check_comment',
      expect.any(Object),
      expect.any(Function),
    );
  });

  it('should execute pm_testing_ticket prompt handler correctly', async () => {
    registerProjectManagementController(mockServer as unknown as McpServer);

    const testingTicketCall = mockServer.registerPrompt.mock.calls.find(
      (call) => call[0] === 'pm_testing_ticket',
    );
    expect(testingTicketCall).toBeDefined();

    const handler = testingTicketCall![2];
    const result = await handler({
      command:
        'ticket_url=https://github.com/owner/repo/issues/25 website_url=https://staging.example.com',
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.text).toContain(
      'ticket_url=https://github.com/owner/repo/issues/25',
    );
    expect(result.messages[0].content.text).toContain('add_github_issue_comment');
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
