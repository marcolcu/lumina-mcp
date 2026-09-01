import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AssistantPlatform,
  type InstallationRecord,
  type InstallManifest,
  type InstallScope,
  type InstalledArtifact,
} from './types.js';

const AGENTS_SECTION_START = '<!-- lumina-mcp:skill:start -->';
const AGENTS_SECTION_END = '<!-- lumina-mcp:skill:end -->';

function manifestPath(homeDir: string): string {
  return path.join(homeDir, '.lumina-mcp', 'installations.json');
}

function loadManifest(homeDir: string): InstallManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(homeDir), 'utf8')) as InstallManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.installations)) {
      throw new Error('unsupported manifest format');
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, installations: [] };
    }
    throw new Error(`Cannot read Lumina install manifest: ${String(error)}`);
  }
}

function saveManifest(homeDir: string, manifest: InstallManifest): void {
  const target = manifestPath(homeDir);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function removeEmptyParents(start: string, stop: string): void {
  let current = start;
  const resolvedStop = path.resolve(stop);
  while (path.resolve(current) !== resolvedStop && path.resolve(current).startsWith(resolvedStop)) {
    try {
      fs.rmdirSync(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function removeAgentsSection(target: string, createdFile = false): void {
  let content: string;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const start = content.indexOf(AGENTS_SECTION_START);
  const end = content.indexOf(AGENTS_SECTION_END);
  if (start === -1 || end === -1 || end < start) {
    return;
  }

  const updated = `${content.slice(0, start)}${content.slice(end + AGENTS_SECTION_END.length)}`;
  if (createdFile && updated.trim().length === 0) {
    fs.unlinkSync(target);
  } else {
    fs.writeFileSync(target, updated, 'utf8');
  }
}

function removeRecord(record: InstallationRecord, homeDir: string, projectDir: string): void {
  for (const artifact of [...record.artifacts].reverse()) {
    if (artifact.kind === 'agents-section') {
      removeAgentsSection(artifact.path, artifact.createdFile);
      continue;
    }

    try {
      fs.unlinkSync(artifact.path);
      const stop = record.scope === 'user' ? homeDir : record.projectRoot ?? projectDir;
      removeEmptyParents(path.dirname(artifact.path), stop);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function listSkillFiles(root: string, relative = ''): string[] {
  const current = path.join(root, relative);
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(relative, entry.name);
    if (child === 'platform' || child.startsWith(`platform${path.sep}`)) return [];
    return entry.isDirectory() ? listSkillFiles(root, child) : [child];
  });
}

function assertTargetsAvailable(paths: string[]): void {
  const conflicts = paths.filter((target) => fs.existsSync(target));
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite an installation not owned by Lumina: ${conflicts.join(', ')}`,
    );
  }
}

function copySkillFiles(sourceDir: string, targetDir: string): InstalledArtifact[] {
  const relativeFiles = listSkillFiles(sourceDir);
  const targets = relativeFiles.map((relative) => path.join(targetDir, relative));
  assertTargetsAvailable(targets);

  const artifacts: InstalledArtifact[] = [];
  try {
    for (let index = 0; index < relativeFiles.length; index += 1) {
      const source = path.join(sourceDir, relativeFiles[index]);
      const target = targets[index];
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      artifacts.push({ kind: 'file', path: target });
    }
    return artifacts;
  } catch (error) {
    for (const artifact of artifacts.reverse()) {
      fs.rmSync(artifact.path, { force: true });
    }
    throw error;
  }
}

function installAgentsSection(sourceDir: string, target: string): InstalledArtifact[] {
  const section = fs.readFileSync(path.join(sourceDir, 'platform', 'agents-section.md'), 'utf8').trim();
  const createdFile = !fs.existsSync(target);
  const existing = createdFile ? '' : fs.readFileSync(target, 'utf8');
  const hasStart = existing.includes(AGENTS_SECTION_START);
  const hasEnd = existing.includes(AGENTS_SECTION_END);
  if (hasStart !== hasEnd) {
    throw new Error(`Cannot update malformed Lumina section in ${target}.`);
  }

  let withoutOldSection = existing;
  if (hasStart && hasEnd) {
    const start = existing.indexOf(AGENTS_SECTION_START);
    const end = existing.indexOf(AGENTS_SECTION_END) + AGENTS_SECTION_END.length;
    withoutOldSection = `${existing.slice(0, start)}${existing.slice(end)}`;
  }

  const prefix = withoutOldSection.trimEnd();
  const rendered = `${prefix}${prefix ? '\n\n' : ''}${AGENTS_SECTION_START}\n${section}\n${AGENTS_SECTION_END}\n`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered, 'utf8');
  return [{ kind: 'agents-section', path: target, createdFile }];
}

function installCursorRule(sourceDir: string, target: string): InstalledArtifact[] {
  assertTargetsAvailable([target]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceDir, 'platform', 'cursor.mdc'), target);
  return [{ kind: 'file', path: target }];
}

function destinationFor(
  platform: AssistantPlatform,
  scope: InstallScope,
  homeDir: string,
  projectDir: string,
): string {
  const root = scope === 'user' ? homeDir : projectDir;
  switch (platform) {
    case 'claude':
      return path.join(root, '.claude', 'skills', 'lumina-mcp');
    case 'gemini':
      return path.join(root, '.gemini', 'skills', 'lumina-mcp');
    case 'cursor':
      return path.join(root, '.cursor', 'rules', 'lumina-mcp.mdc');
    case 'codex':
      return scope === 'user'
        ? path.join(homeDir, '.codex', 'AGENTS.md')
        : path.join(projectDir, 'AGENTS.md');
  }
}

export function resolveBundledSkillDir(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, 'skills', 'lumina-mcp'),
    path.resolve(moduleDir, '../../../../skills/lumina-mcp'),
    path.resolve(process.cwd(), 'skills/lumina-mcp'),
  ];
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'SKILL.md')));
  if (!found) {
    throw new Error('Bundled Lumina skill files were not found. Reinstall the lumina-mcp package.');
  }
  return found;
}

export interface InstallSkillsOptions {
  platforms: AssistantPlatform[];
  scope: InstallScope;
  homeDir: string;
  projectDir: string;
  sourceDir?: string;
}

export function installSkills(options: InstallSkillsOptions): InstallationRecord[] {
  if (options.platforms.length === 0) {
    throw new Error('No supported assistant platform detected. Use --platform to select one.');
  }

  const sourceDir = options.sourceDir ?? resolveBundledSkillDir();
  const manifest = loadManifest(options.homeDir);
  const installed: InstallationRecord[] = [];

  for (const platform of options.platforms) {
    const existingIndex = manifest.installations.findIndex(
      (record) =>
        record.platform === platform &&
        record.scope === options.scope &&
        record.projectRoot === (options.scope === 'project' ? options.projectDir : undefined),
    );
    if (existingIndex >= 0) {
      removeRecord(manifest.installations[existingIndex], options.homeDir, options.projectDir);
      manifest.installations.splice(existingIndex, 1);
      saveManifest(options.homeDir, manifest);
    }

    const destination = destinationFor(
      platform,
      options.scope,
      options.homeDir,
      options.projectDir,
    );
    const artifacts =
      platform === 'codex'
        ? installAgentsSection(sourceDir, destination)
        : platform === 'cursor'
          ? installCursorRule(sourceDir, destination)
          : copySkillFiles(sourceDir, destination);

    const record: InstallationRecord = {
      platform,
      scope: options.scope,
      projectRoot: options.scope === 'project' ? options.projectDir : undefined,
      artifacts,
    };
    manifest.installations.push(record);
    installed.push(record);
    saveManifest(options.homeDir, manifest);
  }

  return installed;
}

export interface UninstallSkillsOptions {
  homeDir: string;
  projectDir: string;
  projectOnly?: boolean;
  platforms?: AssistantPlatform[];
}

export function uninstallSkills(options: UninstallSkillsOptions): InstallationRecord[] {
  const manifest = loadManifest(options.homeDir);
  const matches = manifest.installations.filter((record) => {
    if (options.platforms && !options.platforms.includes(record.platform)) return false;
    if (!options.projectOnly) return true;
    return record.scope === 'project' && record.projectRoot === options.projectDir;
  });

  for (const record of matches) {
    removeRecord(record, options.homeDir, options.projectDir);
    manifest.installations = manifest.installations.filter((candidate) => candidate !== record);
    saveManifest(options.homeDir, manifest);
  }

  if (manifest.installations.length === 0) {
    fs.rmSync(manifestPath(options.homeDir), { force: true });
    removeEmptyParents(path.dirname(manifestPath(options.homeDir)), options.homeDir);
  }

  return matches;
}
