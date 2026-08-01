import { openProjectRepository } from '../repository/openproject.repository.js';

export async function getOpenProjectWorkPackage(
  workPackageId: string,
  domain?: string,
  apiKey?: string,
): Promise<unknown> {
  const finalDomain = domain || process.env.OPENPROJECT_DOMAIN;
  const finalApiKey = apiKey || process.env.OPENPROJECT_API_KEY;

  if (!finalDomain) {
    throw new Error(
      'OpenProject domain is required. Provide it as an argument or set OPENPROJECT_DOMAIN.',
    );
  }

  if (!finalApiKey) {
    throw new Error(
      'OpenProject apiKey is required. Provide it as an argument or set OPENPROJECT_API_KEY.',
    );
  }

  return await openProjectRepository.getWorkPackage(workPackageId, finalDomain, finalApiKey);
}

export async function createOpenProjectWorkPackage(
  projectId: string,
  subject: string,
  type: string,
  description?: string,
  priority?: string,
  assignee?: string,
  attachmentPath?: string,
  domain?: string,
  apiKey?: string,
): Promise<unknown> {
  const finalDomain = domain || process.env.OPENPROJECT_DOMAIN;
  const finalApiKey = apiKey || process.env.OPENPROJECT_API_KEY;

  if (!projectId || !subject || !type) {
    throw new Error(
      'OpenProject projectId, subject, and type are required to create a work package.',
    );
  }

  if (!finalDomain) {
    throw new Error(
      'OpenProject domain is required. Provide it as an argument or set OPENPROJECT_DOMAIN.',
    );
  }

  if (!finalApiKey) {
    throw new Error(
      'OpenProject apiKey is required. Provide it as an argument or set OPENPROJECT_API_KEY.',
    );
  }

  const wp = await openProjectRepository.createWorkPackage(
    projectId,
    subject,
    type,
    description,
    priority,
    assignee,
    finalDomain,
    finalApiKey,
  );

  if (attachmentPath) {
    try {
      await openProjectRepository.attachFileToWorkPackage(
        (wp as Record<string, unknown>).id as string,
        attachmentPath,
        finalDomain,
        finalApiKey,
      );
    } catch (e) {
      console.error('Failed to attach file to OpenProject work package:', e);
    }
  }

  return wp;
}

export async function getOpenProjectWorkPackageComments(
  workPackageId: string,
  domain?: string,
  apiKey?: string,
  offset?: number,
  pageSize?: number,
): Promise<unknown> {
  const finalDomain = domain || process.env.OPENPROJECT_DOMAIN;
  const finalApiKey = apiKey || process.env.OPENPROJECT_API_KEY;

  if (!finalDomain) {
    throw new Error(
      'OpenProject domain is required. Provide it as an argument or set OPENPROJECT_DOMAIN.',
    );
  }

  if (!finalApiKey) {
    throw new Error(
      'OpenProject apiKey is required. Provide it as an argument or set OPENPROJECT_API_KEY.',
    );
  }

  return await openProjectRepository.getWorkPackageComments(
    workPackageId,
    finalDomain,
    finalApiKey,
    offset,
    pageSize,
  );
}

