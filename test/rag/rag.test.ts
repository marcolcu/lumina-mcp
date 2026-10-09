import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildIndex } from '../../src/lumina/core/rag/indexer.js';
import { search } from '../../src/lumina/core/rag/retrieval.js';

const roots: string[] = [];
function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumina-rag-')); roots.push(root);
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'node_modules'));
  fs.mkdirSync(path.join(root, '.lumina', 'rag'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'storage.ts'), 'export function CompleteStorageByHU(id: string) { return id; }\nexport function other() { return true; }\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Storage\n\nRestores the previous bay when removing an HU.\n\n# Other\n\nUnrelated text.\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'secret.ts'), 'function CompleteStorageByHU() {}');
  fs.writeFileSync(path.join(root, '.lumina', 'rag', 'index.json'), JSON.stringify({
    version: 1, repository: root, generation: 1, files: {}, chunks: [],
  }));
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('local RAG index', () => {
  it('indexes symbols and excludes sensitive/generated directories', () => {
    const root = fixture(); const index = buildIndex(root);
    expect(index.chunks.some((chunk) => chunk.symbolName === 'CompleteStorageByHU')).toBe(true);
    expect(index.chunks.some((chunk) => chunk.filePath.includes('node_modules'))).toBe(false);
    expect(index.files).not.toHaveProperty('.lumina/rag/index.json');
  });

  it('prefers exact symbols and returns metadata without content for search', () => {
    const root = fixture(); const found = search(root, 'CompleteStorageByHU', { maxResults: 1 });
    expect(found.results[0].symbolName).toBe('CompleteStorageByHU');
    expect(found.results[0].reason).toBe('exact symbol match');
  });

  it('uses documentation chunks and enforces the token budget', () => {
    const root = fixture(); const found = search(root, 'previous bay removing HU', { documentType: 'documentation', maxTokens: 20 });
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.reduce((sum, item) => sum + item.tokenEstimate, 0)).toBeLessThanOrEqual(20);
  });

  it('updates changed files and removes deleted files', () => {
    const root = fixture(); const first = buildIndex(root); fs.writeFileSync(path.join(root, 'src', 'storage.ts'), 'export function NewSymbol() { return 1; }\n');
    const second = buildIndex(root, first); expect(second.chunks.some((chunk) => chunk.symbolName === 'NewSymbol')).toBe(true);
    fs.rmSync(path.join(root, 'README.md')); const third = buildIndex(root, second);
    expect(third.chunks.some((chunk) => chunk.filePath === 'README.md')).toBe(false);
  });

  it('keeps repeated searches stable and does not duplicate indexed chunks', () => {
    const root = fixture();
    const initial = search(root, 'CompleteStorageByHU', { maxResults: 2 });
    const indexFile = path.join(root, '.lumina', 'rag', 'index.json');
    const indexedAt = fs.statSync(indexFile).mtimeMs;
    for (let i = 0; i < 20; i += 1) {
      const repeated = search(root, 'CompleteStorageByHU', { maxResults: 2 });
      expect(repeated.results.map(({ id }) => id)).toEqual(initial.results.map(({ id }) => id));
      expect(new Set(repeated.index.chunks.map(({ id }) => id)).size).toBe(repeated.index.chunks.length);
      expect(repeated.index.generation).toBe(initial.index.generation);
    }
    expect(fs.statSync(indexFile).mtimeMs).toBe(indexedAt);
  });
});
