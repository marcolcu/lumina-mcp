import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runManagementCommand } from '../../src/lumina/cli/cli.js';
import { detectPlatforms } from '../../src/lumina/cli/installer/detection.js';
import { installSkills, uninstallSkills } from '../../src/lumina/cli/installer/installer.js';

const temporaryRoots: string[] = [];
const sourceDir = path.resolve(process.cwd(), 'skills/lumina-mcp');

function createWorkspace(): { homeDir: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-installer-'));
  temporaryRoots.push(root);
  const homeDir = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  return { homeDir, projectDir };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('skill installer', () => {
  it('installs all user platform formats and uninstalls only Lumina artifacts', () => {
    const { homeDir, projectDir } = createWorkspace();
    const agentsPath = path.join(homeDir, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
    fs.writeFileSync(agentsPath, '# Existing instructions\n', 'utf8');

    const options = {
      platforms: ['claude', 'codex', 'cursor', 'gemini'] as const,
      scope: 'user' as const,
      homeDir,
      projectDir,
      sourceDir,
    };
    installSkills(options);
    installSkills(options);

    expect(fs.existsSync(path.join(homeDir, '.claude/skills/lumina-mcp/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(homeDir, '.gemini/skills/lumina-mcp/SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(homeDir, '.cursor/rules/lumina-mcp.mdc'), 'utf8')).toContain(
      'alwaysApply: true',
    );
    const agentsContent = fs.readFileSync(agentsPath, 'utf8');
    expect(agentsContent).toContain('# Existing instructions');
    expect(agentsContent.match(/lumina-mcp:skill:start/g)).toHaveLength(1);

    const removed = uninstallSkills({ homeDir, projectDir });
    expect(removed).toHaveLength(4);
    expect(fs.existsSync(path.join(homeDir, '.claude/skills/lumina-mcp/SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.gemini/skills/lumina-mcp/SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(homeDir, '.cursor/rules/lumina-mcp.mdc'))).toBe(false);
    expect(fs.readFileSync(agentsPath, 'utf8')).toContain('# Existing instructions');
    expect(fs.readFileSync(agentsPath, 'utf8')).not.toContain('lumina-mcp:skill:start');
    expect(fs.existsSync(path.join(homeDir, '.lumina-mcp/installations.json'))).toBe(false);
  });

  it('installs project-scoped files in the current project', () => {
    const { homeDir, projectDir } = createWorkspace();
    installSkills({
      platforms: ['claude', 'codex', 'cursor', 'gemini'],
      scope: 'project',
      homeDir,
      projectDir,
      sourceDir,
    });

    expect(fs.existsSync(path.join(projectDir, '.claude/skills/lumina-mcp/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.gemini/skills/lumina-mcp/SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.cursor/rules/lumina-mcp.mdc'))).toBe(true);
    expect(fs.readFileSync(path.join(projectDir, 'AGENTS.md'), 'utf8')).toContain(
      'lumina-mcp:skill:start',
    );

    const removed = uninstallSkills({ homeDir, projectDir, projectOnly: true });
    expect(removed).toHaveLength(4);
    expect(fs.existsSync(path.join(projectDir, 'AGENTS.md'))).toBe(false);
  });

  it('refuses to overwrite an unowned platform file', () => {
    const { homeDir, projectDir } = createWorkspace();
    const cursorRule = path.join(homeDir, '.cursor/rules/lumina-mcp.mdc');
    fs.mkdirSync(path.dirname(cursorRule), { recursive: true });
    fs.writeFileSync(cursorRule, 'user-owned', 'utf8');

    expect(() =>
      installSkills({
        platforms: ['cursor'],
        scope: 'user',
        homeDir,
        projectDir,
        sourceDir,
      }),
    ).toThrow(/Refusing to overwrite/);
    expect(fs.readFileSync(cursorRule, 'utf8')).toBe('user-owned');
  });

  it('detects assistant markers and supports CLI platform override', async () => {
    const { homeDir, projectDir } = createWorkspace();
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.cursor'), { recursive: true });

    expect(detectPlatforms({ homeDir, projectDir })).toEqual(['claude', 'cursor']);

    const messages: string[] = [];
    expect(
      await runManagementCommand(['install', '--project', '--platform', 'gemini'], {
        homeDir,
        projectDir,
        pathValue: '',
        log: (message) => messages.push(message),
      }),
    ).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.gemini/skills/lumina-mcp/SKILL.md'))).toBe(true);
    expect(messages).toEqual(['Installed lumina-mcp for gemini (project).']);
  });
});
