import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  listClickupTasks,
  getClickupTask,
  getClickupTaskComments,
  createClickupComment,
  updateClickupComment,
  deleteClickupComment,
} from '../clickup/service/clickup.service.js';
import {
  getJiraTicket,
  createJiraTicket,
  getJiraTicketComments,
  addJiraComment,
} from '../jira/service/jira.service.js';
import {
  getTrelloCard,
  createTrelloCard,
  addTrelloComment,
  addTrelloAttachment,
} from '../trello/service/trello.service.js';
import {
  getOpenProjectWorkPackage,
  createOpenProjectWorkPackage,
  getOpenProjectWorkPackageComments,
  addOpenProjectWorkPackageComment,
} from '../openproject/service/openproject.service.js';
import {
  getGithubIssue,
  createGithubIssue,
  addGithubIssueComment,
} from '../github/service/github.service.js';
import {
  GetJiraTicketSchema,
  GetJiraTicketCommentsSchema,
  CreateJiraTicketSchema,
  AddJiraCommentSchema,
  GetTrelloCardSchema,
  CreateTrelloCardSchema,
  AddTrelloCommentSchema,
  AddTrelloAttachmentSchema,
  GetOpenProjectWorkPackageSchema,
  GetMyOpenProjectWorkPackagesSchema,
  AddOpenProjectTimeEntrySchema,
  ListClickupTasksSchema,
  GetClickupTaskSchema,
  GetClickupTaskCommentsSchema,
  CreateClickupCommentSchema,
  UpdateClickupCommentSchema,
  DeleteClickupCommentSchema,
  GetOpenProjectWorkPackageCommentsSchema,
  CreateOpenProjectWorkPackageSchema,
  AddOpenProjectWorkPackageCommentSchema,
  GetGithubIssueSchema,
  CreateGithubIssueSchema,
  AddGithubIssueCommentSchema,
  ProjectManagementPromptSchema,
  PmTestingTicketPromptSchema,
} from '../dto/projectmanagement.dto.js';
import {
  PM_SUMMARIZE_TICKET_PROMPT,
  PM_BRAINSTORM_PLAN_PROMPT,
  PM_TEST_CATALOG_PROMPT,
  PM_CREATE_TICKET_PROMPT,
  PM_DEV_CHECK_COMMENT_PROMPT,
  PM_TESTING_TICKET_PROMPT,
} from '../prompts/index.js';

const JIRA_FALLBACK_INSTRUCTIONS = `
FALLBACK REQUIRED — Lumina MCP could not authenticate with Jira.
Follow this strict fallback order:
1. PRIMARY: Retry providing 'domain', 'email', and 'apiToken' parameters directly to 'get_jira_ticket', or set JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN environment variables in your MCP client config.
2. SECONDARY: If you have the official Atlassian MCP server ('atlassian' or 'jira') registered in your client environment, call the equivalent Jira tool from it directly instead (e.g., jira.get_issue).
3. TERTIARY: Ask the user to provide the ticket contents manually (copy-paste the Jira ticket into the conversation).
Do NOT report failure to the user — always attempt the next fallback step.
`;

const TRELLO_FALLBACK_INSTRUCTIONS = `
FALLBACK REQUIRED — Lumina MCP could not authenticate with Trello.
Follow this strict fallback order:
1. PRIMARY: Retry providing 'apiKey' and 'apiToken' parameters directly to 'get_trello_card', or set TRELLO_API_KEY and TRELLO_API_TOKEN environment variables in your MCP client config.
2. SECONDARY: If you have an official Trello or Atlassian MCP server registered in your client environment, call the equivalent tool from it instead.
3. TERTIARY: Ask the user to provide the Trello card contents manually (copy-paste into the conversation).
Do NOT report failure to the user — always attempt the next fallback step.
`;

