import { z } from 'zod';

export const GenerateCommitSchema = z.object({
  branch: z.string().describe('Branch name to commit and push to'),
  files: z.array(z.string()).describe('List of specific files to add and commit'),
  commitMessage: z
    .string()
    .optional()
    .describe('The commit message to use. If not provided, diff is used as message.'),
  diff: z.string().optional().describe('Git diff content or fallback commit message.'),
});

export const CreatePRSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  title: z.string().describe('Pull request title'),
  head: z.string().describe('The name of the branch where your changes are implemented'),
  base: z.string().describe('The name of the branch you want the changes pulled into'),
  body: z.string().describe('The contents of the pull request'),
});

export const ReviewPRSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  pullRequestNumber: z.number().describe('The number of the pull request to review'),
  event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('The review action to perform'),
  body: z.string().describe('The body text of the pull request review'),
  comments: z
    .array(
      z.object({
        path: z.string().describe('The path to the file being reviewed'),
        line: z.number().describe('The line number in the file to comment on'),
        side: z.enum(['LEFT', 'RIGHT']).optional().describe('The side of the diff (LEFT or RIGHT)'),
        body: z.string().describe('The text of the comment'),
      }),
    )
    .optional()
    .describe('Optional inline comments'),
});

export const FixPRSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  pullRequestNumber: z.number().describe('The number of the pull request'),
});

export const GetPRDiffSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  pullRequestNumber: z.number().describe('The number of the pull request to get the diff for'),
});

export const ReplyToPRCommentSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  pullRequestNumber: z.number().describe('The number of the pull request'),
  commentId: z.number().describe('The numeric ID of the comment to reply to'),
  body: z.string().describe('The reply text'),
});

export const ResolvePRThreadSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  pullRequestNumber: z.number().describe('The number of the pull request'),
  commentNodeId: z
    .string()
    .describe('The GraphQL node_id of the comment thread to resolve (e.g. PRRC_...)'),
});

// --- Gitea (self-hosted) ---
// Mirrors the GitHub schemas, adding an optional `baseUrl` for the self-hosted
// instance (falls back to the GITEA_BASE_URL env var).

const GiteaBaseUrlSchema = z
  .string()
  .optional()
  .describe(
    'Gitea instance base URL, e.g. https://gitea.example.com:3000. Falls back to the GITEA_BASE_URL env var.',
  );

export const CreateGiteaPRSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  title: z.string().describe('Pull request title'),
  head: z.string().describe('The name of the branch where your changes are implemented'),
  base: z.string().describe('The name of the branch you want the changes pulled into'),
  body: z.string().describe('The contents of the pull request'),
  baseUrl: GiteaBaseUrlSchema,
});

export const ReviewGiteaPRSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  pullRequestNumber: z.number().describe('The number of the pull request to review'),
  event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']).describe('The review action to perform'),
  body: z.string().describe('The body text of the pull request review'),
  comments: z
    .array(
      z.object({
        path: z.string().describe('The path to the file being reviewed'),
        line: z.number().describe('The line number in the file to comment on'),
        side: z.enum(['LEFT', 'RIGHT']).optional().describe('The side of the diff (LEFT or RIGHT)'),
        body: z.string().describe('The text of the comment'),
      }),
    )
    .optional()
    .describe('Optional inline comments'),
  baseUrl: GiteaBaseUrlSchema,
});

export const FixGiteaPRSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  pullRequestNumber: z.number().describe('The number of the pull request'),
  baseUrl: GiteaBaseUrlSchema,
});

export const GetGiteaPRDiffSchema = z.object({
  repository: z.string().describe('Repository name in format owner/repo'),
  pullRequestNumber: z.number().describe('The number of the pull request to get the diff for'),
  baseUrl: GiteaBaseUrlSchema,
});

export const GithubPromptSchema = {
  command: z
    .string()
    .optional()
    .describe(
      'Natural language command or context for the GitHub prompt (e.g., details about the commit, PR context, or review instructions)',
    ),
};
