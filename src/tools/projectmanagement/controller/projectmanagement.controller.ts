import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getJiraTicket, createJiraTicket } from '../jira/service/jira.service.js';
import { getTrelloCard, createTrelloCard } from '../trello/service/trello.service.js';
import {
  getOpenProjectWorkPackage,
  createOpenProjectWorkPackage,
} from '../openproject/service/openproject.service.js';
import { getGithubIssue, createGithubIssue } from '../github/service/github.service.js';
import {
  GetJiraTicketSchema,
  CreateJiraTicketSchema,
  GetTrelloCardSchema,
  CreateTrelloCardSchema,
  GetOpenProjectWorkPackageSchema,
  CreateOpenProjectWorkPackageSchema,
  GetGithubIssueSchema,
  CreateGithubIssueSchema,
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

  // Prompts
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
}
