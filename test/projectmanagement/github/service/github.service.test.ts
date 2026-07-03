import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetIssue, mockGetIssueComments, mockGetIssueTimeline, mockCreateIssue } = vi.hoisted(
  () => ({
    mockGetIssue: vi.fn(),
    mockGetIssueComments: vi.fn(),
    mockGetIssueTimeline: vi.fn(),
    mockCreateIssue: vi.fn(),
  }),
);

vi.mock('../../../../src/tools/projectmanagement/github/repository/github.repository.js', () => ({
  githubRepository: {
    getIssue: mockGetIssue,
    getIssueComments: mockGetIssueComments,
    getIssueTimeline: mockGetIssueTimeline,
    createIssue: mockCreateIssue,
  },
}));

import {
  getGithubIssue,
  createGithubIssue,
} from '../../../../src/tools/projectmanagement/github/service/github.service.js';

describe('GithubService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  });

  it('should call repository when arguments are valid', async () => {
    mockGetIssue.mockResolvedValueOnce({ id: 1 });
    mockGetIssueComments.mockResolvedValueOnce([]);
    mockGetIssueTimeline.mockResolvedValueOnce([]);

    const result = await getGithubIssue('myowner', 'myrepo', 1, 'mytoken');

    expect(mockGetIssue).toHaveBeenCalledWith('myowner', 'myrepo', 1, 'mytoken');
    expect(result).toEqual(expect.objectContaining({ id: 1 }));
  });

  it('should fallback to env variables if token is omitted', async () => {
    process.env.GITHUB_TOKEN = 'envtoken';

    mockGetIssue.mockResolvedValueOnce({ id: 2 });
    mockGetIssueComments.mockResolvedValueOnce([]);
    mockGetIssueTimeline.mockResolvedValueOnce([]);

    await getGithubIssue('myowner', 'myrepo', 2);

    expect(mockGetIssue).toHaveBeenCalledWith('myowner', 'myrepo', 2, 'envtoken');
  });

  it('should fallback to GITHUB_PERSONAL_ACCESS_TOKEN if GITHUB_TOKEN is omitted', async () => {
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'pattoken';

    mockGetIssue.mockResolvedValueOnce({ id: 3 });
    mockGetIssueComments.mockResolvedValueOnce([]);
    mockGetIssueTimeline.mockResolvedValueOnce([]);

    await getGithubIssue('myowner', 'myrepo', 3);

    expect(mockGetIssue).toHaveBeenCalledWith('myowner', 'myrepo', 3, 'pattoken');
  });

  it('should throw error if owner is missing', async () => {
    await expect(getGithubIssue('', 'myrepo', 4)).rejects.toThrow(
      'Owner, repo, and issueNumber are required to fetch a GitHub issue.',
    );
  });

  it('should throw error if repo is missing', async () => {
    await expect(getGithubIssue('myowner', '', 4)).rejects.toThrow(
      'Owner, repo, and issueNumber are required to fetch a GitHub issue.',
    );
  });

  it('should throw error if issueNumber is missing', async () => {
    await expect(getGithubIssue('myowner', 'myrepo', '')).rejects.toThrow(
      'Owner, repo, and issueNumber are required to fetch a GitHub issue.',
    );
  });
  describe('createGithubIssue', () => {
    it('should call repository.createIssue when arguments are valid', async () => {
      mockCreateIssue.mockResolvedValueOnce({ id: 10 });

      const result = await createGithubIssue(
        'myowner',
        'myrepo',
        'My Title',
        'My Body',
        ['bug'],
        ['me'],
        1,
        'mytoken',
      );

      expect(mockCreateIssue).toHaveBeenCalledWith(
        'myowner',
        'myrepo',
        'My Title',
        'My Body',
        ['bug'],
        ['me'],
        1,
        'mytoken',
      );
      expect(result).toEqual({ id: 10 });
    });

    it('should fallback to env variables if token is omitted', async () => {
      process.env.GITHUB_TOKEN = 'envtoken';
      mockCreateIssue.mockResolvedValueOnce({ id: 11 });

      await createGithubIssue('myowner', 'myrepo', 'My Title');

      expect(mockCreateIssue).toHaveBeenCalledWith(
        'myowner',
        'myrepo',
        'My Title',
        undefined,
        undefined,
        undefined,
        undefined,
        'envtoken',
      );
    });

    it('should throw error if owner, repo, or title are missing', async () => {
      await expect(createGithubIssue('', 'repo', 'title')).rejects.toThrow(
        'Owner, repo, and title are required to create a GitHub issue.',
      );
      await expect(createGithubIssue('owner', '', 'title')).rejects.toThrow(
        'Owner, repo, and title are required to create a GitHub issue.',
      );
      await expect(createGithubIssue('owner', 'repo', '')).rejects.toThrow(
        'Owner, repo, and title are required to create a GitHub issue.',
      );
    });
  });
});
