import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { githubRepository } from '../../../../src/tools/gitsystem/github/repository/github.repository.js';
import { GITHUB_ENDPOINTS } from '../../../../src/tools/gitsystem/constants/github.endpoints.js';

describe('GitHub Repository', () => {
  let originalEnv: NodeJS.ProcessEnv;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.GITHUB_TOKEN = 'test-token';
    global.fetch = mockFetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('fetchFromGithub', () => {
    it('should successfully make GET request and return JSON', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: 'test-data' }),
      });

      const result = await githubRepository.fetchFromGithub('/endpoint');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com/endpoint',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': 'MCP-Github-Server',
          }),
        }),
      );
      expect(result).toEqual({ data: 'test-data' });
    });

    it('should handle 204 No Content response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      const result = await githubRepository.fetchFromGithub('/endpoint');
      expect(result).toEqual({});
    });

    it('should throw error on failed request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      });

      await expect(githubRepository.fetchFromGithub('/endpoint')).rejects.toThrow(
        'GitHub API Error (404): {"message":"Not Found"}',
      );
    });
  });

  describe('API methods', () => {
    it('should call fetchFromGithub for createPullRequest', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ html_url: 'https://github.com/pr/1', state: 'open' }),
      });

      const result = await githubRepository.createPullRequest(
        'owner/repo',
        'title',
        'head',
        'base',
        'body',
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com' + GITHUB_ENDPOINTS.CREATE_PR('owner/repo'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'title', head: 'head', base: 'base', body: 'body' }),
        }),
      );
      expect(result).toEqual({ html_url: 'https://github.com/pr/1', state: 'open' });
    });

    it('should call fetchFromGithub for createCodeReview', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: 'APPROVED' }),
      });

      const result = await githubRepository.createCodeReview(
        'owner/repo',
        42,
        'APPROVE',
        'body',
        [],
      );

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.github.com' + GITHUB_ENDPOINTS.PR_REVIEWS('owner/repo', 42),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ event: 'APPROVE', body: 'body', comments: [] }),
        }),
      );
      expect(result).toEqual({ state: 'APPROVED' });
    });

    it('should call fetchFromGithub for getPRReviewComments', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.includes('/reviews')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [{ id: 1, body: 'review summary' }],
          });
        }
        if (url.includes('/comments')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [{ id: 10, body: 'inline comment' }],
          });
        }
        return Promise.reject(new Error('Unknown url'));
      });

      const result = (await githubRepository.getPRReviewComments('owner/repo', 42)) as {
        reviews: Array<{ id: number; body: string }>;
        comments: Array<{ id: number; body: string }>;
      };

      expect(result.reviews).toEqual([{ id: 1, body: 'review summary' }]);
      expect(result.comments).toEqual([{ id: 10, body: 'inline comment' }]);
    });
  });
});
