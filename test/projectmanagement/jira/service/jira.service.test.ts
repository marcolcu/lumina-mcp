import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetTicket, mockCreateTicket, mockGetTicketComments } = vi.hoisted(() => ({
  mockGetTicket: vi.fn(),
  mockCreateTicket: vi.fn(),
  mockGetTicketComments: vi.fn(),
}));

vi.mock('../../../../src/tools/projectmanagement/jira/repository/jira.repository.js', () => ({
  jiraRepository: {
    getTicket: mockGetTicket,
    createTicket: mockCreateTicket,
    getTicketComments: mockGetTicketComments,
  },
}));

import {
  getJiraTicket,
  createJiraTicket,
  getJiraTicketComments,
} from '../../../../src/tools/projectmanagement/jira/service/jira.service.js';

describe('JiraService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.JIRA_DOMAIN;
    delete process.env.JIRA_EMAIL;
    delete process.env.JIRA_API_TOKEN;
  });

  it('should call repository when arguments are valid', async () => {
    mockGetTicket.mockResolvedValueOnce({ key: 'PRJ-1' });

    const result = await getJiraTicket('PRJ-1', 'mydomain', 'myemail', 'mytoken');

    expect(mockGetTicket).toHaveBeenCalledWith('PRJ-1', 'mydomain', 'myemail', 'mytoken');
    expect(result).toEqual({ key: 'PRJ-1' });
  });

  it('should fallback to env variables if arguments are omitted', async () => {
    process.env.JIRA_DOMAIN = 'envdomain';
    process.env.JIRA_EMAIL = 'envemail';
    process.env.JIRA_API_TOKEN = 'envtoken';

    mockGetTicket.mockResolvedValueOnce({ key: 'PRJ-2' });

    await getJiraTicket('PRJ-2');

    expect(mockGetTicket).toHaveBeenCalledWith('PRJ-2', 'envdomain', 'envemail', 'envtoken');
  });

  it('should throw error if domain is missing', async () => {
    await expect(getJiraTicket('PRJ-3', undefined, 'myemail', 'mytoken')).rejects.toThrow(
      'Jira domain is required',
    );
  });

  it('should throw error if email or token is missing', async () => {
    await expect(getJiraTicket('PRJ-4', 'mydomain', undefined, 'mytoken')).rejects.toThrow(
      'Jira email and apiToken are required',
    );
  });
  describe('createJiraTicket', () => {
    it('should call repository.createTicket when arguments are valid', async () => {
      mockCreateTicket.mockResolvedValueOnce({ key: 'PRJ-10' });

      const result = await createJiraTicket(
        'PRJ',
        'Title',
        'Task',
        'Desc',
        'High',
        ['bug'],
        'assignee',
        undefined,
        'mydomain',
        'myemail',
        'mytoken',
      );

      expect(mockCreateTicket).toHaveBeenCalledWith(
        'PRJ',
        'Title',
        'Task',
        'Desc',
        'High',
        ['bug'],
        'assignee',
        'mydomain',
        'myemail',
        'mytoken',
      );
      expect(result).toEqual({ key: 'PRJ-10' });
    });

    it('should fallback to env variables if domain/email/token are omitted', async () => {
      process.env.JIRA_DOMAIN = 'envdomain';
      process.env.JIRA_EMAIL = 'envemail';
      process.env.JIRA_API_TOKEN = 'envtoken';
      mockCreateTicket.mockResolvedValueOnce({ key: 'PRJ-11' });

      await createJiraTicket('PRJ', 'Title', 'Task');

      expect(mockCreateTicket).toHaveBeenCalledWith(
        'PRJ',
        'Title',
        'Task',
        undefined,
        undefined,
        undefined,
        undefined,
        'envdomain',
        'envemail',
        'envtoken',
      );
    });

    it('should throw error if projectKey, summary, or issueType are missing', async () => {
      process.env.JIRA_DOMAIN = 'envdomain';
      process.env.JIRA_EMAIL = 'envemail';
      process.env.JIRA_API_TOKEN = 'envtoken';
      await expect(createJiraTicket('', 'Title', 'Task')).rejects.toThrow(
        'Jira projectKey, summary, and issueType are required to create a ticket.',
      );
      await expect(createJiraTicket('PRJ', '', 'Task')).rejects.toThrow(
        'Jira projectKey, summary, and issueType are required to create a ticket.',
      );
      await expect(createJiraTicket('PRJ', 'Title', '')).rejects.toThrow(
        'Jira projectKey, summary, and issueType are required to create a ticket.',
      );
    });
  });

  describe('getJiraTicketComments', () => {
    it('should call repository.getTicketComments when arguments are valid', async () => {
      mockGetTicketComments.mockResolvedValueOnce({ comments: [] });

      const result = await getJiraTicketComments('PRJ-1', 'mydomain', 'myemail', 'mytoken', 0, 10);

      expect(mockGetTicketComments).toHaveBeenCalledWith(
        'PRJ-1',
        'mydomain',
        'myemail',
        'mytoken',
        0,
        10,
      );
      expect(result).toEqual({ comments: [] });
    });

    it('should throw error if domain is missing', async () => {
      await expect(
        getJiraTicketComments('PRJ-1', undefined, 'myemail', 'mytoken'),
      ).rejects.toThrow('Jira domain is required');
    });
  });
});
