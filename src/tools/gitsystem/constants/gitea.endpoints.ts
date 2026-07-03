/**
 * Resolve the Gitea API base URL (`<host>/api/v1`) from an explicit parameter or
 * the GITEA_BASE_URL environment variable. Unlike GitHub, Gitea is self-hosted so
 * the host is never hardcoded.
 */
export function resolveGiteaBaseUrl(baseUrl?: string): string {
  // Trim to guard against stray whitespace/newlines pasted into env/MCP config,
  // which would otherwise produce a malformed URL and confusing routing errors.
  const raw = (baseUrl || process.env.GITEA_BASE_URL)?.trim();
  if (!raw) {
    throw new Error(
      'Gitea base URL is not configured. Provide the "baseUrl" parameter or set the GITEA_BASE_URL environment variable (e.g. https://gitea.example.com:3000).',
    );
  }
  // Strip trailing slashes and an optional trailing /api/v1 so we can append it cleanly.
  const trimmed = raw.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  return `${trimmed}/api/v1`;
}

export const GITEA_ENDPOINTS = {
  CREATE_PR: (repository: string) => `/repos/${repository}/pulls`,
  PULL_REQUEST_DIFF: (repository: string, index: number) =>
    `/repos/${repository}/pulls/${index}.diff`,
  PR_REVIEWS: (repository: string, index: number) => `/repos/${repository}/pulls/${index}/reviews`,
  PR_REVIEW_COMMENTS: (repository: string, index: number, reviewId: number) =>
    `/repos/${repository}/pulls/${index}/reviews/${reviewId}/comments`,
};
