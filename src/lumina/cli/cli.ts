import os from 'node:os';
import { parseArgs } from 'node:util';
import { detectPlatforms, parsePlatformNames } from './installer/detection.js';
import { installSkills, uninstallSkills } from './installer/installer.js';

export interface CliContext {
  homeDir?: string;
  projectDir?: string;
  pathValue?: string;
  log?: (message: string) => void;
}

export async function runManagementCommand(
  args: string[],
  context: CliContext = {},
): Promise<boolean> {
  const command = args[0];
  if (command !== 'install' && command !== 'uninstall') {
    return false;
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      project: { type: 'boolean', default: false },
      platform: { type: 'string', multiple: true },
    },
    strict: true,
    allowPositionals: false,
  });

  const homeDir = context.homeDir ?? os.homedir();
  const projectDir = context.projectDir ?? process.cwd();
  const requestedPlatforms = parsePlatformNames(values.platform);
  const log = context.log ?? console.log;

  if (command === 'install') {
    const platforms =
      requestedPlatforms ??
      detectPlatforms({ homeDir, projectDir, pathValue: context.pathValue ?? process.env.PATH });
    const records = installSkills({
      platforms,
      scope: values.project ? 'project' : 'user',
      homeDir,
      projectDir,
    });
    for (const record of records) {
      log(`Installed lumina-mcp for ${record.platform} (${record.scope}).`);
    }
    return true;
  }

  const records = uninstallSkills({
    homeDir,
    projectDir,
    projectOnly: values.project,
    platforms: requestedPlatforms,
  });
  if (records.length === 0) {
    log('No matching Lumina skill installations found.');
  } else {
    for (const record of records) {
      log(`Uninstalled lumina-mcp for ${record.platform} (${record.scope}).`);
    }
  }
  return true;
}
