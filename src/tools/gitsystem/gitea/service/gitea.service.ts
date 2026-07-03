import { GiteaPRResponse, GiteaReviewResponse } from '../../types/gitea.types.js';
import { giteaRepository } from '../repository/gitea.repository.js';

export async function createPullRequest(
  repository: string,
  title: string,
  head: string,
  base: string,
  body: string,
  baseUrl?: string,
): Promise<GiteaPRResponse> {
  return await giteaRepository.createPullRequest(repository, title, head, base, body, baseUrl);
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

export async function getPRReviewComments(
  repository: string,
  pullRequestNumber: number,
  baseUrl?: string,
): Promise<unknown> {
  return await giteaRepository.getPRReviewComments(repository, pullRequestNumber, baseUrl);
}
