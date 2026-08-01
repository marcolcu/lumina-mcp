import { z } from 'zod';

export const GetJiraTicketSchema = {
  domain: z
    .string()
    .describe(
      'Jira domain prefix (e.g. yourcompany for yourcompany.atlassian.net). Defaults to JIRA_DOMAIN env var if not provided.',
    )
    .optional(),
  email: z
    .string()
    .describe('Jira email address. Defaults to JIRA_EMAIL env var if not provided.')
    .optional(),
  apiToken: z
    .string()
    .describe('Jira API token. Defaults to JIRA_API_TOKEN env var if not provided.')
    .optional(),
  issueIdOrKey: z.string().describe('Jira Issue ID or Key (e.g., PRJ-1234)'),
};

export const GetTrelloCardSchema = {
  apiKey: z
    .string()
    .describe('Trello API Key. Defaults to TRELLO_API_KEY env var if not provided.')
    .optional(),
  apiToken: z
    .string()
    .describe('Trello API Token. Defaults to TRELLO_API_TOKEN env var if not provided.')
    .optional(),
  cardId: z.string().describe('Trello Card ID or shortlink'),
};

export const GetOpenProjectWorkPackageSchema = {
  domain: z
    .string()
    .describe(
      'OpenProject domain (e.g. openproject.yourcompany.com). Defaults to OPENPROJECT_DOMAIN env var if not provided.',
    )
    .optional(),
  apiKey: z
    .string()
    .describe('OpenProject API Key. Defaults to OPENPROJECT_API_KEY env var if not provided.')
    .optional(),
  workPackageId: z.string().describe('OpenProject Work Package ID'),
};

export const GetGithubIssueSchema = {
  owner: z.string().describe('GitHub repository owner (user or organization)'),
  repo: z.string().describe('GitHub repository name'),
  issueNumber: z.string().describe('GitHub issue number'),
  githubToken: z
    .string()
    .describe(
      'GitHub Personal Access Token. Defaults to GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN env var if not provided.',
    )
    .optional(),
};

export const ProjectManagementPromptSchema = {
  command: z.string().optional().describe('Additional instructions or context'),
};

export const CreateJiraTicketSchema = {
  domain: z
    .string()
    .describe(
      'Jira domain prefix (e.g. yourcompany for yourcompany.atlassian.net). Defaults to JIRA_DOMAIN env var if not provided.',
    )
    .optional(),
  email: z
    .string()
    .describe('Jira email address. Defaults to JIRA_EMAIL env var if not provided.')
    .optional(),
  apiToken: z
    .string()
    .describe('Jira API token. Defaults to JIRA_API_TOKEN env var if not provided.')
    .optional(),
  projectKey: z.string().min(1).describe('Jira Project Key (e.g., PRJ)'),
  summary: z.string().min(1).describe('Issue title/summary'),
  issueType: z.string().min(1).describe('Issue type (e.g., Task, Bug, Story)'),
  description: z.string().describe('Issue description in plain text').optional(),
  priority: z.string().describe('Issue priority (e.g., High, Medium, Low)').optional(),
  labels: z.array(z.string()).describe('Array of labels').optional(),
  assigneeAccountId: z.string().describe('Assignee account ID').optional(),
  attachmentPath: z.string().describe('Absolute path to a file to attach to the ticket').optional(),
};

export const CreateTrelloCardSchema = {
  apiKey: z
    .string()
    .describe('Trello API Key. Defaults to TRELLO_API_KEY env var if not provided.')
    .optional(),
  apiToken: z
    .string()
    .describe('Trello API Token. Defaults to TRELLO_API_TOKEN env var if not provided.')
    .optional(),
  idList: z.string().min(1).describe('Trello target list ID'),
  name: z.string().min(1).describe('Trello card title/name'),
  desc: z.string().describe('Trello card description').optional(),
  pos: z.string().describe('Position: "top", "bottom", or a float').optional(),
  due: z.string().describe('Due date (ISO 8601)').optional(),
  idLabels: z.string().describe('Comma-separated label IDs').optional(),
  idMembers: z.string().describe('Comma-separated member IDs').optional(),
};

export const CreateOpenProjectWorkPackageSchema = {
  domain: z
    .string()
    .describe(
      'OpenProject domain (e.g. openproject.yourcompany.com). Defaults to OPENPROJECT_DOMAIN env var if not provided.',
    )
    .optional(),
  apiKey: z
    .string()
    .describe('OpenProject API Key. Defaults to OPENPROJECT_API_KEY env var if not provided.')
    .optional(),
  projectId: z.string().min(1).describe('OpenProject Project ID or slug'),
  subject: z.string().min(1).describe('Work package subject/title'),
  type: z.string().min(1).describe('Work package type (e.g., Task, Feature, Bug)'),
  description: z.string().describe('Work package description').optional(),
  priority: z.string().describe('Work package priority (e.g., High, Normal, Low)').optional(),
  assignee: z.string().describe('Assignee user href or ID').optional(),
  attachmentPath: z
    .string()
    .describe('Absolute path to a file to attach to the work package')
    .optional(),
};

export const CreateGithubIssueSchema = {
  githubToken: z
    .string()
    .describe(
      'GitHub Personal Access Token. Defaults to GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN env var if not provided.',
    )
    .optional(),
  owner: z.string().min(1).describe('GitHub repository owner (user or organization)'),
  repo: z.string().min(1).describe('GitHub repository name'),
  title: z.string().min(1).describe('Issue title'),
  body: z.string().describe('Markdown description for the issue').optional(),
  labels: z.array(z.string()).describe('Array of label names').optional(),
  assignees: z.array(z.string()).describe('Array of assignee usernames').optional(),
  milestone: z.number().int().describe('Milestone number').optional(),
};

export const GetJiraTicketCommentsSchema = {
  domain: z
    .string()
    .describe(
      'Jira domain prefix (e.g. yourcompany for yourcompany.atlassian.net). Defaults to JIRA_DOMAIN env var if not provided.',
    )
    .optional(),
  email: z
    .string()
    .describe('Jira email address. Defaults to JIRA_EMAIL env var if not provided.')
    .optional(),
  apiToken: z
    .string()
    .describe('Jira API token. Defaults to JIRA_API_TOKEN env var if not provided.')
    .optional(),
  issueIdOrKey: z.string().describe('Jira Issue ID or Key (e.g., PRJ-1234)'),
  startAt: z
    .number()
    .int()
    .describe('The index of the first item to return in a page of results')
    .optional(),
  maxResults: z.number().int().describe('The maximum number of items to return per page').optional(),
};

export const GetOpenProjectWorkPackageCommentsSchema = {
  domain: z
    .string()
    .describe(
      'OpenProject domain (e.g. openproject.yourcompany.com). Defaults to OPENPROJECT_DOMAIN env var if not provided.',
    )
    .optional(),
  apiKey: z
    .string()
    .describe('OpenProject API Key. Defaults to OPENPROJECT_API_KEY env var if not provided.')
    .optional(),
  workPackageId: z.string().describe('OpenProject Work Package ID'),
  offset: z.number().int().describe('Page number or offset for pagination').optional(),
  pageSize: z.number().int().describe('Number of elements per page').optional(),
};

