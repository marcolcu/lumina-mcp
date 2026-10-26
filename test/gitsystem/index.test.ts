import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ServerWithHandlers {
  _requestHandlers: Map<
    string,
    (request: { method: string; params?: unknown }) => Promise<unknown>
  >;
}

const {
  mockGenerateAndPushCommit,
  mockCreatePullRequest,
  mockCreateCodeReview,
  mockGetPRReviewComments,
  mockGetLocalGitChanges,
} = vi.hoisted(() => ({
  mockGenerateAndPushCommit: vi.fn(),
  mockCreatePullRequest: vi.fn(),
  mockCreateCodeReview: vi.fn(),
  mockGetPRReviewComments: vi.fn(),
  mockGetLocalGitChanges: vi.fn(),
}));

vi.mock('../../src/tools/gitsystem/github/service/github.service.js', () => ({
  generateAndPushCommit: (branch: string, msg: string, files: string[], diff?: string) =>
    mockGenerateAndPushCommit(branch, msg, files, diff),
  createPullRequest: (repo: string, title: string, head: string, base: string, body: string) =>
    mockCreatePullRequest(repo, title, head, base, body),
  createCodeReview: (
    repo: string,
    prNumber: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body: string,
    comments?: Array<{
      path: string;
      position?: number;
      line?: number;
      side?: 'LEFT' | 'RIGHT';
      body: string;
    }>,
  ) => mockCreateCodeReview(repo, prNumber, event, body, comments),
  getPRReviewComments: (repo: string, prNumber: number) => mockGetPRReviewComments(repo, prNumber),
  getLocalGitChanges: () => mockGetLocalGitChanges(),
}));

// Mock database services to prevent actual calls/connections during imports
vi.mock('../../src/tools/database/mysql/service/mysql.service.js', () => ({
  runMySQLQuery: vi.fn(),
}));

vi.mock('../../src/tools/database/postgresql/service/postgresql.service.js', () => ({
  runPostgresQuery: vi.fn(),
}));

// Set NODE_ENV to test to prevent main() auto-run, then import server
process.env.NODE_ENV = 'test';
import { server } from '../../src/index.js';

