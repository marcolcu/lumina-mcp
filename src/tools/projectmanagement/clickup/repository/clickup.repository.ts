const CLICKUP_API_BASE_URL = 'https://api.clickup.com/api/v2';
const REQUEST_TIMEOUT_MS = 15000;

export interface ClickupTaskFilters {
  statuses?: string[];
  assignees?: string[];
  tags?: string[];
  dueDateGt?: number;
  dueDateLt?: number;
}

export class ClickupRepository {
  private buildHeaders(apiToken: string): Record<string, string> {
    return {
      Authorization: apiToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
  }

  private async buildErrorMessage(response: Response, endpoint: string): Promise<string> {
    if (response.status === 401) {
      return 'ClickUp authentication failed: invalid or expired API token.';
    }
    if (response.status === 404) {
      return `ClickUp resource not found for ${endpoint} (check the ID or your access permissions).`;
    }
    if (response.status === 429) {
      return 'ClickUp rate limit exceeded. Please try again later.';
    }

    let errorText = '';
    try {
      errorText = await response.text();
    } catch {
      // ignore body parse failures, fall back to statusText only
    }

    return `ClickUp API Error (${response.status}) on ${endpoint}: ${response.statusText}${errorText ? ' - ' + errorText : ''}`;
  }

  private async fetchFromClickup<T>(
    endpoint: string,
    apiToken: string,
    options: RequestInit = {},
    isRetry = false,
  ): Promise<T> {
    const url = `${CLICKUP_API_BASE_URL}${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { ...this.buildHeaders(apiToken), ...options.headers },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429 && !isRetry) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : 1;
      const waitMs = Math.max(Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : 1, 1) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.fetchFromClickup<T>(endpoint, apiToken, options, true);
    }

    if (!response.ok) {
      throw new Error(await this.buildErrorMessage(response, endpoint));
    }

    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }

  async listTasks(
    listId: string,
    apiToken: string,
    filters?: ClickupTaskFilters,
  ): Promise<unknown> {
    const params = new URLSearchParams();
    filters?.statuses?.forEach((status) => params.append('statuses[]', status));
    filters?.assignees?.forEach((assignee) => params.append('assignees[]', assignee));
    filters?.tags?.forEach((tag) => params.append('tags[]', tag));
    if (filters?.dueDateGt !== undefined) params.append('due_date_gt', String(filters.dueDateGt));
    if (filters?.dueDateLt !== undefined) params.append('due_date_lt', String(filters.dueDateLt));

    const query = params.toString();
    const endpoint = `/list/${listId}/task${query ? `?${query}` : ''}`;
    return this.fetchFromClickup<unknown>(endpoint, apiToken);
  }

  async getTask(taskId: string, apiToken: string): Promise<unknown> {
    return this.fetchFromClickup<unknown>(`/task/${taskId}`, apiToken);
  }

  async getTaskComments(taskId: string, apiToken: string): Promise<unknown> {
    return this.fetchFromClickup<unknown>(`/task/${taskId}/comment`, apiToken);
  }

  async createComment(
    taskId: string,
    commentText: string,
    apiToken: string,
    assignee?: number,
    notifyAll?: boolean,
  ): Promise<unknown> {
    const body: Record<string, unknown> = { comment_text: commentText };
    if (assignee !== undefined) body.assignee = assignee;
    if (notifyAll !== undefined) body.notify_all = notifyAll;

    return this.fetchFromClickup<unknown>(`/task/${taskId}/comment`, apiToken, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async updateComment(commentId: string, commentText: string, apiToken: string): Promise<unknown> {
    return this.fetchFromClickup<unknown>(`/comment/${commentId}`, apiToken, {
      method: 'PUT',
      body: JSON.stringify({ comment_text: commentText }),
    });
  }

  async deleteComment(commentId: string, apiToken: string): Promise<unknown> {
    return this.fetchFromClickup<unknown>(`/comment/${commentId}`, apiToken, {
      method: 'DELETE',
    });
  }
}

export const clickupRepository = new ClickupRepository();
