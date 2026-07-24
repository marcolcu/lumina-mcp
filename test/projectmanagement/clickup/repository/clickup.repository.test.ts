import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClickupRepository } from '../../../../src/tools/projectmanagement/clickup/repository/clickup.repository.js';

describe('ClickupRepository', () => {
  let repository: ClickupRepository;

  beforeEach(() => {
    repository = new ClickupRepository();
    global.fetch = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should list tasks successfully', async () => {
    const mockResponse = { tasks: [{ id: '1', name: 'Task 1' }] };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.listTasks('list123', 'tok_123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/list/list123/task',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'tok_123',
        }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should append filter query params when listing tasks', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ tasks: [] }),
    } as Response);

    await repository.listTasks('list123', 'tok_123', {
      statuses: ['open'],
      assignees: ['5'],
      tags: ['urgent'],
      dueDateGt: 100,
      dueDateLt: 200,
    });

    const calledUrl = vi.mocked(global.fetch).mock.calls[0][0] as string;
    expect(calledUrl).toContain('statuses%5B%5D=open');
    expect(calledUrl).toContain('assignees%5B%5D=5');
    expect(calledUrl).toContain('tags%5B%5D=urgent');
    expect(calledUrl).toContain('due_date_gt=100');
    expect(calledUrl).toContain('due_date_lt=200');
  });

  it('should fetch a single task successfully', async () => {
    const mockResponse = { id: 'task1', name: 'My Task' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.getTask('task1', 'tok_123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/task/task1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'tok_123' }) }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should fetch task comments successfully', async () => {
    const mockResponse = { comments: [{ id: 'c1', comment_text: 'hi' }] };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.getTaskComments('task1', 'tok_123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/task/task1/comment',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'tok_123' }) }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should create a comment successfully', async () => {
    const mockResponse = { id: 'c1' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.createComment('task1', 'hello world', 'tok_123', 5, true);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/task/task1/comment',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ comment_text: 'hello world', assignee: 5, notify_all: true }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should update a comment successfully', async () => {
    const mockResponse = { id: 'c1' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.updateComment('c1', 'updated text', 'tok_123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/comment/c1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ comment_text: 'updated text' }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should delete a comment successfully', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      status: 204,
    } as Response);

    const result = await repository.deleteComment('c1', 'tok_123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.clickup.com/api/v2/comment/c1',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(result).toEqual({});
  });

  it('should throw a human-readable error for 401 responses', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => 'invalid token',
    } as Response);

    await expect(repository.getTask('task1', 'bad_token')).rejects.toThrow(
      'ClickUp authentication failed: invalid or expired API token.',
    );
  });

  it('should throw a human-readable error for 404 responses', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'not found',
    } as Response);

    await expect(repository.getTask('missing', 'tok_123')).rejects.toThrow(
      'ClickUp resource not found for /task/missing (check the ID or your access permissions).',
    );
  });

  it('should throw a generic error for other failure statuses', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    } as Response);

    await expect(repository.getTask('task1', 'tok_123')).rejects.toThrow(
      'ClickUp API Error (500) on /task/task1: Internal Server Error - boom',
    );
  });

  it('should retry once after a 429 response respecting Retry-After, then succeed', async () => {
    vi.useFakeTimers();

    const headers = new Headers({ 'Retry-After': '1' });
    const rateLimitedResponse = {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers,
      text: async () => 'rate limited',
    } as unknown as Response;
    const successResponse = {
      ok: true,
      status: 200,
      json: async () => ({ id: 'task1' }),
    } as Response;

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(rateLimitedResponse)
      .mockResolvedValueOnce(successResponse);

    const resultPromise = repository.getTask('task1', 'tok_123');
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ id: 'task1' });
  });

  it('should not retry more than once and should surface the rate limit error', async () => {
    vi.useFakeTimers();

    const headers = new Headers({ 'Retry-After': '1' });
    const rateLimitedResponse = {
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      headers,
      text: async () => 'rate limited',
    } as unknown as Response;

    vi.mocked(global.fetch).mockResolvedValue(rateLimitedResponse);

    const resultPromise = repository.getTask('task1', 'tok_123');
    const assertionPromise = expect(resultPromise).rejects.toThrow(
      'ClickUp rate limit exceeded. Please try again later.',
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertionPromise;

    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