describe('Git System MCP Tools and Prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Tools', () => {
    it('should list all registered gitsystem tools', async () => {
      const listHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'tools/list',
      );
      expect(listHandler).toBeDefined();

      const response = (await listHandler!({ method: 'tools/list' })) as { tools: unknown[] };
      expect(response.tools).toBeDefined();
      expect(response.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'generate_commit_and_push' }),
          expect.objectContaining({ name: 'create_github_pr' }),
          expect.objectContaining({ name: 'review_github_pr' }),
          expect.objectContaining({ name: 'fix_github_pr_review' }),
        ]),
      );
    });

    it('should call generate_commit_and_push tool correctly', async () => {
      mockGenerateAndPushCommit.mockResolvedValueOnce({
        success: true,
        stdout: 'Pushed',
        stderr: '',
      });
      const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'tools/call',
      );

      const response = (await callHandler!({
        method: 'tools/call',
        params: {
          name: 'generate_commit_and_push',
          arguments: {
            repository: 'owner/repo',
            branch: 'main',
            files: ['src/file.ts'],
            diff: 'feat: changes',
          },
        },
      })) as { content: Array<{ type: string; text: string }> };

      expect(mockGenerateAndPushCommit).toHaveBeenCalledWith(
        'main',
        'feat: changes',
        ['src/file.ts'],
        'feat: changes',
      );
      expect(response).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, stdout: 'Pushed', stderr: '' }, null, 2),
          },
        ],
      });
    });

    it('should call generate_commit_and_push tool correctly with commitMessage', async () => {
      mockGenerateAndPushCommit.mockResolvedValueOnce({
        success: true,
        stdout: 'Pushed with commitMessage',
        stderr: '',
      });
      const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'tools/call',
      );

      const response = (await callHandler!({
        method: 'tools/call',
        params: {
          name: 'generate_commit_and_push',
          arguments: {
            repository: 'owner/repo',
            branch: 'main',
            files: ['src/file.ts'],
            commitMessage: 'feat: new message',
            diff: 'diff-content',
          },
        },
      })) as { content: Array<{ type: string; text: string }> };

      expect(mockGenerateAndPushCommit).toHaveBeenCalledWith(
        'main',
        'feat: new message',
        ['src/file.ts'],
        'diff-content',
      );
      expect(response).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { success: true, stdout: 'Pushed with commitMessage', stderr: '' },
              null,
              2,
            ),
          },
        ],
      });
    });

    it('should call create_github_pr tool correctly', async () => {
      mockCreatePullRequest.mockResolvedValueOnce({
        html_url: 'https://github.com/pr/1',
        state: 'open',
      });
      const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'tools/call',
      );

      const response = (await callHandler!({
        method: 'tools/call',
        params: {
          name: 'create_github_pr',
          arguments: {
            repository: 'owner/repo',
            title: 'feat: add stuff',
            head: 'feature',
            base: 'main',
            body: 'PR body description',
          },
        },
      })) as { content: Array<{ type: string; text: string }> };

      expect(mockCreatePullRequest).toHaveBeenCalledWith(
        'owner/repo',
        'feat: add stuff',
        'feature',
        'main',
        'PR body description',
      );
      expect(response).toEqual({
        content: [
          {
            type: 'text',
            text: 'Successfully created PR: https://github.com/pr/1\nState: open',
          },
        ],
      });
    });

    it('should call review_github_pr tool correctly', async () => {
      mockCreateCodeReview.mockResolvedValueOnce({
        html_url: 'https://github.com/review/1',
        state: 'APPROVED',
      });
      const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'tools/call',
      );

      const response = (await callHandler!({
        method: 'tools/call',
        params: {
          name: 'review_github_pr',
          arguments: {
            repository: 'owner/repo',
            pullRequestNumber: 42,
            event: 'APPROVE',
            body: 'Good job!',
          },
        },
      })) as { content: Array<{ type: string; text: string }> };

      expect(mockCreateCodeReview).toHaveBeenCalledWith(
        'owner/repo',
        42,
        'APPROVE',
        'Good job!',
        undefined,
      );
      expect(response).toEqual({
        content: [
          {
            type: 'text',
            text: 'Successfully submitted review: https://github.com/review/1\nState: APPROVED',
          },
        ],
      });
    });

    it('should call review_github_pr tool with inline comments correctly', async () => {
      mockCreateCodeReview.mockResolvedValueOnce({
        html_url: 'https://github.com/review/1',
        state: 'APPROVED',
      });
      const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'tools/call',
      );

      const response = (await callHandler!({
        method: 'tools/call',
        params: {
          name: 'review_github_pr',
          arguments: {
            repository: 'owner/repo',
            pullRequestNumber: 42,
            event: 'APPROVE',
            body: 'Good job!',
            comments: [
              {
                path: 'src/file.ts',
                line: 10,
                side: 'RIGHT',
                body: 'Fix this line please',
              },
            ],
          },
        },
      })) as { content: Array<{ type: string; text: string }> };

      expect(mockCreateCodeReview).toHaveBeenCalledWith('owner/repo', 42, 'APPROVE', 'Good job!', [
        {
          path: 'src/file.ts',
          line: 10,
          side: 'RIGHT',
          body: 'Fix this line please',
        },
      ]);
      expect(response).toEqual({
        content: [
          {
            type: 'text',
            text: 'Successfully submitted review: https://github.com/review/1\nState: APPROVED',
          },
        ],
      });
    });

    it('should call fix_github_pr_review tool correctly', async () => {
      mockGetPRReviewComments.mockResolvedValueOnce({ comments: [{ id: 1, body: 'fix this' }] });
      const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'tools/call',
      );

      const response = (await callHandler!({
        method: 'tools/call',
        params: {
          name: 'fix_github_pr_review',
          arguments: {
            repository: 'owner/repo',
            pullRequestNumber: 42,
            branch: 'feature',
          },
        },
      })) as { content: Array<{ type: string; text: string }> };

      expect(mockGetPRReviewComments).toHaveBeenCalledWith('owner/repo', 42);
      expect(response.content![0].text).toContain('Review comments fetched successfully');
    });
  });

  describe('Prompts', () => {
    it('should list all registered gitsystem prompts', async () => {
      const listHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'prompts/list',
      );
      expect(listHandler).toBeDefined();

      const response = (await listHandler!({ method: 'prompts/list' })) as { prompts: unknown[] };
      expect(response.prompts).toBeDefined();
      expect(response.prompts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'commit_generator_message' }),
          expect.objectContaining({ name: 'tech_company_pr_creator' }),
          expect.objectContaining({ name: 'ai_code_reviewer' }),
          expect.objectContaining({ name: 'fix_pr_review_message' }),
        ]),
      );
    });

    it('should call commit_generator_message prompt correctly', async () => {
      mockGetLocalGitChanges.mockResolvedValueOnce('staged file changes diff');
      const getHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'prompts/get',
      );
      expect(getHandler).toBeDefined();

      const response = (await getHandler!({
        method: 'prompts/get',
        params: {
          name: 'commit_generator_message',
          arguments: {
            command: 'refactor database connection',
          },
        },
      })) as { messages: Array<{ content: { text: string } }> };

      expect(mockGetLocalGitChanges).toHaveBeenCalled();
      expect(response.messages[0].content.text).toContain('refactor database connection');
      expect(response.messages[0].content.text).toContain('staged file changes diff');
    });

    it('should call tech_company_pr_creator prompt correctly', async () => {
      const getHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'prompts/get',
      );
      expect(getHandler).toBeDefined();

      const response = (await getHandler!({
        method: 'prompts/get',
        params: {
          name: 'tech_company_pr_creator',
          arguments: {
            command: 'context or changes description',
          },
        },
      })) as { messages: Array<{ content: { text: string } }> };

      expect(response.messages[0].content.text).toContain('context or changes description');
    });

    it('should call ai_code_reviewer prompt correctly and include Compound Engineering & Strict Security audit rules', async () => {
      const getHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'prompts/get',
      );
      expect(getHandler).toBeDefined();

      const response = (await getHandler!({
        method: 'prompts/get',
        params: {
          name: 'ai_code_reviewer',
          arguments: {
            command: 'diff to review',
          },
        },
      })) as { messages: Array<{ content: { text: string } }> };

      const promptText = response.messages[0].content.text;
      expect(promptText).toContain('diff to review');
      expect(promptText).toContain('Compound Engineering');
      expect(promptText).toContain('Strict Security & Defense');
      expect(promptText).toContain('OWASP');
      expect(promptText).toContain('Injection Defense');
      expect(promptText).toContain('Secret Exposure');
      expect(promptText).toContain('Strict Type Safety');
    });


    it('should call fix_pr_review_message prompt correctly', async () => {
      const getHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
        'prompts/get',
      );
      expect(getHandler).toBeDefined();

      const response = (await getHandler!({
        method: 'prompts/get',
        params: {
          name: 'fix_pr_review_message',
          arguments: {
            command: 'pr review comments text',
          },
        },
      })) as { messages: Array<{ content: { text: string } }> };

      expect(response.messages[0].content.text).toContain('pr review comments text');
    });
  });
});
