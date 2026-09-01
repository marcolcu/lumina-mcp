import fs from 'node:fs';
import path from 'node:path';
import {
  SUPPORTED_PLATFORMS,
  type AssistantPlatform,
} from './types.js';

const PLATFORM_MARKERS: Record<AssistantPlatform, string> = {
  claude: '.claude',
  codex: '.codex',
  cursor: '.cursor',
  gemini: '.gemini',
};

const PLATFORM_COMMANDS: Record<AssistantPlatform, string> = {
  claude: 'claude',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini',
};

function commandExists(command: string, pathValue: string | undefined): boolean {
  if (!pathValue) {
    return false;
  }

  return pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .some((directory) => fs.existsSync(path.join(directory, command)));
}

export interface DetectPlatformsOptions {
  homeDir: string;
  projectDir: string;
  pathValue?: string;
}

export function detectPlatforms(options: DetectPlatformsOptions): AssistantPlatform[] {
  return SUPPORTED_PLATFORMS.filter((platform) => {
    const marker = PLATFORM_MARKERS[platform];
    return (
      fs.existsSync(path.join(options.homeDir, marker)) ||
      fs.existsSync(path.join(options.projectDir, marker)) ||
      commandExists(PLATFORM_COMMANDS[platform], options.pathValue) ||
      (platform === 'codex' && fs.existsSync(path.join(options.projectDir, 'AGENTS.md')))
    );
  });
}

export function parsePlatformNames(values: string[] | undefined): AssistantPlatform[] | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }

  const requested = values.flatMap((value) => value.split(',')).map((value) => value.trim());
  if (requested.includes('all')) {
    return [...SUPPORTED_PLATFORMS];
  }

  const aliases: Record<string, AssistantPlatform> = {
    claude: 'claude',
    'claude-code': 'claude',
    codex: 'codex',
    cursor: 'cursor',
    gemini: 'gemini',
    'gemini-cli': 'gemini',
  };

  const invalid = requested.filter((name) => !aliases[name]);
  if (invalid.length > 0) {
    throw new Error(`Unsupported platform: ${invalid.join(', ')}.`);
  }

  return Array.from(new Set(requested.map((name) => aliases[name])));
}
