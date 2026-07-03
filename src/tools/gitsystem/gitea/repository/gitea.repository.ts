import { GITEA_ENDPOINTS, resolveGiteaBaseUrl } from '../../constants/gitea.endpoints.js';
import { GiteaPRResponse, GiteaReviewResponse } from '../../types/gitea.types.js';

// Map the GitHub-style review verbs used across the gitsystem tools to Gitea's
// ReviewStateType enum accepted by POST /pulls/{index}/reviews.
const GITEA_REVIEW_EVENT: Record<'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', string> = {
  APPROVE: 'APPROVED',
  REQUEST_CHANGES: 'REQUEST_CHANGES',
  COMMENT: 'COMMENT',
};

interface GiteaReviewComment {
  path: string;
  body: string;
  new_position?: number;
  old_position?: number;
}

export class GiteaRepository {
  private getHeaders(token?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'MCP-Gitea-Server',
    };
    const finalToken = token || process.env.GITEA_TOKEN;
    if (finalToken) {
      headers['Authorization'] = `token ${finalToken}`;
    }
    return headers;
  }

  public async fetchFromGitea<T>(
    baseUrl: string | undefined,
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${resolveGiteaBaseUrl(baseUrl)}${endpoint}`;

    const headers = {
      ...this.getHeaders(),
      'Content-Type': 'application/json',
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = response.statusText;
      }
      const method = (options.method ?? 'GET').toUpperCase();
      throw new Error(
        `Gitea API Error (${response.status}) on ${method} ${url}: ${JSON.stringify(errorData)}`,
      );
    }

    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  public async fetchTextFromGitea(
    baseUrl: string | undefined,
    endpoint: string,
    options: RequestInit = {},
  ): Promise<string> {
    const url = endpoint.startsWith('http')
      ? endpoint
      : `${resolveGiteaBaseUrl(baseUrl)}${endpoint}`;

    const headers = {
      ...this.getHeaders(),
      ...options.headers,
    };

    const response = await fetch(url, { ...options, headers });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch {
        errorData = response.statusText;
      }
      const method = (options.method ?? 'GET').toUpperCase();
      throw new Error(
        `Gitea API Error (${response.status}) on ${method} ${url}: ${JSON.stringify(errorData)}`,
      );
    }

    return response.text();
  }

  public async createPullRequest(
    repository: string,
    title: string,
    head: string,
    base: string,
    body: string,
    baseUrl?: string,
  ): Promise<GiteaPRResponse> {
    return this.fetchFromGitea<GiteaPRResponse>(baseUrl, GITEA_ENDPOINTS.CREATE_PR(repository), {
      method: 'POST',
      body: JSON.stringify({ title, head, base, body }),
    });
  }

  public async getPullRequestDiff(
    repository: string,
    pullRequestNumber: number,
    baseUrl?: string,
  ): Promise<string> {
    return this.fetchTextFromGitea(
      baseUrl,
      GITEA_ENDPOINTS.PULL_REQUEST_DIFF(repository, pullRequestNumber),
    );
  }

  public async createCodeReview(
    repository: string,
    pullRequestNumber: number,
    event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT',
    body: string,
    comments?: Array<{ path: string; line: number; side?: 'LEFT' | 'RIGHT'; body: string }>,
    baseUrl?: string,
  ): Promise<GiteaReviewResponse> {
    const giteaComments: GiteaReviewComment[] = (comments ?? []).map((c) =>
      c.side === 'LEFT'
        ? { path: c.path, body: c.body, old_position: c.line }
        : { path: c.path, body: c.body, new_position: c.line },
    );

    return this.fetchFromGitea<GiteaReviewResponse>(
      baseUrl,
      GITEA_ENDPOINTS.PR_REVIEWS(repository, pullRequestNumber),
      {
        method: 'POST',
        body: JSON.stringify({
          event: GITEA_REVIEW_EVENT[event],
          body,
          comments: giteaComments,
        }),
      },
    );
  }

  public async getPRReviewComments(
    repository: string,
    pullRequestNumber: number,
    baseUrl?: string,
  ): Promise<unknown> {
    const reviews = await this.fetchFromGitea<Array<{ id: number }>>(
      baseUrl,
      GITEA_ENDPOINTS.PR_REVIEWS(repository, pullRequestNumber),
    );

    // Gitea nests inline comments under each review, unlike GitHub's flat list.
    const commentsNested = await Promise.all(
      (reviews ?? []).map((review) =>
        this.fetchFromGitea<unknown[]>(
          baseUrl,
          GITEA_ENDPOINTS.PR_REVIEW_COMMENTS(repository, pullRequestNumber, review.id),
        ).catch(() => [] as unknown[]),
      ),
    );

    const comments = commentsNested.flat();
    return { reviews, comments };
  }
}

export const giteaRepository = new GiteaRepository();
