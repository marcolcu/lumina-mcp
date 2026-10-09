import { createHash } from 'node:crypto';

export function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9_./-]+/g, ' ').trim();
}

export function terms(value: string): string[] {
  return normalize(value).split(/\s+/).filter((term) => term.length > 1);
}

export function isIgnoredPath(relativePath: string): boolean {
  const path = relativePath.replaceAll('\\', '/');
  return /^(\.git|node_modules|vendor|dist|build|coverage)(\/|$)/.test(path)
    || /^\.lumina\/rag(\/|$)/.test(path)
    || /(^|\/)(\.env(?:\.[^/]+)?|credentials(?:\.[^/]+)?)(\/|$)/i.test(path)
    || /\.(pem|key)$/i.test(path)
    || /(^|\/)(generated|artifacts)(\/|$)/i.test(path);
}

export function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}
