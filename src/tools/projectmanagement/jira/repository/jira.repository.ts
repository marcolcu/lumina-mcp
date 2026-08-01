import * as fs from 'fs/promises';
import * as path from 'path';
export class JiraRepository {
  async getTicket(
    issueIdOrKey: string,
    domain: string,
    email: string,
    apiToken: string,
  ): Promise<unknown> {
    const cleanDomain = domain
      .replace(/^https?:\/\//, '')
      .replace(/\.atlassian\.net\/?$/, '')
      .replace(/\/$/, '');
    const url = `https://${cleanDomain}.atlassian.net/rest/api/3/issue/${issueIdOrKey}`;
    const credentials = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch Jira ticket ${issueIdOrKey}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  async createTicket(
    projectKey: string,
    summary: string,
    issueType: string,
    description: string | undefined,
    priority: string | undefined,
    labels: string[] | undefined,
    assigneeAccountId: string | undefined,
    domain: string,
    email: string,
    apiToken: string,
  ): Promise<unknown> {
    const cleanDomain = domain
      .replace(/^https?:\/\//, '')
      .replace(/\.atlassian\.net\/?$/, '')
      .replace(/\/$/, '');
    const url = `https://${cleanDomain}.atlassian.net/rest/api/3/issue`;
    const credentials = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const fields: Record<string, unknown> = {
      project: { key: projectKey },
      summary: summary,
      issuetype: { name: issueType },
    };

    if (description) {
      fields.description = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: description }],
          },
        ],
      };
    }

    if (priority) {
      fields.priority = { name: priority };
    }

    if (labels && labels.length > 0) {
      fields.labels = labels;
    }

    if (assigneeAccountId) {
      fields.assignee = { accountId: assigneeAccountId };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create Jira ticket: ${response.statusText} - ${errorText}`);
    }

    return await response.json();
  }

  async attachFileToTicket(
    issueKey: string,
    filePath: string,
    domain: string,
    email: string,
    apiToken: string,
  ): Promise<unknown> {
    const cleanDomain = domain
      .replace(/^https?:\/\//, '')
      .replace(/\.atlassian\.net\/?$/, '')
      .replace(/\/$/, '');
    const url = `https://${cleanDomain}.atlassian.net/rest/api/3/issue/${issueKey}/attachments`;
    const credentials = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    const blob = new Blob([fileBuffer]);
    formData.append('file', blob, fileName);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'X-Atlassian-Token': 'no-check',
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to attach file to Jira ticket ${issueKey}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  async getTicketComments(
    issueIdOrKey: string,
    domain: string,
    email: string,
    apiToken: string,
    startAt?: number,
    maxResults?: number,
  ): Promise<unknown> {
    const cleanDomain = domain
      .replace(/^https?:\/\//, '')
      .replace(/\.atlassian\.net\/?$/, '')
      .replace(/\/$/, '');
    const queryParams = new URLSearchParams();
    if (startAt !== undefined) queryParams.append('startAt', startAt.toString());
    if (maxResults !== undefined) queryParams.append('maxResults', maxResults.toString());
    const queryString = queryParams.toString() ? `?${queryParams.toString()}` : '';

    const url = `https://${cleanDomain}.atlassian.net/rest/api/3/issue/${issueIdOrKey}/comment${queryString}`;
    const credentials = Buffer.from(`${email}:${apiToken}`).toString('base64');

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch Jira ticket comments for ${issueIdOrKey}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }
}

export const jiraRepository = new JiraRepository();
