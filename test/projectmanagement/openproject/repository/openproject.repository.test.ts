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

  it('should fetch OpenProject work package comments successfully', async () => {
    const mockResponse = { _embedded: { elements: [{ id: 1, comment: { raw: 'Test comment' } }] } };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.getWorkPackageComments('1234', 'test.domain.com', 'testapikey');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://test.domain.com/api/v3/work_packages/1234/activities',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Basic YXBpa2V5OnRlc3RhcGlrZXk=',
        },
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if fetch work package comments fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
      text: async () => 'Work package not found',
    } as Response);

    await expect(
      repository.getWorkPackageComments('999', 'test.domain.com', 'testapikey'),
    ).rejects.toThrow('Failed to fetch OpenProject work package comments for 999: Not Found - Work package not found');
  });
});

