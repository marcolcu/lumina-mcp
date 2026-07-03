import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Checks if the Compound Engineering plugin/server is available in the current environment.
 * It checks environment variables, common plugin directories, and MCP client config files.
 */
export function hasCompoundEngineering(): boolean {
  // 1. Check environment variable override
  if (
    process.env.HAS_COMPOUND_ENGINEERING === 'true' ||
    process.env.HAS_COMPOUND_ENGINEERING === '1'
  ) {
    return true;
  }

  const homeDir = os.homedir();

  // 2. Check common plugin/workspace directories
  const commonPaths = [
    path.join(homeDir, '.gemini', 'config', 'plugins', 'compound-engineering'),
    path.join(homeDir, '.compound-engineering'),
    path.join(process.cwd(), '.compound-engineering'),
  ];

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      return true;
    }
  }

  // 3. Check popular MCP Client config files (Claude Desktop, Cursor, VSCode/Cline, Roo Code)
  const mcpConfigFiles = [
    // Claude Desktop (Mac)
    path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    // Claude Desktop (Windows)
    path.join(homeDir, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    // Cline / Roo Code in VS Code (Mac)
    path.join(
      homeDir,
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
    path.join(
      homeDir,
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings',
      'cline_mcp_settings.json',
    ),
    // Cline / Roo Code in Cursor (Mac)
    path.join(
      homeDir,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
    path.join(
      homeDir,
      'Library',
      'Application Support',
      'Cursor',
      'User',
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings',
      'cline_mcp_settings.json',
    ),
    // Claude Code CLI config
    path.join(homeDir, '.claude.json'),
  ];

  for (const configFile of mcpConfigFiles) {
    try {
      if (fs.existsSync(configFile)) {
        const content = fs.readFileSync(configFile, 'utf-8');
        if (content.includes('compound-engineering') || content.includes('ce-work')) {
          return true;
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  return false;
}
