import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGetCard, mockCreateCard, mockAddComment, mockAttachFileToCard } = vi.hoisted(() => ({
  mockGetCard: vi.fn(),
  mockCreateCard: vi.fn(),
  mockAddComment: vi.fn(),
  mockAttachFileToCard: vi.fn(),
}));

vi.mock('../../../../src/tools/projectmanagement/trello/repository/trello.repository.js', () => ({
  trelloRepository: {
    getCard: mockGetCard,
    createCard: mockCreateCard,
    addComment: mockAddComment,
    attachFileToCard: mockAttachFileToCard,
  },
}));

import {
  getTrelloCard,
  createTrelloCard,
  addTrelloComment,
  addTrelloAttachment,
} from '../../../../src/tools/projectmanagement/trello/service/trello.service.js';

describe('TrelloService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TRELLO_API_KEY;
    delete process.env.TRELLO_API_TOKEN;
  });

  it('should call repository when arguments are valid', async () => {
    mockGetCard.mockResolvedValueOnce({ id: 'card1' });

    const result = await getTrelloCard('card1', 'mykey', 'mytoken');

    expect(mockGetCard).toHaveBeenCalledWith('card1', 'mykey', 'mytoken');
    expect(result).toEqual({ id: 'card1' });
  });

  it('should fallback to env variables if arguments are omitted', async () => {
    process.env.TRELLO_API_KEY = 'envkey';
    process.env.TRELLO_API_TOKEN = 'envtoken';

    mockGetCard.mockResolvedValueOnce({ id: 'card2' });

    await getTrelloCard('card2');

    expect(mockGetCard).toHaveBeenCalledWith('card2', 'envkey', 'envtoken');
  });

  it('should throw error if key or token is missing', async () => {
    await expect(getTrelloCard('card3', 'mykey', undefined)).rejects.toThrow(
      'Trello apiKey and apiToken are required',
    );
  });
  describe('createTrelloCard', () => {
    it('should call repository.createCard when arguments are valid', async () => {
      mockCreateCard.mockResolvedValueOnce({ id: 'card10' });

      const result = await createTrelloCard(
        'list',
        'Name',
        'Desc',
        'top',
        '2026-12-31',
        'lbl1',
        'mem1',
        'mykey',
        'mytoken',
      );

      expect(mockCreateCard).toHaveBeenCalledWith(
        'list',
        'Name',
        'Desc',
        'top',
        '2026-12-31',
        'lbl1',
        'mem1',
        'mykey',
        'mytoken',
      );
      expect(result).toEqual({ id: 'card10' });
    });

    it('should fallback to env variables if key/token are omitted', async () => {
      process.env.TRELLO_API_KEY = 'envkey';
      process.env.TRELLO_API_TOKEN = 'envtoken';
      mockCreateCard.mockResolvedValueOnce({ id: 'card11' });

      await createTrelloCard('list', 'Name');

      expect(mockCreateCard).toHaveBeenCalledWith(
        'list',
        'Name',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'envkey',
        'envtoken',
      );
    });

    it('should throw error if idList or name are missing', async () => {
      process.env.TRELLO_API_KEY = 'envkey';
      process.env.TRELLO_API_TOKEN = 'envtoken';
      await expect(createTrelloCard('', 'Name')).rejects.toThrow(
        'Trello idList and name are required to create a card.',
      );
      await expect(createTrelloCard('list', '')).rejects.toThrow(
        'Trello idList and name are required to create a card.',
      );
    });
  });

  describe('addTrelloComment', () => {
    it('should call repository.addComment when arguments are valid', async () => {
      mockAddComment.mockResolvedValueOnce({ id: 'act1' });

      const result = await addTrelloComment('card1', 'PASS: verified', 'mykey', 'mytoken');

      expect(mockAddComment).toHaveBeenCalledWith('card1', 'PASS: verified', 'mykey', 'mytoken');
      expect(result).toEqual({ id: 'act1' });
    });

    it('should fallback to env variables if key/token are omitted', async () => {
      process.env.TRELLO_API_KEY = 'envkey';
      process.env.TRELLO_API_TOKEN = 'envtoken';
      mockAddComment.mockResolvedValueOnce({ id: 'act2' });

      await addTrelloComment('card1', 'FAILED: step 2');

      expect(mockAddComment).toHaveBeenCalledWith('card1', 'FAILED: step 2', 'envkey', 'envtoken');
    });

    it('should throw error if cardId or text is missing', async () => {
      await expect(addTrelloComment('', 'text', 'key', 'token')).rejects.toThrow(
        'Trello cardId and text are required to add a comment.',
      );
      await expect(addTrelloComment('card1', '', 'key', 'token')).rejects.toThrow(
        'Trello cardId and text are required to add a comment.',
      );
    });

    it('should throw error if key or token is missing', async () => {
      await expect(addTrelloComment('card1', 'text', 'key', undefined)).rejects.toThrow(
        'Trello apiKey and apiToken are required',
      );
    });
  });

  describe('addTrelloAttachment', () => {
    it('should call repository.attachFileToCard when arguments are valid', async () => {
      mockAttachFileToCard.mockResolvedValueOnce({ id: 'att1' });

      const result = await addTrelloAttachment('card1', '/tmp/failure.png', 'mykey', 'mytoken');

      expect(mockAttachFileToCard).toHaveBeenCalledWith(
        'card1',
        '/tmp/failure.png',
        'mykey',
        'mytoken',
      );
      expect(result).toEqual({ id: 'att1' });
    });

    it('should throw error if cardId or filePath is missing', async () => {
      await expect(addTrelloAttachment('', '/tmp/x.png', 'key', 'token')).rejects.toThrow(
        'Trello cardId and filePath are required to add an attachment.',
      );
      await expect(addTrelloAttachment('card1', '', 'key', 'token')).rejects.toThrow(
        'Trello cardId and filePath are required to add an attachment.',
      );
    });

    it('should throw error if key or token is missing', async () => {
      await expect(addTrelloAttachment('card1', '/tmp/x.png', 'key', undefined)).rejects.toThrow(
        'Trello apiKey and apiToken are required',
      );
    });
  });
});
