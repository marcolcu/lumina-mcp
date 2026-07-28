import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenProjectRepository } from '../../../../src/tools/projectmanagement/openproject/repository/openproject.repository.js';

describe('OpenProjectRepository', () => {
  let repository: OpenProjectRepository;

  beforeEach(() => {
    repository = new OpenProjectRepository();
    global.fetch = vi.fn();
  });

  it('should fetch OpenProject work package successfully', async () => {
    const mockResponse = { id: 1234, subject: 'My WP' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.getWorkPackage('1234', 'test.domain.com', 'testapikey');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.domain.com/api/v3/work_packages/1234',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Basic YXBpa2V5OnRlc3RhcGlrZXk=', // Base64 of apikey:testapikey
        },
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if fetch fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Unauthorized',
      text: async () => 'Invalid token',
    } as Response);

    await expect(repository.getWorkPackage('999', 'test.domain.com', 'testapikey')).rejects.toThrow(
      'Failed to fetch OpenProject work package 999: Unauthorized - Invalid token',
    );
  });
  it('should create OpenProject work package successfully', async () => {
    const mockResponse = { id: 456, subject: 'New WP' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.createWorkPackage(
      '12',
      'New WP',
      'Task',
      'Description',
      'High',
      'User1',
      'test.domain.com',
      'testapikey',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.domain.com/api/v3/projects/12/work_packages',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Basic YXBpa2V5OnRlc3RhcGlrZXk=', // Base64 of apikey:testapikey
          'Content-Type': 'application/json',
        },
        body: expect.stringContaining('"subject":"New WP"'),
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
      repository.createWorkPackage(
        '999',
        'Subj',
        'Task',
        undefined,
        undefined,
        undefined,
        'domain.com',
        'key',
      ),
    ).rejects.toThrow('Failed to create OpenProject work package: Bad Request - Invalid project');
  });

  it('should add a comment to OpenProject work package successfully', async () => {
    const mockResponse = { id: 789, comment: { raw: 'My comment' } };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.addWorkPackageComment(
      '1234',
      'My comment',
      'test.domain.com',
      'testapikey',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.domain.com/api/v3/work_packages/1234/activities',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: 'Basic YXBpa2V5OnRlc3RhcGlrZXk=', // Base64 of apikey:testapikey
        },
        body: JSON.stringify({ comment: { format: 'markdown', raw: 'My comment' } }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if adding a comment fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
      text: async () => 'Work package not found',
    } as Response);

    await expect(
      repository.addWorkPackageComment('999', 'Comment', 'test.domain.com', 'testapikey'),
    ).rejects.toThrow(
      'Failed to add comment to OpenProject work package 999: Not Found - Work package not found',
    );
  });

  it('should add a time entry successfully', async () => {
    const mockResponse = { id: 55, hours: 'PT2H30M' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.addTimeEntry(
      '1234',
      'PT2H30M',
      '2026-07-28',
      'test.domain.com',
      'testapikey',
      'Worked on the ticket',
      '7',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.domain.com/api/v3/time_entries',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'Basic YXBpa2V5OnRlc3RhcGlrZXk=', // Base64 of apikey:testapikey
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          hours: 'PT2H30M',
          spentOn: '2026-07-28',
          _links: {
            workPackage: { href: '/api/v3/work_packages/1234' },
            activity: { href: '/api/v3/time_entries/activities/7' },
          },
          comment: { format: 'markdown', raw: 'Worked on the ticket' },
        }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should add a time entry without optional comment/activity', async () => {
    const mockResponse = { id: 56 };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    await repository.addTimeEntry('1234', 'PT1H', '2026-07-28', 'test.domain.com', 'testapikey');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.domain.com/api/v3/time_entries',
      expect.objectContaining({
        body: JSON.stringify({
          hours: 'PT1H',
          spentOn: '2026-07-28',
          _links: {
            workPackage: { href: '/api/v3/work_packages/1234' },
          },
        }),
      }),
    );
  });

  it('should throw an error if adding a time entry fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Unprocessable Entity',
      text: async () => 'Invalid activity',
    } as Response);

    await expect(
      repository.addTimeEntry('999', 'PT1H', '2026-07-28', 'test.domain.com', 'testapikey'),
    ).rejects.toThrow(
      'Failed to add time entry to OpenProject work package 999: Unprocessable Entity - Invalid activity',
    );
  });
});
