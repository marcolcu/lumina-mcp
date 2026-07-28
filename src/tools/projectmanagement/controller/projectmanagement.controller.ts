import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getJiraTicket, createJiraTicket } from '../jira/service/jira.service.js';
import { getTrelloCard, createTrelloCard } from '../trello/service/trello.service.js';
import {
  getOpenProjectWorkPackage,
  createOpenProjectWorkPackage,
  addOpenProjectWorkPackageComment,
  addOpenProjectTimeEntry,
} from '../openproject/service/openproject.service.js';
import { getGithubIssue, createGithubIssue } from '../github/service/github.service.js';
import {
  listClickupTasks,
  getClickupTask,
  getClickupTaskComments,
  createClickupComment,
  updateClickupComment,
  deleteClickupComment,
} from '../clickup/service/clickup.service.js';
import {
  GetJiraTicketSchema,
  CreateJiraTicketSchema,
  GetTrelloCardSchema,
  CreateTrelloCardSchema,
  GetOpenProjectWorkPackageSchema,
  CreateOpenProjectWorkPackageSchema,
  AddOpenProjectWorkPackageCommentSchema,
  AddOpenProjectTimeEntrySchema,
  GetGithubIssueSchema,
  CreateGithubIssueSchema,
  ListClickupTasksSchema,
  GetClickupTaskSchema,
  GetClickupTaskCommentsSchema,
  CreateClickupCommentSchema,
  UpdateClickupCommentSchema,
  DeleteClickupCommentSchema,
  ProjectManagementPromptSchema,
} from '../dto/projectmanagement.dto.js';
import {
  PM_SUMMARIZE_TICKET_PROMPT,
  PM_BRAINSTORM_PLAN_PROMPT,
  PM_TEST_CATALOG_PROMPT,
  PM_CREATE_TICKET_PROMPT,
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
        'Create a Jira ticket/issue. Compatible with Compound Engineering (ce-plan, ce-work, ce-code-review) tracker-defer system as a ticket creation sink. Credentials can be passed as parameters or auto-loaded from JIRA_DOMAIN, JIRA_EMAIL, JIRA_API_TOKEN env vars. Falls back to official Atlassian MCP if credentials are not available.',
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
      attachmentPath,
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
          attachmentPath,
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
        'Create a Trello card. Compatible with Compound Engineering (ce-plan, ce-work, ce-code-review) tracker-defer system as a ticket creation sink. Credentials can be passed as parameters or auto-loaded from TRELLO_API_KEY and TRELLO_API_TOKEN env vars. Falls back to official Atlassian/Trello MCP if credentials are not available.',
      inputSchema: CreateTrelloCardSchema,
    },
    async ({ idList, name, desc, pos, due, idLabels, idMembers, apiKey, apiToken }) => {
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
        'Create an OpenProject work package. Compatible with Compound Engineering (ce-plan, ce-work, ce-code-review) tracker-defer system as a ticket creation sink. Credentials can be passed as parameters or auto-loaded from OPENPROJECT_DOMAIN and OPENPROJECT_API_KEY env vars. Falls back to official OpenProject MCP if credentials are not available.',
      inputSchema: CreateOpenProjectWorkPackageSchema,
    },
    async ({
      projectId,
      subject,
      type,
      description,
      priority,
      assignee,
      attachmentPath,
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
          attachmentPath,
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
    'add_openproject_work_package_comment',
    {
      description:
        'Add a comment to an existing OpenProject work package. Credentials can be passed as parameters or auto-loaded from OPENPROJECT_DOMAIN and OPENPROJECT_API_KEY env vars. Falls back to official OpenProject MCP if credentials are not available.',
      inputSchema: AddOpenProjectWorkPackageCommentSchema,
    },
    async ({ workPackageId, comment, domain, apiKey }) => {
      try {
        const result = await addOpenProjectWorkPackageComment(
          workPackageId,
          comment,
          domain,
          apiKey,
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
    'add_openproject_time_entry',
    {
      description:
        'Log spent time on an OpenProject work package (fills the "Spent time" field). Accepts hours as a decimal number (e.g., 2.5) or an ISO 8601 duration string (e.g., "PT2H30M"). Credentials can be passed as parameters or auto-loaded from OPENPROJECT_DOMAIN and OPENPROJECT_API_KEY env vars. Falls back to official OpenProject MCP if credentials are not available.',
      inputSchema: AddOpenProjectTimeEntrySchema,
    },
    async ({ workPackageId, hours, spentOn, comment, activityId, domain, apiKey }) => {
      try {
        const timeEntry = await addOpenProjectTimeEntry(
          workPackageId,
          hours,
          spentOn,
          comment,
          activityId,
          domain,
          apiKey,
        );
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(timeEntry, null, 2),
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
        'Add a new comment to a ClickUp task, optionally assigning it to a user or notifying all watchers. Credentials can be passed as a parameter or auto-loaded from CLICKUP_API_TOKEN env var.',
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
        'Edit the text of an existing ClickUp comment by its ID. Credentials can be passed as a parameter or auto-loaded from CLICKUP_API_TOKEN env var.',
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
        'Delete an existing ClickUp comment by its ID. Credentials can be passed as a parameter or auto-loaded from CLICKUP_API_TOKEN env var.',
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
}
