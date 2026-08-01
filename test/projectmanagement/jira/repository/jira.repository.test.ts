import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JiraRepository } from '../../../../src/tools/projectmanagement/jira/repository/jira.repository.js';

describe('JiraRepository', () => {
  let repository: JiraRepository;

  beforeEach(() => {
    repository = new JiraRepository();
    global.fetch = vi.fn();
  });

  it('should fetch Jira ticket successfully', async () => {
    const mockResponse = { id: '123', key: 'PRJ-123' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.getTicket('PRJ-123', 'testdomain', 'test@test.com', 'token123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://testdomain.atlassian.net/rest/api/3/issue/PRJ-123',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from('test@test.com:token123').toString('base64')}`,
          Accept: 'application/json',
        },
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if fetch fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
      text: async () => 'Issue does not exist',
    } as Response);

    await expect(
      repository.getTicket('PRJ-999', 'testdomain', 'test@test.com', 'token123'),
    ).rejects.toThrow('Failed to fetch Jira ticket PRJ-999: Not Found - Issue does not exist');
  });
  it('should create Jira ticket successfully', async () => {
    const mockResponse = { id: '456', key: 'PRJ-456' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.createTicket(
      'PRJ',
      'New Jira Ticket',
      'Task',
      'Ticket Description',
      'High',
      ['backend'],
      'assignee123',
      'testdomain',
      'test@test.com',
      'token123',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://testdomain.atlassian.net/rest/api/3/issue',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from('test@test.com:token123').toString('base64')}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: expect.stringContaining('"summary":"New Jira Ticket"'),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if create fetch fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      text: async () => 'Invalid project',
    } as Response);

    await expect(
      repository.createTicket(
        'INVALID',
        'Title',
        'Task',
        undefined,
        undefined,
        undefined,
        undefined,
        'domain',
        'email',
        'token',
      ),
    ).rejects.toThrow('Failed to create Jira ticket: Bad Request - Invalid project');
  });

  it('should fetch Jira ticket comments successfully', async () => {
    const mockResponse = { comments: [{ id: 'c1', body: 'Looks good' }], total: 1 };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.getTicketComments('PRJ-123', 'testdomain', 'test@test.com', 'token123');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://testdomain.atlassian.net/rest/api/3/issue/PRJ-123/comment',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: `Basic ${Buffer.from('test@test.com:token123').toString('base64')}`,
          Accept: 'application/json',
        },
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if fetch ticket comments fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Forbidden',
      text: async () => 'Access denied',
    } as Response);

    await expect(
      repository.getTicketComments('PRJ-123', 'testdomain', 'test@test.com', 'token123'),
    ).rejects.toThrow('Failed to fetch Jira ticket comments for PRJ-123: Forbidden - Access denied');
  });
});

