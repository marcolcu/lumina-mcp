import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFile } = vi.hoisted(() => ({ mockReadFile: vi.fn() }));
vi.mock('fs/promises', () => ({ readFile: mockReadFile }));

import { TrelloRepository } from '../../../../src/tools/projectmanagement/trello/repository/trello.repository.js';

describe('TrelloRepository', () => {
  let repository: TrelloRepository;

  beforeEach(() => {
    repository = new TrelloRepository();
    global.fetch = vi.fn();
  });

  it('should fetch Trello card successfully', async () => {
    const mockResponse = { id: 'abc1234', name: 'My Card' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.getCard('abc1234', 'testkey', 'testtoken');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.trello.com/1/cards/abc1234',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'OAuth oauth_consumer_key="testkey", oauth_token="testtoken"',
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

    await expect(repository.getCard('xyz999', 'testkey', 'testtoken')).rejects.toThrow(
      'Failed to fetch Trello card xyz999: Unauthorized - Invalid token',
    );
  });
  it('should create Trello card successfully', async () => {
    const mockResponse = { id: '456', name: 'New Card' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.createCard(
      'list123',
      'New Card',
      'Card Desc',
      'top',
      '2026-12-31',
      'label1',
      'member1',
      'testkey',
      'testtoken',
    );

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.trello.com/1/cards?'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'OAuth oauth_consumer_key="testkey", oauth_token="testtoken"',
        },
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if create fetch fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      text: async () => 'Invalid list',
    } as Response);

    await expect(
      repository.createCard(
        'INVALID',
        'Name',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'key',
        'token',
      ),
    ).rejects.toThrow('Failed to create Trello card: Bad Request - Invalid list');
  });

  it('should add a comment to a Trello card successfully', async () => {
    const mockResponse = { id: 'act1', data: { text: 'PASS: verified' } };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.addComment('abc1234', 'PASS: verified', 'testkey', 'testtoken');

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://api.trello.com/1/cards/abc1234/actions/comments?'),
      expect.objectContaining({
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: 'OAuth oauth_consumer_key="testkey", oauth_token="testtoken"',
        },
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if adding a comment fails', async () => {
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Unauthorized',
      text: async () => 'Invalid token',
    } as Response);

    await expect(
      repository.addComment('abc1234', 'FAILED: step 2', 'testkey', 'testtoken'),
    ).rejects.toThrow('Failed to add comment to Trello card abc1234: Unauthorized - Invalid token');
  });

  it('should attach a file to a Trello card successfully', async () => {
    mockReadFile.mockResolvedValueOnce(Buffer.from('fake-image-bytes'));
    const mockResponse = { id: 'att1', name: 'failure.png' };
    vi.mocked(global.fetch).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await repository.attachFileToCard(
      'abc1234',
      '/tmp/failure.png',
      'testkey',
      'testtoken',
    );

    expect(mockReadFile).toHaveBeenCalledWith('/tmp/failure.png');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.trello.com/1/cards/abc1234/attachments',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toEqual(mockResponse);
  });

  it('should throw an error if attaching a file fails', async () => {
    mockReadFile.mockResolvedValueOnce(Buffer.from('fake-image-bytes'));
    vi.mocked(global.fetch).mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      text: async () => 'Invalid file',
    } as Response);

    await expect(
      repository.attachFileToCard('abc1234', '/tmp/failure.png', 'testkey', 'testtoken'),
    ).rejects.toThrow('Failed to attach file to Trello card abc1234: Bad Request - Invalid file');
  });
});
