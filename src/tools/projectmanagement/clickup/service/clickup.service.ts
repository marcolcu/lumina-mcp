import { clickupRepository } from '../repository/clickup.repository.js';

interface ClickupTaskSummary {
  id: unknown;
  name: unknown;
  status: unknown;
  assignee: unknown;
  url: unknown;
  due_date: unknown;
}

interface ClickupCommentSummary {
  id: unknown;
  comment_text: unknown;
  user: unknown;
  date: unknown;
  resolved: unknown;
}

function resolveApiToken(apiToken?: string): string {
  const finalToken = apiToken || process.env.CLICKUP_API_TOKEN;

  if (!finalToken) {
    throw new Error('ClickUp apiToken is required. Provide it as an argument or set CLICKUP_API_TOKEN.');
  }

  return finalToken;
}

function toTaskSummary(task: Record<string, unknown>): ClickupTaskSummary {
  const status = task.status as Record<string, unknown> | undefined;
  const assignees = task.assignees as Array<Record<string, unknown>> | undefined;

  return {
    id: task.id,
    name: task.name,
    status: status?.status ?? status,
    assignee: assignees?.length
      ? assignees.map((a) => a.username ?? a.email ?? a.id).join(', ')
      : undefined,
    url: task.url,
    due_date: task.due_date,
  };
}

function toCommentSummary(comment: Record<string, unknown>): ClickupCommentSummary {
  const user = comment.user as Record<string, unknown> | undefined;

  return {
    id: comment.id,
    comment_text: comment.comment_text,
    user: user?.username ?? user?.email ?? user,
    date: comment.date,
    resolved: comment.resolved ?? false,
  };
}

export interface ClickupTaskFilter {
  status?: string;
  assignee?: string;
  tag?: string;
  dueDateFrom?: string;
  dueDateTo?: string;
}

export async function listClickupTasks(
  listId: string,
  filter?: ClickupTaskFilter,
  apiToken?: string,
): Promise<ClickupTaskSummary[]> {
  const finalApiToken = resolveApiToken(apiToken);

  if (!listId) {
    throw new Error('ClickUp listId is required to list tasks.');
  }

  const raw = (await clickupRepository.listTasks(listId, finalApiToken, {
    statuses: filter?.status ? [filter.status] : undefined,
    assignees: filter?.assignee ? [filter.assignee] : undefined,
    tags: filter?.tag ? [filter.tag] : undefined,
    dueDateGt: filter?.dueDateFrom ? Number(filter.dueDateFrom) : undefined,
    dueDateLt: filter?.dueDateTo ? Number(filter.dueDateTo) : undefined,
  })) as { tasks?: Array<Record<string, unknown>> };

  return (raw.tasks ?? []).map(toTaskSummary);
}

export async function getClickupTask(taskId: string, apiToken?: string): Promise<unknown> {
  const finalApiToken = resolveApiToken(apiToken);

  if (!taskId) {
    throw new Error('ClickUp taskId is required to fetch a task.');
  }

  return clickupRepository.getTask(taskId, finalApiToken);
}

export async function getClickupTaskComments(
  taskId: string,
  apiToken?: string,
): Promise<ClickupCommentSummary[]> {
  const finalApiToken = resolveApiToken(apiToken);

  if (!taskId) {
    throw new Error('ClickUp taskId is required to fetch comments.');
  }

  const raw = (await clickupRepository.getTaskComments(taskId, finalApiToken)) as {
    comments?: Array<Record<string, unknown>>;
  };

  return (raw.comments ?? []).map(toCommentSummary);
}

export async function createClickupComment(
  taskId: string,
  commentText: string,
  assignee?: number,
  notifyAll?: boolean,
  apiToken?: string,
): Promise<unknown> {
  const finalApiToken = resolveApiToken(apiToken);

  if (!taskId || !commentText) {
    throw new Error('ClickUp taskId and commentText are required to create a comment.');
  }

  const created = (await clickupRepository.createComment(
    taskId,
    commentText,
    finalApiToken,
    assignee,
    notifyAll,
  )) as { id?: string };

  return {
    id: created.id,
    url: created.id ? `https://app.clickup.com/t/${taskId}?comment=${created.id}` : undefined,
  };
}

export async function updateClickupComment(
  commentId: string,
  commentText: string,
  apiToken?: string,
): Promise<unknown> {
  const finalApiToken = resolveApiToken(apiToken);

  if (!commentId || !commentText) {
    throw new Error('ClickUp commentId and commentText are required to update a comment.');
  }

  await clickupRepository.updateComment(commentId, commentText, finalApiToken);

  return { id: commentId, comment_text: commentText, updated: true };
}

export async function deleteClickupComment(commentId: string, apiToken?: string): Promise<unknown> {
  const finalApiToken = resolveApiToken(apiToken);

  if (!commentId) {
    throw new Error('ClickUp commentId is required to delete a comment.');
  }

  await clickupRepository.deleteComment(commentId, finalApiToken);

  return { id: commentId, deleted: true };
}