const OPENPROJECT_FALLBACK_INSTRUCTIONS = `
FALLBACK REQUIRED — Lumina MCP could not authenticate with OpenProject.
Follow this strict fallback order:
1. PRIMARY: Retry providing 'domain' and 'apiKey' parameters directly to 'get_openproject_work_package', or set OPENPROJECT_DOMAIN and OPENPROJECT_API_KEY environment variables in your MCP client config.
2. SECONDARY: If you have an official OpenProject MCP server registered in your client environment, call the equivalent tool from it instead.
3. TERTIARY: Ask the user to provide the work package contents manually (copy-paste into the conversation).
Do NOT report failure to the user — always attempt the next fallback step.
`;

const GITHUB_FALLBACK_INSTRUCTIONS = `
FALLBACK REQUIRED — Lumina MCP could not authenticate with GitHub.
Follow this strict fallback order:
1. PRIMARY: Retry providing 'githubToken' parameter directly to 'get_github_issue', or set GITHUB_TOKEN environment variable in your MCP client config.
2. SECONDARY: If you have the official GitHub MCP server registered in your client environment, call the equivalent tool from it instead.
3. TERTIARY: Ask the user to provide the issue contents manually (copy-paste into the conversation).
Do NOT report failure to the user — always attempt the next fallback step.
`;

const CLICKUP_FALLBACK_INSTRUCTIONS = `
FALLBACK REQUIRED — Lumina MCP could not authenticate with ClickUp.
Follow this strict fallback order:
1. PRIMARY: Retry providing the 'apiToken' parameter directly to the ClickUp tool, or set CLICKUP_API_TOKEN environment variable in your MCP client config.
2. SECONDARY: If you have an official ClickUp MCP server registered in your client environment, call the equivalent tool from it instead.
3. TERTIARY: Ask the user to provide the ClickUp task/comment contents manually (copy-paste into the conversation).
Do NOT report failure to the user — always attempt the next fallback step.
`;

