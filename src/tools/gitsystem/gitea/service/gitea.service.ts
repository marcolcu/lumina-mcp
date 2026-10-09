import { GiteaPRResponse, GiteaReviewResponse } from '../../types/gitea.types.js';
import { giteaRepository } from '../repository/gitea.repository.js';

export async function createPullRequest(
  repository: string,
  title: string,
  head: string,
  base: string,
  body: string,
  assignees?: string[],
  baseUrl?: string,
): Promise<GiteaPRResponse> {
  return await giteaRepository.createPullRequest(
    repository,
    title,
    head,
    base,
    body,
    assignees,
    baseUrl,
  );
}

export async function requestReviewers(
  repository: string,
  pullRequestNumber: number,
  reviewers: string[],
  baseUrl?: string,
): Promise<unknown> {
  return await giteaRepository.requestReviewers(repository, pullRequestNumber, reviewers, baseUrl);
}

export async function getPullRequestDiff(
  repository: string,
  pullRequestNumber: number,
  baseUrl?: string,
): Promise<string> {
  return await giteaRepository.getPullRequestDiff(repository, pullRequestNumber, baseUrl);
}

export async function createCodeReview(
  repository: string,
  pullRequestNumber: number,
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
  body: string,
  comments?: Array<{
    path: string;
    line: number;
    side?: 'LEFT' | 'RIGHT';
    body: string;
  }>,
  baseUrl?: string,
): Promise<GiteaReviewResponse> {
  return await giteaRepository.createCodeReview(
    repository,
    pullRequestNumber,
    event,
    body,
    comments,
    baseUrl,
  );
}

export interface AutoApproveResult {
  approved: boolean;
  ciState: string;
  reason: string;
  review?: GiteaReviewResponse;
}

export async function autoApprovePullRequestIfChecksPass(
  repository: string,
  pullRequestNumber: number,
  baseUrl?: string,
): Promise<AutoApproveResult> {
  const pr = await giteaRepository.getPullRequest(repository, pullRequestNumber, baseUrl);
  const status = await giteaRepository.getCombinedCommitStatus(repository, pr.head.sha, baseUrl);

  if (status.state !== 'success') {
    return {
      approved: false,
      ciState: status.state,
      reason: `CI checks are "${status.state}" (not "success") for commit ${pr.head.sha}. Skipped auto-approve.`,
    };
  }

  const review = await giteaRepository.createCodeReview(
    repository,
    pullRequestNumber,
    'APPROVE',
    'Auto-approved: all CI checks passed.',
    undefined,
    baseUrl,
  );

  return {
    approved: true,
    ciState: status.state,
    reason: 'All CI checks passed.',
    review,
  };
}

export async function getPRReviewComments(
  repository: string,
  pullRequestNumber: number,
  baseUrl?: string,
): Promise<unknown> {
  return await giteaRepository.getPRReviewComments(repository, pullRequestNumber, baseUrl);
}
