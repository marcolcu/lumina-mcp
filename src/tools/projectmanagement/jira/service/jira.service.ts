import { jiraRepository } from '../repository/jira.repository.js';

export async function getJiraTicket(
  issueIdOrKey: string,
  domain?: string,
  email?: string,
  apiToken?: string,
): Promise<unknown> {
  const finalDomain = domain || process.env.JIRA_DOMAIN;
  const finalEmail = email || process.env.JIRA_EMAIL;
  const finalToken = apiToken || process.env.JIRA_API_TOKEN;

  if (!finalDomain) {
    throw new Error('Jira domain is required. Provide it as an argument or set JIRA_DOMAIN.');
  }

  if (!finalEmail || !finalToken) {
    throw new Error(
      'Jira email and apiToken are required for authentication. Provide them as arguments or set JIRA_EMAIL and JIRA_API_TOKEN.',
    );
  }

  return await jiraRepository.getTicket(issueIdOrKey, finalDomain, finalEmail, finalToken);
}

export async function createJiraTicket(
  projectKey: string,
  summary: string,
  issueType: string,
  description?: string,
  priority?: string,
  labels?: string[],
  assigneeAccountId?: string,
  attachmentPath?: string,
  domain?: string,
  email?: string,
  apiToken?: string,
): Promise<unknown> {
  const finalDomain = domain || process.env.JIRA_DOMAIN;
  const finalEmail = email || process.env.JIRA_EMAIL;
  const finalToken = apiToken || process.env.JIRA_API_TOKEN;

  if (!projectKey || !summary || !issueType) {
    throw new Error('Jira projectKey, summary, and issueType are required to create a ticket.');
  }

  if (!finalDomain) {
    throw new Error('Jira domain is required. Provide it as an argument or set JIRA_DOMAIN.');
  }

  if (!finalEmail || !finalToken) {
    throw new Error(
      'Jira email and apiToken are required for authentication. Provide them as arguments or set JIRA_EMAIL and JIRA_API_TOKEN.',
    );
  }

  const ticket = await jiraRepository.createTicket(
    projectKey,
    summary,
    issueType,
    description,
    priority,
    labels,
    assigneeAccountId,
    finalDomain,
    finalEmail,
    finalToken,
  );

  if (attachmentPath) {
    try {
      await jiraRepository.attachFileToTicket(
        ((ticket as Record<string, unknown>).id ||
          (ticket as Record<string, unknown>).key) as string,
        attachmentPath,
        finalDomain,
        finalEmail,
        finalToken,
      );
    } catch (e) {
      console.error('Failed to attach file to Jira ticket:', e);
    }
  }

  return ticket;
}