export function registerProjectManagementController(server: McpServer) {
  // Tools
  server.registerTool(
    'get_jira_ticket',
    {
      description:
        'Fetch a Jira ticket/issue by its ID or Key. Credentials can be passed as parameters or auto-loaded from JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN env vars. Falls back to official Atlassian MCP if credentials are not available.',
      inputSchema: GetJiraTicketSchema,
    },
    async ({ issueIdOrKey, domain, email, apiToken }) => {
      try {
        const ticket = await getJiraTicket(issueIdOrKey, domain, email, apiToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(ticket, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Jira Tool Error: ${errorMessage}\n\n${JIRA_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_jira_ticket_comments',
    {
      description:
        'Fetch comments and activity history for a Jira ticket/issue by its ID or Key. Credentials can be passed as parameters or auto-loaded from JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN env vars.',
      inputSchema: GetJiraTicketCommentsSchema,
    },
    async ({ issueIdOrKey, domain, email, apiToken, startAt, maxResults }) => {
      try {
        const comments = await getJiraTicketComments(
          issueIdOrKey,
          domain,
          email,
          apiToken,
          startAt,
          maxResults,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(comments, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Jira Tool Error: ${errorMessage}\n\n${JIRA_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_trello_card',
    {
      description:
        'Fetch a Trello card by its ID or shortlink. Credentials can be passed as parameters or auto-loaded from TRELLO_API_KEY and TRELLO_API_TOKEN env vars. Falls back to official Atlassian/Trello MCP if credentials are not available.',
      inputSchema: GetTrelloCardSchema,
    },
    async ({ cardId, apiKey, apiToken }) => {
      try {
        const card = await getTrelloCard(cardId, apiKey, apiToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(card, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Trello Tool Error: ${errorMessage}\n\n${TRELLO_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_openproject_work_package',
    {
      description:
        'Fetch an OpenProject work package by its ID. Credentials can be passed as parameters or auto-loaded from OPENPROJECT_DOMAIN and OPENPROJECT_API_KEY env vars. Falls back to official OpenProject MCP if credentials are not available.',
      inputSchema: GetOpenProjectWorkPackageSchema,
    },
    async ({ workPackageId, domain, apiKey }) => {
      try {
        const wp = await getOpenProjectWorkPackage(workPackageId, domain, apiKey);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(wp, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `OpenProject Tool Error: ${errorMessage}\n\n${OPENPROJECT_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_openproject_work_package_comments',
    {
      description:
        'Fetch comments, reviews, and activity history for an OpenProject work package by its ID. Credentials can be passed as parameters or auto-loaded from OPENPROJECT_DOMAIN and OPENPROJECT_API_KEY env vars.',
      inputSchema: GetOpenProjectWorkPackageCommentsSchema,
    },
    async ({ workPackageId, domain, apiKey, offset, pageSize }) => {
      try {
        const comments = await getOpenProjectWorkPackageComments(
          workPackageId,
          domain,
          apiKey,
          offset,
          pageSize,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(comments, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `OpenProject Tool Error: ${errorMessage}\n\n${OPENPROJECT_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_github_issue',
    {
      description:
        'Use when work references a specific GitHub issue and you need its authoritative body, comments, labels, milestone, or linked PRs before planning or coding. Prefer this over searching local files for copied issue text.',
      inputSchema: GetGithubIssueSchema,
    },
    async ({ owner, repo, issueNumber, githubToken }) => {
      try {
        const issue = await getGithubIssue(owner, repo, issueNumber, githubToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(issue, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'get_github_issue',
    {
      description:
        'Fetch a GitHub issue with enriched context by repository owner, name, and issue number. Returns structured data including issue details, comments, labels, assignees, milestone, and linked pull requests. Fetches comments and timeline events in parallel for performance. Credentials can be passed as parameters or auto-loaded from GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN env vars. Falls back to official GitHub MCP if credentials are not available.',
      inputSchema: GetGithubIssueSchema,
    },
    async ({ owner, repo, issueNumber, githubToken }) => {
      try {
        const issue = await getGithubIssue(owner, repo, issueNumber, githubToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(issue, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );
  server.registerTool(
    'create_jira_ticket',
    {
      description:
        'Create a Jira ticket/issue with optional multiple file or image attachments. Compatible with Compound Engineering (ce-plan, ce-work, ce-code-review) tracker-defer system as a ticket creation sink. Credentials can be passed as parameters or auto-loaded from JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN env vars. Falls back to official Atlassian MCP if credentials are not available.',
      inputSchema: CreateJiraTicketSchema,
    },
    async ({
      projectKey,
      summary,
      issueType,
      description,
      priority,
      labels,
      assigneeAccountId,
      attachmentPaths,
      domain,
      email,
      apiToken,
    }) => {
      try {
        const ticket = await createJiraTicket(
          projectKey,
          summary,
          issueType,
          description,
          priority,
          labels,
          assigneeAccountId,
          attachmentPaths,
          domain,
          email,
          apiToken,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(ticket, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Jira Tool Error: ${errorMessage}\n\n${JIRA_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'create_trello_card',
    {
      description:
        'Create a Trello card with optional multiple file or image attachments. Compatible with Compound Engineering (ce-plan, ce-work, ce-code-review) tracker-defer system as a ticket creation sink. Credentials can be passed as parameters or auto-loaded from TRELLO_API_KEY and TRELLO_API_TOKEN env vars. Falls back to official Atlassian/Trello MCP if credentials are not available.',
      inputSchema: CreateTrelloCardSchema,
    },
    async ({ idList, name, desc, pos, due, idLabels, idMembers, attachmentPaths, apiKey, apiToken }) => {
      try {
        const card = await createTrelloCard(
          idList,
          name,
          desc,
          pos,
          due,
          idLabels,
          idMembers,
          apiKey,
          apiToken,
          attachmentPaths,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(card, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Trello Tool Error: ${errorMessage}\n\n${TRELLO_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'create_openproject_work_package',
    {
      description:
        'Create an OpenProject work package with optional multiple attachments, including screenshots or AI-generated images saved as local files. Credentials can be passed as parameters or auto-loaded from OPENPROJECT_DOMAIN and OPENPROJECT_API_KEY env vars. Falls back to official OpenProject MCP if credentials are not available.',
      inputSchema: CreateOpenProjectWorkPackageSchema,
    },
    async ({
      projectId,
      subject,
      type,
      description,
      priority,
      assignee,
      attachmentPaths,
      domain,
      apiKey,
    }) => {
      try {
        const wp = await createOpenProjectWorkPackage(
          projectId,
          subject,
          type,
          description,
          priority,
          assignee,
          attachmentPaths,
          domain,
          apiKey,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(wp, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `OpenProject Tool Error: ${errorMessage}\n\n${OPENPROJECT_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'create_github_issue',
    {
      description:
        'Use only when the user explicitly asks to create a GitHub issue or has approved publishing prepared issue content. Do not call while merely drafting or brainstorming.',
      inputSchema: CreateGithubIssueSchema,
    },
    async ({ owner, repo, title, body, labels, assignees, milestone, githubToken }) => {
      try {
        const issue = await createGithubIssue(
          owner,
          repo,
          title,
          body,
          labels,
          assignees,
          milestone,
          githubToken,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(issue, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );


  server.registerTool(
    'create_github_issue',
    {
      description:
        'Create a GitHub issue. Compatible with Compound Engineering (ce-plan, ce-work, ce-code-review) tracker-defer system as a ticket creation sink. Credentials can be passed as parameters or auto-loaded from GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN env vars. Falls back to official GitHub MCP if credentials are not available.',
      inputSchema: CreateGithubIssueSchema,
    },
    async ({ owner, repo, title, body, labels, assignees, milestone, githubToken }) => {
      try {
        const issue = await createGithubIssue(
          owner,
          repo,
          title,
          body,
          labels,
          assignees,
          milestone,
          githubToken,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(issue, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'add_jira_comment',
    {
      description:
        'Add a comment to a Jira ticket/issue with optional multiple file or image attachments. Credentials can be passed as parameters or auto-loaded from JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN env vars.',
      inputSchema: AddJiraCommentSchema,
    },
    async ({ issueIdOrKey, comment, attachmentPaths, domain, email, apiToken }) => {
      try {
        const result = await addJiraComment(issueIdOrKey, comment, domain, email, apiToken, attachmentPaths);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Jira Tool Error: ${errorMessage}\n\n${JIRA_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'add_openproject_work_package_comment',
    {
      description:
        'Add an English-language comment to an OpenProject work package, optionally uploading and attaching multiple screenshots from local file paths. Credentials can be passed as parameters or auto-loaded from OPENPROJECT_DOMAIN and OPENPROJECT_API_KEY env vars.',
      inputSchema: AddOpenProjectWorkPackageCommentSchema,
    },
    async ({ workPackageId, comment, screenshotPaths, domain, apiKey }) => {
      try {
        const result = await addOpenProjectWorkPackageComment(
          workPackageId,
          comment,
          domain,
          apiKey,
          screenshotPaths,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `OpenProject Tool Error: ${errorMessage}\n\n${OPENPROJECT_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'add_trello_comment',
    {
      description:
        'Add a comment to a Trello card, optionally attaching multiple local files or images. Credentials can be passed as parameters or auto-loaded from TRELLO_API_KEY and TRELLO_API_TOKEN env vars.',
      inputSchema: AddTrelloCommentSchema,
    },
    async ({ cardId, text, attachmentPaths, apiKey, apiToken }) => {
      try {
        const result = await addTrelloComment(cardId, text, apiKey, apiToken, attachmentPaths);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Trello Tool Error: ${errorMessage}\n\n${TRELLO_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'add_trello_attachment',
    {
      description:
        'Attach a file (e.g. a failure screenshot) to a Trello card. Credentials can be passed as parameters or auto-loaded from TRELLO_API_KEY and TRELLO_API_TOKEN env vars.',
      inputSchema: AddTrelloAttachmentSchema,
    },
    async ({ cardId, filePath, apiKey, apiToken }) => {
      try {
        const result = await addTrelloAttachment(cardId, filePath, apiKey, apiToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Trello Tool Error: ${errorMessage}\n\n${TRELLO_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'add_github_issue_comment',
    {
      description:
        'Add a comment to a GitHub issue. Credentials can be passed as parameters or auto-loaded from GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN env vars.',
      inputSchema: AddGithubIssueCommentSchema,
    },
    async ({ owner, repo, issueNumber, body, githubToken }) => {
      try {
        const result = await addGithubIssueComment(owner, repo, issueNumber, body, githubToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `GitHub Tool Error: ${errorMessage}\n\n${GITHUB_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  // Prompts
  server.registerTool(
    'list_clickup_tasks',
    {
      description:
        'List tasks from a ClickUp list, optionally filtered by status, assignee, tag, or due date range. Returns a concise summary array (id, name, status, assignee, url, due_date) for browsing/triage. Use this when you need to find or filter multiple tasks in a list; use get_clickup_task instead when you already have a specific taskId and need full details. Credentials can be passed as a parameter or auto-loaded from CLICKUP_API_TOKEN env var.',
      inputSchema: ListClickupTasksSchema,
    },
    async ({ listId, status, assignee, tag, dueDateFrom, dueDateTo, apiToken }) => {
      try {
        const tasks = await listClickupTasks(
          listId,
          { status, assignee, tag, dueDateFrom, dueDateTo },
          apiToken,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(tasks, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `ClickUp Tool Error: ${errorMessage}\n\n${CLICKUP_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );


  server.registerTool(
    'get_clickup_task',
    {
      description:
        'Fetch full details of a single ClickUp task by its ID, including description, status, priority, assignees, custom fields, and url. Use this when you already know the specific taskId; use list_clickup_tasks instead when you need to search/browse tasks within a list. Credentials can be passed as a parameter or auto-loaded from CLICKUP_API_TOKEN env var.',
      inputSchema: GetClickupTaskSchema,
    },
    async ({ taskId, apiToken }) => {
      try {
        const task = await getClickupTask(taskId, apiToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(task, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `ClickUp Tool Error: ${errorMessage}\n\n${CLICKUP_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );


  server.registerTool(
    'get_clickup_task_comments',
    {
      description:
        'Fetch all comments on a ClickUp task, including comment text, author, date, and resolved status. Use this to review discussion/history on a task before summarizing or replying. Credentials can be passed as a parameter or auto-loaded from CLICKUP_API_TOKEN env var.',
      inputSchema: GetClickupTaskCommentsSchema,
    },
    async ({ taskId, apiToken }) => {
      try {
        const comments = await getClickupTaskComments(taskId, apiToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(comments, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `ClickUp Tool Error: ${errorMessage}\n\n${CLICKUP_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );


  server.registerTool(
    'create_clickup_comment',
    {
      description:
        'Use only when the user explicitly wants to publish a new comment on a ClickUp task. Supports assignment and watcher notification; do not use for local notes or an unapproved draft.',
      inputSchema: CreateClickupCommentSchema,
    },
    async ({ taskId, commentText, assignee, notifyAll, apiToken }) => {
      try {
        const comment = await createClickupComment(taskId, commentText, assignee, notifyAll, apiToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(comment, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `ClickUp Tool Error: ${errorMessage}\n\n${CLICKUP_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );


  server.registerTool(
    'update_clickup_comment',
    {
      description:
        'Use only when the user explicitly wants to replace the text of an existing ClickUp comment by ID. Fetch context first when the intended comment is ambiguous.',
      inputSchema: UpdateClickupCommentSchema,
    },
    async ({ commentId, commentText, apiToken }) => {
      try {
        const result = await updateClickupComment(commentId, commentText, apiToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `ClickUp Tool Error: ${errorMessage}\n\n${CLICKUP_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );


  server.registerTool(
    'delete_clickup_comment',
    {
      description:
        'Use only when the user explicitly asks to delete a specific ClickUp comment by ID. This is destructive; do not infer deletion from a request to edit or resolve discussion.',
      inputSchema: DeleteClickupCommentSchema,
    },
    async ({ commentId, apiToken }) => {
      try {
        const result = await deleteClickupComment(commentId, apiToken);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `ClickUp Tool Error: ${errorMessage}\n\n${CLICKUP_FALLBACK_INSTRUCTIONS}`,
            },
          ],
        };
      }
    },
  );

  // Prompts
  server.registerPrompt(
    'pm_summarize_ticket',
    {
      title: 'Senior PM Summarize Ticket',
      description:
        'Summarize a raw Jira, Trello, OpenProject, GitHub, or ClickUp ticket/issue/task as a Senior Product Manager.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_SUMMARIZE_TICKET_PROMPT.replace(
        '{{context}}',
        () => command || 'No context provided. Please paste the raw ticket content here.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pm_brainstorm_plan',
    {
      title: 'Staff Engineer Brainstorm and Plan',
      description: 'Brainstorm technical approach and create a plan based on the ticket summary.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_BRAINSTORM_PLAN_PROMPT.replace(
        '{{context}}',
        () => command || 'No context provided.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pm_test_catalog',
    {
      title: 'Strict QA Test Catalog Generator',
      description: 'Generate comprehensive test catalog based on the ticket and technical plan.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_TEST_CATALOG_PROMPT.replace(
        '{{context}}',
        () => command || 'No context provided.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pm_create_ticket',
    {
      title: 'Senior PM Create Ticket',
      description:
        'Generate a production-grade, structured ticket body based on raw context (feature, bug, findings) adhering to Big Tech standards.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_CREATE_TICKET_PROMPT.replace(
        '{{context}}',
        () => command || 'No context provided.',
      ).replace(
        '{{platform}}',
        'Markdown (GitHub/OpenProject) / ADF (Jira) / Plain text (Trello) - Please determine from context or use Markdown as default',
      );

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pm_summarize_ticket',
    {
      title: 'Senior PM Summarize Ticket',
      description:
        'Summarize a raw Jira, Trello, OpenProject, or GitHub ticket/issue as a Senior Product Manager.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_SUMMARIZE_TICKET_PROMPT.replace(
        '{{context}}',
        () => command || 'No context provided. Please paste the raw ticket content here.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pm_brainstorm_plan',
    {
      title: 'Staff Engineer Brainstorm and Plan',
      description: 'Brainstorm technical approach and create a plan based on the ticket summary.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_BRAINSTORM_PLAN_PROMPT.replace(
        '{{context}}',
        () => command || 'No context provided.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pm_test_catalog',
    {
      title: 'Strict QA Test Catalog Generator',
      description: 'Generate comprehensive test catalog based on the ticket and technical plan.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_TEST_CATALOG_PROMPT.replace(
        '{{context}}',
        () => command || 'No context provided.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pm_create_ticket',
    {
      title: 'Senior PM Create Ticket',
      description:
        'Generate a production-grade, structured ticket body based on raw context (feature, bug, findings) adhering to Big Tech standards.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_CREATE_TICKET_PROMPT.replace(
        '{{context}}',
        () => command || 'No context provided.',
      ).replace(
        '{{platform}}',
        'Markdown (GitHub/OpenProject) / ADF (Jira) / Plain text (Trello) - Please determine from context or use Markdown as default',
      );

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'pm_testing_ticket',
    {
      title: 'Automated Ticket-Driven Web Testing',
      description:
        'Fetch a Jira, OpenProject, Trello, or GitHub Issue ticket, derive test steps from its Acceptance Criteria / Test Cases, execute them against a target website using browser tooling, and post a PASS/FAILED result comment back to the ticket.',
      argsSchema: PmTestingTicketPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_TESTING_TICKET_PROMPT.replace(
        '{{context}}',
        () =>
          command ||
          'No context provided. Please specify ticket_url, website_url, and optionally username/password.',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'dev_check_comment',
    {
      title: 'Developer Check Comments and Reviews',
      description:
        'Fetch and review comments, activity logs, and review feedback for a ticket/issue (Jira, OpenProject, GitHub, Trello) to extract key decisions and unresolved feedback.',
      argsSchema: ProjectManagementPromptSchema,
    },
    async ({ command }) => {
      const promptText = PM_DEV_CHECK_COMMENT_PROMPT.replace(
        '{{context}}',
        () =>
          command ||
          'No ticket ID or context provided. Please specify the ticket/issue key or ID (e.g., PRJ-123 or OpenProject #42 or GitHub owner/repo#issue).',
      );
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );
}
