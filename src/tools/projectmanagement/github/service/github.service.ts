import { githubRepository } from '../repository/github.repository.js';
import type {
  GitHubIssueContext,
  GitHubIssueComment,
  GitHubLinkedPullRequest,
  GitHubIssueAuthor,
  GitHubIssueLabel,
  GitHubIssueMilestone,
} from '../types/github-issue.types.js';

interface RawGitHubIssue {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  user?: { login: string; avatar_url: string };
  assignees?: Array<{ login: string; avatar_url: string }>;
  labels?: Array<{ name: string; color: string; description: string | null }>;
  milestone?: {
    title: string;
    state: string;
    due_on: string | null;
    description: string | null;
  } | null;
}

interface RawGitHubComment {
  id: number;
  user?: { login: string };
  body: string;
  created_at: string;
  updated_at: string;
}

interface RawTimelineEvent {
  event?: string;
  source?: {
    issue?: {
      number: number;
      title: string;
      state: string;
      html_url: string;
      pull_request?: unknown;
    };
  };
}

function mapAuthor(user?: { login: string; avatar_url: string }): GitHubIssueAuthor {
  return {
    login: user?.login ?? 'unknown',
    avatar_url: user?.avatar_url ?? '',
  };
}

function mapAssignees(
  assignees?: Array<{ login: string; avatar_url: string }>,
): GitHubIssueAuthor[] {
  return (assignees ?? []).map((a) => ({
    login: a.login,
    avatar_url: a.avatar_url,
  }));
}

function mapLabels(
  labels?: Array<{ name: string; color: string; description: string | null }>,
): GitHubIssueLabel[] {
  return (labels ?? []).map((l) => ({
    name: l.name,
    color: l.color,
    description: l.description ?? null,
  }));
}

function mapMilestone(
  milestone?: {
    title: string;
    state: string;
    due_on: string | null;
    description: string | null;
  } | null,
): GitHubIssueMilestone | null {
  if (!milestone) return null;
  return {
    title: milestone.title,
    state: milestone.state,
    due_on: milestone.due_on,
    description: milestone.description,
  };
}

function mapComments(rawComments: unknown[]): GitHubIssueComment[] {
  return (rawComments as RawGitHubComment[]).map((c) => ({
    id: c.id,
    author: c.user?.login ?? 'unknown',
    body: c.body,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
}

function extractLinkedPullRequests(timelineEvents: unknown[]): GitHubLinkedPullRequest[] {
  const events = timelineEvents as RawTimelineEvent[];
  const prs = events
    .filter((e) => e.event === 'cross-referenced' && e.source?.issue?.pull_request != null)
    .map((e) => ({
      number: e.source!.issue!.number,
      title: e.source!.issue!.title,
      state: e.source!.issue!.state,
      html_url: e.source!.issue!.html_url,
    }));

  // Deduplicate by PR number
  const uniquePrs = new Map<number, GitHubLinkedPullRequest>();
  for (const pr of prs) {
    uniquePrs.set(pr.number, pr);
  }
  return Array.from(uniquePrs.values());
}

export async function getGithubIssue(
  owner: string,
  repo: string,
  issueNumber: string | number,
  githubToken?: string,
): Promise<GitHubIssueContext> {
  const finalToken =
    githubToken || process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  if (!owner || !repo || !issueNumber) {
    throw new Error('Owner, repo, and issueNumber are required to fetch a GitHub issue.');
  }

  // Fetch issue, comments, and timeline in parallel
  const [issueResult, commentsResult, timelineResult] = await Promise.allSettled([
    githubRepository.getIssue(owner, repo, issueNumber, finalToken),
    githubRepository.getIssueComments(owner, repo, issueNumber, finalToken),
    githubRepository.getIssueTimeline(owner, repo, issueNumber, finalToken),
  ]);

  // The core issue fetch must succeed
  if (issueResult.status === 'rejected') {
    throw issueResult.reason;
  }

  const rawIssue = issueResult.value as RawGitHubIssue;
  const warnings: string[] = [];

  // Comments — graceful degradation
  let comments: GitHubIssueComment[] = [];
  if (commentsResult.status === 'fulfilled') {
    comments = mapComments(commentsResult.value);
    if (comments.length === 100) {
      warnings.push(
        'Comments are truncated. Only the first 100 comments are fetched. Consider implementing pagination.',
      );
    }
  } else {
    warnings.push(
      `Failed to fetch comments: ${commentsResult.reason instanceof Error ? commentsResult.reason.message : String(commentsResult.reason)}`,
    );
  }

  // Timeline / Linked PRs — graceful degradation
  let linked_pull_requests: GitHubLinkedPullRequest[] = [];
  if (timelineResult.status === 'fulfilled') {
    linked_pull_requests = extractLinkedPullRequests(timelineResult.value);
  } else {
    warnings.push(
      `Failed to fetch timeline: ${timelineResult.reason instanceof Error ? timelineResult.reason.message : String(timelineResult.reason)}`,
    );
  }

  const context: GitHubIssueContext = {
    id: rawIssue.id,
    number: rawIssue.number,
    title: rawIssue.title,
    body: rawIssue.body ?? '',
    state: rawIssue.state,
    html_url: rawIssue.html_url,
    created_at: rawIssue.created_at,
    updated_at: rawIssue.updated_at,
    author: mapAuthor(rawIssue.user),
    assignees: mapAssignees(rawIssue.assignees),
    labels: mapLabels(rawIssue.labels),
    milestone: mapMilestone(rawIssue.milestone),
    comments,
    linked_pull_requests,
  };

  if (warnings.length > 0) {
    context._warnings = warnings;
  }

  return context;
}

export async function createGithubIssue(
  owner: string,
  repo: string,
  title: string,
  body?: string,
  labels?: string[],
  assignees?: string[],
  milestone?: number,
  githubToken?: string,
): Promise<unknown> {
  const finalToken =
    githubToken || process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN;

  if (!owner || !repo || !title) {
    throw new Error('Owner, repo, and title are required to create a GitHub issue.');
  }

  // Final token is optional for public repos, though usually required to create issues
  return await githubRepository.createIssue(
    owner,
    repo,
    title,
    body,
    labels,
    assignees,
    milestone,
    finalToken,
  );
}
