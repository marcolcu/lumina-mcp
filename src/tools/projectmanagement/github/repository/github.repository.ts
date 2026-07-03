export class GithubRepository {
  private buildHeaders(githubToken?: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
    };

    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken}`;
    }

    return headers;
  }

  async getIssue(
    owner: string,
    repo: string,
    issueNumber: string | number,
    githubToken?: string,
  ): Promise<unknown> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(githubToken),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch GitHub issue ${owner}/${repo}#${issueNumber}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  async getIssueComments(
    owner: string,
    repo: string,
    issueNumber: string | number,
    githubToken?: string,
  ): Promise<unknown[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(githubToken),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch comments for GitHub issue ${owner}/${repo}#${issueNumber}: ${response.statusText} - ${errorText}`,
      );
    }

    return (await response.json()) as unknown[];
  }

  async getIssueTimeline(
    owner: string,
    repo: string,
    issueNumber: string | number,
    githubToken?: string,
  ): Promise<unknown[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/timeline?per_page=100`;

    const response = await fetch(url, {
      method: 'GET',
      headers: this.buildHeaders(githubToken),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch timeline for GitHub issue ${owner}/${repo}#${issueNumber}: ${response.statusText} - ${errorText}`,
      );
    }

    return (await response.json()) as unknown[];
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string | undefined,
    labels: string[] | undefined,
    assignees: string[] | undefined,
    milestone: number | undefined,
    githubToken: string | undefined,
  ): Promise<unknown> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues`;

    const payload: Record<string, unknown> = { title };
    if (body) payload.body = body;
    if (labels && labels.length > 0) payload.labels = labels;
    if (assignees && assignees.length > 0) payload.assignees = assignees;
    if (milestone) payload.milestone = milestone;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...this.buildHeaders(githubToken),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to create GitHub issue in ${owner}/${repo}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }
}

export const githubRepository = new GithubRepository();
