import * as fs from 'fs/promises';
import * as path from 'path';

export class OpenProjectRepository {
  async getWorkPackage(workPackageId: string, domain: string, apiKey: string): Promise<unknown> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${cleanDomain}/api/v3/work_packages/${workPackageId}`;

    // OpenProject uses Basic Auth where username is 'apikey'
    const authHeader = 'Basic ' + Buffer.from(`apikey:${apiKey}`).toString('base64');

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: authHeader,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to fetch OpenProject work package ${workPackageId}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  async createWorkPackage(
    projectId: string,
    subject: string,
    type: string,
    description: string | undefined,
    priority: string | undefined,
    assignee: string | undefined,
    domain: string,
    apiKey: string,
  ): Promise<unknown> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${cleanDomain}/api/v3/projects/${projectId}/work_packages`;
    const authHeader = 'Basic ' + Buffer.from(`apikey:${apiKey}`).toString('base64');

    const body: {
      subject: string;
      description?: { format: string; raw: string };
      _links: Record<string, { href: string }>;
    } = {
      subject,
      _links: {
        type: { href: `/api/v3/types/${type}` },
      },
    };

    if (description) {
      body.description = { format: 'markdown', raw: description };
    }

    if (priority) {
      body._links.priority = { href: `/api/v3/priorities/${priority}` };
    }

    if (assignee) {
      // Assignee is often passed as just the user ID or the full href.
      // Handling simple ID to href transformation if numeric.
      const assigneeHref = /^\d+$/.test(assignee) ? `/api/v3/users/${assignee}` : assignee;
      body._links.assignee = { href: assigneeHref };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to create OpenProject work package: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  async addWorkPackageComment(
    workPackageId: string,
    comment: string,
    domain: string,
    apiKey: string,
  ): Promise<unknown> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${cleanDomain}/api/v3/work_packages/${workPackageId}/activities`;
    const authHeader = 'Basic ' + Buffer.from(`apikey:${apiKey}`).toString('base64');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: authHeader,
      },
      body: JSON.stringify({ comment: { format: 'markdown', raw: comment } }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to add comment to OpenProject work package ${workPackageId}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }

  async attachFileToWorkPackage(
    workPackageId: string,
    filePath: string,
    domain: string,
    apiKey: string,
  ): Promise<unknown> {
    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const url = `https://${cleanDomain}/api/v3/work_packages/${workPackageId}/attachments`;
    const authHeader = 'Basic ' + Buffer.from(`apikey:${apiKey}`).toString('base64');

    const fileBuffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);

    const formData = new FormData();
    formData.append('metadata', JSON.stringify({ fileName }));
    const blob = new Blob([fileBuffer]);
    formData.append('file', blob, fileName);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to attach file to OpenProject work package ${workPackageId}: ${response.statusText} - ${errorText}`,
      );
    }

    return await response.json();
  }
}

export const openProjectRepository = new OpenProjectRepository();
