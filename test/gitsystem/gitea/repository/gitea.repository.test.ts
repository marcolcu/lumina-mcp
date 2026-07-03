import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { giteaRepository } from '../../../../src/tools/gitsystem/gitea/repository/gitea.repository.js';
import { GITEA_ENDPOINTS } from '../../../../src/tools/gitsystem/constants/gitea.endpoints.js';

const BASE_URL = 'https://gitea.example.com:3000';
const API = `${BASE_URL}/api/v1`;

describe('Gitea Repository', () => {
  let originalEnv: NodeJS.ProcessEnv;
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    process.env.GITEA_TOKEN = 'test-token';
    process.env.GITEA_BASE_URL = BASE_URL;
    global.fetch = mockFetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('fetchFromGitea', () => {
    it('should make a request with token auth and resolved base URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ data: 'test-data' }),
      });

      const result = await giteaRepository.fetchFromGitea(undefined, '/endpoint');

      expect(mockFetch).toHaveBeenCalledWith(
        `${API}/endpoint`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'token test-token',
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'MCP-Gitea-Server',
          }),
        }),
      );
      expect(result).toEqual({ data: 'test-data' });
    });

    it('should honor an explicit baseUrl parameter over the env var', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await giteaRepository.fetchFromGitea('https://git.internal', '/endpoint');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://git.internal/api/v1/endpoint',
        expect.any(Object),
      );
    });

    it('should handle 204 No Content response', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204 });
      const result = await giteaRepository.fetchFromGitea(undefined, '/endpoint');
      expect(result).toEqual({});
    });

    it('should throw error on failed request', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      });

      await expect(giteaRepository.fetchFromGitea(undefined, '/endpoint')).rejects.toThrow(
        `Gitea API Error (404) on GET ${API}/endpoint: {"message":"Not Found"}`,
      );
    });

    it('should throw a clear error when no base URL is configured', async () => {
      delete process.env.GITEA_BASE_URL;
      await expect(giteaRepository.fetchFromGitea(undefined, '/endpoint')).rejects.toThrow(
        'Gitea base URL is not configured',
      );
    });
  });

  describe('API methods', () => {
    it('should call the create pull request endpoint', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ html_url: `${BASE_URL}/owner/repo/pulls/1`, state: 'open' }),
      });

      const result = await giteaRepository.createPullRequest(
        'owner/repo',
        'title',
        'head',
        'base',
        'body',
      );

      expect(mockFetch).toHaveBeenCalledWith(
        `${API}${GITEA_ENDPOINTS.CREATE_PR('owner/repo')}`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'title', head: 'head', base: 'base', body: 'body' }),
        }),
      );
      expect(result).toEqual({ html_url: `${BASE_URL}/owner/repo/pulls/1`, state: 'open' });
    });

    it('should fetch a pull request diff as text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'diff --git a/file b/file',
      });

      const result = await giteaRepository.getPullRequestDiff('owner/repo', 42);

      expect(mockFetch).toHaveBeenCalledWith(
        `${API}${GITEA_ENDPOINTS.PULL_REQUEST_DIFF('owner/repo', 42)}`,
        expect.any(Object),
      );
      expect(result).toBe('diff --git a/file b/file');
    });

    it('should map review event verb and comment sides for createCodeReview', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ state: 'APPROVED' }),
      });

      const result = await giteaRepository.createCodeReview('owner/repo', 42, 'APPROVE', 'body', [
        { path: 'a.ts', line: 10, side: 'RIGHT', body: 'right comment' },
        { path: 'b.ts', line: 5, side: 'LEFT', body: 'left comment' },
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        `${API}${GITEA_ENDPOINTS.PR_REVIEWS('owner/repo', 42)}`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            event: 'APPROVED',
            body: 'body',
            comments: [
              { path: 'a.ts', body: 'right comment', new_position: 10 },
              { path: 'b.ts', body: 'left comment', old_position: 5 },
            ],
          }),
        }),
      );
      expect(result).toEqual({ state: 'APPROVED' });
    });

    it('should aggregate review comments from each review for getPRReviewComments', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url.endsWith('/reviews')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [{ id: 1 }, { id: 2 }],
          });
        }
        if (url.includes('/reviews/1/comments')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [{ id: 10, body: 'c1' }],
          });
        }
        if (url.includes('/reviews/2/comments')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [{ id: 20, body: 'c2' }],
          });
        }
        return Promise.reject(new Error('Unknown url'));
      });

      const result = (await giteaRepository.getPRReviewComments('owner/repo', 42)) as {
        reviews: Array<{ id: number }>;
        comments: Array<{ id: number; body: string }>;
      };

      expect(result.reviews).toEqual([{ id: 1 }, { id: 2 }]);
      expect(result.comments).toEqual([
        { id: 10, body: 'c1' },
        { id: 20, body: 'c2' },
      ]);
    });
  });
});
