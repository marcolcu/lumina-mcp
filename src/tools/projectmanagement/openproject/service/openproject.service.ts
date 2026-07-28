import { openProjectRepository } from '../repository/openproject.repository.js';

function toIso8601Duration(hours: string | number): string {
  if (typeof hours === 'string' && /^P/i.test(hours.trim())) {
    return hours.trim();
  }

  const numericHours = typeof hours === 'number' ? hours : Number(hours);

  if (!Number.isFinite(numericHours) || numericHours <= 0) {
    throw new Error('OpenProject hours must be a positive number or a valid ISO 8601 duration string.');
  }

  const totalMinutes = Math.round(numericHours * 60);
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (wholeHours === 0) {
    return `PT${minutes}M`;
  }
  if (minutes === 0) {
    return `PT${wholeHours}H`;
  }
  return `PT${wholeHours}H${minutes}M`;
}

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

export async function addOpenProjectWorkPackageComment(
  workPackageId: string,
  comment: string,
  domain?: string,
  apiKey?: string,
): Promise<unknown> {
  const finalDomain = domain || process.env.OPENPROJECT_DOMAIN;
  const finalApiKey = apiKey || process.env.OPENPROJECT_API_KEY;

  if (!workPackageId || !comment) {
    throw new Error('OpenProject workPackageId and comment are required to add a comment.');
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

  return await openProjectRepository.addWorkPackageComment(
    workPackageId,
    comment,
    finalDomain,
    finalApiKey,
  );
}

export async function addOpenProjectTimeEntry(
  workPackageId: string,
  hours: string | number,
  spentOn?: string,
  comment?: string,
  activityId?: string,
  domain?: string,
  apiKey?: string,
): Promise<unknown> {
  const finalDomain = domain || process.env.OPENPROJECT_DOMAIN;
  const finalApiKey = apiKey || process.env.OPENPROJECT_API_KEY;

  if (!workPackageId || hours === undefined || hours === null || hours === '') {
    throw new Error('OpenProject workPackageId and hours are required to log spent time.');
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

  const isoDuration = toIso8601Duration(hours);
  const finalSpentOn = spentOn || new Date().toISOString().slice(0, 10);

  return await openProjectRepository.addTimeEntry(
    workPackageId,
    isoDuration,
    finalSpentOn,
    finalDomain,
    finalApiKey,
    comment,
    activityId,
  );
}
