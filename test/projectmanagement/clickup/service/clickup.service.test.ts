import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockListTasks,
  mockGetTask,
  mockGetTaskComments,
  mockCreateComment,
  mockUpdateComment,
  mockDeleteComment,
} = vi.hoisted(() => ({
  mockListTasks: vi.fn(),
  mockGetTask: vi.fn(),
  mockGetTaskComments: vi.fn(),
  mockCreateComment: vi.fn(),
  mockUpdateComment: vi.fn(),
  mockDeleteComment: vi.fn(),
}));

vi.mock('../../../../src/tools/projectmanagement/clickup/repository/clickup.repository.js', () => ({
  clickupRepository: {
    listTasks: mockListTasks,
    getTask: mockGetTask,
    getTaskComments: mockGetTaskComments,
    createComment: mockCreateComment,
    updateComment: mockUpdateComment,
    deleteComment: mockDeleteComment,
  },
}));

import {
  listClickupTasks,
  getClickupTask,
  getClickupTaskComments,
  createClickupComment,
  updateClickupComment,
  deleteClickupComment,
} from '../../../../src/tools/projectmanagement/clickup/service/clickup.service.js';

describe('ClickupService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CLICKUP_API_TOKEN;
  });

  describe('listClickupTasks', () => {
    it('should call repository and return a summarized array when arguments are valid', async () => {
      mockListTasks.mockResolvedValueOnce({
        tasks: [
          {
            id: 't1',
            name: 'Task 1',
            status: { status: 'open' },
            assignees: [{ username: 'alice' }],
            url: 'https://app.clickup.com/t/t1',
            due_date: '123456',
          },
        ],
      });

      const result = await listClickupTasks('list1', undefined, 'mytoken');

      expect(mockListTasks).toHaveBeenCalledWith('list1', 'mytoken', {
        statuses: undefined,
        assignees: undefined,
        tags: undefined,
        dueDateGt: undefined,
        dueDateLt: undefined,
      });
      expect(result).toEqual([
        {
          id: 't1',
          name: 'Task 1',
          status: 'open',
          assignee: 'alice',
          url: 'https://app.clickup.com/t/t1',
          due_date: '123456',
        },
      ]);
    });

    it('should translate filter fields into repository filters', async () => {
      mockListTasks.mockResolvedValueOnce({ tasks: [] });

      await listClickupTasks(
        'list1',
        { status: 'open', assignee: '5', tag: 'urgent', dueDateFrom: '100', dueDateTo: '200' },
        'mytoken',
      );

      expect(mockListTasks).toHaveBeenCalledWith('list1', 'mytoken', {
        statuses: ['open'],
        assignees: ['5'],
        tags: ['urgent'],
        dueDateGt: 100,
        dueDateLt: 200,
      });
    });

    it('should fallback to CLICKUP_API_TOKEN env var if apiToken is omitted', async () => {
      process.env.CLICKUP_API_TOKEN = 'envtoken';
      mockListTasks.mockResolvedValueOnce({ tasks: [] });

      await listClickupTasks('list1');

      expect(mockListTasks).toHaveBeenCalledWith('list1', 'envtoken', expect.any(Object));
    });

    it('should throw error if listId is missing', async () => {
      await expect(listClickupTasks('', undefined, 'mytoken')).rejects.toThrow(
        'ClickUp listId is required to list tasks.',
      );
    });

    it('should throw error if apiToken is missing', async () => {
      await expect(listClickupTasks('list1', undefined, undefined)).rejects.toThrow(
        'ClickUp apiToken is required. Provide it as an argument or set CLICKUP_API_TOKEN.',
      );
    });
  });

  describe('getClickupTask', () => {
    it('should call repository when arguments are valid', async () => {
      mockGetTask.mockResolvedValueOnce({ id: 'task1' });

      const result = await getClickupTask('task1', 'mytoken');

      expect(mockGetTask).toHaveBeenCalledWith('task1', 'mytoken');
      expect(result).toEqual({ id: 'task1' });
    });

    it('should throw error if taskId is missing', async () => {
      await expect(getClickupTask('', 'mytoken')).rejects.toThrow(
        'ClickUp taskId is required to fetch a task.',
      );
    });

    it('should throw error if apiToken is missing', async () => {
      await expect(getClickupTask('task1', undefined)).rejects.toThrow(
        'ClickUp apiToken is required. Provide it as an argument or set CLICKUP_API_TOKEN.',
      );
    });
  });

  describe('getClickupTaskComments', () => {
    it('should call repository and summarize comments', async () => {
      mockGetTaskComments.mockResolvedValueOnce({
        comments: [
          {
            id: 'c1',
            comment_text: 'hello',
            user: { username: 'bob' },
            date: '111',
            resolved: true,
          },
        ],
      });

      const result = await getClickupTaskComments('task1', 'mytoken');

      expect(mockGetTaskComments).toHaveBeenCalledWith('task1', 'mytoken');
      expect(result).toEqual([
        { id: 'c1', comment_text: 'hello', user: 'bob', date: '111', resolved: true },
      ]);
    });

    it('should throw error if taskId is missing', async () => {
      await expect(getClickupTaskComments('', 'mytoken')).rejects.toThrow(
        'ClickUp taskId is required to fetch comments.',
      );
    });
  });

  describe('createClickupComment', () => {
    it('should call repository and return id/url', async () => {
      mockCreateComment.mockResolvedValueOnce({ id: 'c1' });

      const result = await createClickupComment('task1', 'hi there', 5, true, 'mytoken');

      expect(mockCreateComment).toHaveBeenCalledWith('task1', 'hi there', 'mytoken', 5, true);
      expect(result).toEqual({ id: 'c1', url: 'https://app.clickup.com/t/task1?comment=c1' });
    });

    it('should throw error if taskId or commentText are missing', async () => {
      await expect(createClickupComment('', 'hi', undefined, undefined, 'mytoken')).rejects.toThrow(
        'ClickUp taskId and commentText are required to create a comment.',
      );
      await expect(createClickupComment('task1', '', undefined, undefined, 'mytoken')).rejects.toThrow(
        'ClickUp taskId and commentText are required to create a comment.',
      );
    });
  });

  describe('updateClickupComment', () => {
    it('should call repository and return confirmation', async () => {
      mockUpdateComment.mockResolvedValueOnce({ id: 'c1' });

      const result = await updateClickupComment('c1', 'updated', 'mytoken');

      expect(mockUpdateComment).toHaveBeenCalledWith('c1', 'updated', 'mytoken');
      expect(result).toEqual({ id: 'c1', comment_text: 'updated', updated: true });
    });

    it('should throw error if commentId or commentText are missing', async () => {
      await expect(updateClickupComment('', 'text', 'mytoken')).rejects.toThrow(
        'ClickUp commentId and commentText are required to update a comment.',
      );
      await expect(updateClickupComment('c1', '', 'mytoken')).rejects.toThrow(
        'ClickUp commentId and commentText are required to update a comment.',
      );
    });
  });

  describe('deleteClickupComment', () => {
    it('should call repository and return confirmation', async () => {
      mockDeleteComment.mockResolvedValueOnce({});

      const result = await deleteClickupComment('c1', 'mytoken');

      expect(mockDeleteComment).toHaveBeenCalledWith('c1', 'mytoken');
      expect(result).toEqual({ id: 'c1', deleted: true });
    });

    it('should throw error if commentId is missing', async () => {
      await expect(deleteClickupComment('', 'mytoken')).rejects.toThrow(
        'ClickUp commentId is required to delete a comment.',
      );
    });
  });
});
