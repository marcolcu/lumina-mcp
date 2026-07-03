import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGiteaRepository } = vi.hoisted(() => ({
  mockGiteaRepository: {
    createPullRequest: vi.fn(),
    getPullRequestDiff: vi.fn(),
    createCodeReview: vi.fn(),
    getPRReviewComments: vi.fn(),
  },
}));

vi.mock('../../../../src/tools/gitsystem/gitea/repository/gitea.repository.js', () => ({
  giteaRepository: mockGiteaRepository,
}));

import {
  createPullRequest,
  getPullRequestDiff,
  createCodeReview,
  getPRReviewComments,
} from '../../../../src/tools/gitsystem/gitea/service/gitea.service.js';

describe('Gitea Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should proxy createPullRequest to giteaRepository with baseUrl', async () => {
    mockGiteaRepository.createPullRequest.mockResolvedValueOnce({ id: 1 });
    const result = await createPullRequest(
      'owner/repo',
      'title',
      'head',
      'base',
      'body',
      'https://git.internal',
    );
    expect(mockGiteaRepository.createPullRequest).toHaveBeenCalledWith(
      'owner/repo',
      'title',
      'head',
      'base',
      'body',
      'https://git.internal',
    );
    expect(result).toEqual({ id: 1 });
  });

  it('should proxy getPullRequestDiff to giteaRepository', async () => {
    mockGiteaRepository.getPullRequestDiff.mockResolvedValueOnce('diff');
    const result = await getPullRequestDiff('owner/repo', 42);
    expect(mockGiteaRepository.getPullRequestDiff).toHaveBeenCalledWith(
      'owner/repo',
      42,
      undefined,
    );
    expect(result).toBe('diff');
  });

  it('should proxy createCodeReview to giteaRepository', async () => {
    mockGiteaRepository.createCodeReview.mockResolvedValueOnce({ id: 2 });
    const result = await createCodeReview('owner/repo', 42, 'APPROVE', 'body', []);
    expect(mockGiteaRepository.createCodeReview).toHaveBeenCalledWith(
      'owner/repo',
      42,
      'APPROVE',
      'body',
      [],
      undefined,
    );
    expect(result).toEqual({ id: 2 });
  });

  it('should proxy getPRReviewComments to giteaRepository', async () => {
    mockGiteaRepository.getPRReviewComments.mockResolvedValueOnce({ reviews: [], comments: [] });
    const result = await getPRReviewComments('owner/repo', 42);
    expect(mockGiteaRepository.getPRReviewComments).toHaveBeenCalledWith(
      'owner/repo',
      42,
      undefined,
    );
    expect(result).toEqual({ reviews: [], comments: [] });
  });
});
