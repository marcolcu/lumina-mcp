export const SUPPORTED_PLATFORMS = ['claude', 'codex', 'cursor', 'gemini'] as const;

export type AssistantPlatform = (typeof SUPPORTED_PLATFORMS)[number];
export type InstallScope = 'user' | 'project';

export interface InstalledArtifact {
  kind: 'file' | 'agents-section';
  path: string;
  createdFile?: boolean;
}

export interface InstallationRecord {
  platform: AssistantPlatform;
  scope: InstallScope;
  projectRoot?: string;
  artifacts: InstalledArtifact[];
}

export interface InstallManifest {
  version: 1;
  installations: InstallationRecord[];
}
