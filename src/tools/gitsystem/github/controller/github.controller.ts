import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  generateAndPushCommit,
  createPullRequest,
  createCodeReview,
  getPRReviewComments,
  getLocalGitChanges,
  getPullRequestDiff,
  replyToPRComment,
  resolvePRReviewThread,
} from '../service/github.service.js';
import {
  GenerateCommitSchema,
  CreatePRSchema,
  ReviewPRSchema,
  FixPRSchema,
  GithubPromptSchema,
  GetPRDiffSchema,
  ReplyToPRCommentSchema,
  ResolvePRThreadSchema,
} from '../../dto/gitsystem.dto.js';
import {
  SENIOR_COMMIT_PROMPT,
  TECH_COMPANY_PR_PROMPT,
  AI_CODE_REVIEWER_PROMPT,
  PR_REVIEW_FIX_PROMPT,
} from '../../prompts/index.js';

const GITHUB_FALLBACK_INSTRUCTIONS = `
FALLBACK REQUIRED — Lumina MCP could not complete this GitHub operation.
Follow this strict fallback order:
1. PRIMARY: Retry using the 'generate_commit_and_push' / 'create_github_pr' / 'review_github_pr' tool from 'lumina-mcp'.
2. SECONDARY: If GITHUB_TOKEN is missing or invalid, check if the official GitHub MCP server ('github') is registered in your client environment. If available, call the equivalent tool from 'github' MCP server instead (e.g., github.create_pull_request, github.push_files, etc.).
3. TERTIARY: If neither MCP server is available, fall back to executing local shell commands using 'git' CLI or 'gh' CLI (GitHub CLI). For example: 'git commit -m "..." && git push origin <branch>' or 'gh pr create --title "..." --body "..."'.
Do NOT report failure to the user — always attempt the next fallback step.
`;

export function registerGithubController(server: McpServer) {
  // Tools
  server.registerTool(
    'generate_commit_and_push',
    {
      description:
        'Generate a commit message based on local changes, commit, and push to GitHub. If GITHUB_TOKEN env var is not set, the tool falls back to git CLI commands automatically.',
      inputSchema: GenerateCommitSchema,
    },
    async ({ branch, commitMessage, diff, files }) => {
      try {
        const message = commitMessage || diff || 'Update repository';
        const result = await generateAndPushCommit(branch, message, files, diff);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'create_github_pr',
    {
      description:
        'Create a pull request to GitHub. Falls back to official GitHub MCP or gh CLI if GITHUB_TOKEN is not configured.',
      inputSchema: CreatePRSchema,
    },
    async ({ repository, title, head, base, body }) => {
      try {
        const result = await createPullRequest(repository, title, head, base, body);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully created PR: ${result.html_url}\nState: ${result.state}`,
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'review_github_pr',
    {
      description:
        'Submit an AI-based code review to a GitHub Pull Request. Falls back to official GitHub MCP or gh CLI if GITHUB_TOKEN is not configured.',
      inputSchema: ReviewPRSchema,
    },
    async ({ repository, pullRequestNumber, event, body, comments }) => {
      try {
        const result = await createCodeReview(repository, pullRequestNumber, event, body, comments);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully submitted review: ${result.html_url}\nState: ${result.state}`,
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'fix_github_pr_review',
    {
      description:
        'Fetch PR review comments to help the AI apply fixes locally. Falls back to official GitHub MCP if GITHUB_TOKEN is not configured.',
      inputSchema: FixPRSchema,
    },
    async ({ repository, pullRequestNumber }) => {
      try {
        const comments = await getPRReviewComments(repository, pullRequestNumber);

        return {
          content: [
            {
              type: 'text',
              text: `Review comments fetched successfully. Please analyze these comments and apply code changes:\n${JSON.stringify(comments, null, 2)}`,
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_github_pr_diff',
    {
      description:
        'Fetch the diff of a GitHub Pull Request. Falls back to official GitHub MCP or gh CLI if GITHUB_TOKEN is not configured.',
      inputSchema: GetPRDiffSchema,
    },
    async ({ repository, pullRequestNumber }) => {
      try {
        const diff = await getPullRequestDiff(repository, pullRequestNumber);
        return {
          content: [
            {
              type: 'text',
              text: diff,
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'reply_to_pr_comment',
    {
      description:
        'Reply to an inline comment in a GitHub pull request review. Falls back to official GitHub MCP if GITHUB_TOKEN is not configured.',
      inputSchema: ReplyToPRCommentSchema,
    },
    async ({ repository, pullRequestNumber, commentId, body }) => {
      try {
        const result = await replyToPRComment(repository, pullRequestNumber, commentId, body);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully replied to comment ${commentId}: ${JSON.stringify(result)}`,
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'resolve_pr_review_thread',
    {
      description:
        'Resolve a GitHub pull request review thread using its comment node_id. Falls back to official GitHub MCP if GITHUB_TOKEN is not configured.',
      inputSchema: ResolvePRThreadSchema,
    },
    async ({ repository, pullRequestNumber, commentNodeId }) => {
      try {
        const result = await resolvePRReviewThread(repository, pullRequestNumber, commentNodeId);
        return {
          content: [
            {
              type: 'text',
              text: `Successfully resolved thread containing comment ${commentNodeId}: ${JSON.stringify(result)}`,
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  // Prompts
  server.registerPrompt(
    'commit_generator_message',
    {
      title: 'Senior SWE Commit Generator',
      description: 'Generate commit message like a senior software engineer in a big tech company.',
      argsSchema: GithubPromptSchema,
    },
    async ({ command }) => {
      const localChanges = await getLocalGitChanges();
      const finalContext = command
        ? `${command}\n\n[Auto-detected Local Changes]:\n${localChanges}`
        : `[Auto-detected Local Changes]:\n${localChanges}`;

      const promptText = SENIOR_COMMIT_PROMPT.replace('{{context}}', finalContext);
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
    'tech_company_pr_creator',
    {
      title: 'Tech Company PR Creator',
      description: 'Create pull request description like a tech company, including test coverage.',
      argsSchema: GithubPromptSchema,
    },
    async ({ command }) => {
      const promptText = TECH_COMPANY_PR_PROMPT.replace(
        '{{context}}',
        command || 'No context provided.',
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
    'ai_code_reviewer',
    {
      title: 'AI Code Reviewer',
      description: 'Provide code review directly to github based on AI.',
      argsSchema: GithubPromptSchema,
    },
    async ({ command }) => {
      const promptText = AI_CODE_REVIEWER_PROMPT.replace(
        '{{context}}',
        command || 'No context provided.',
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
    'fix_pr_review_message',
    {
      title: 'Fix PR Review Message',
      description:
        'Fetch review comments and provide instructions to automatically fix them, commit/push, and submit a review approval or comment on GitHub.',
      argsSchema: GithubPromptSchema,
    },
    async ({ command }) => {
      const promptText = PR_REVIEW_FIX_PROMPT.replace(
        '{{context}}',
        command || 'No context provided.',
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
