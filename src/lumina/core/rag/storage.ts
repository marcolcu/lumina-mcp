import fs from 'node:fs';
import path from 'node:path';
import type { RagIndex } from './types.js';

export function loadIndex(repository: string): RagIndex | undefined {
  const file = path.join(repository, '.lumina', 'rag', 'index.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as RagIndex; } catch { return undefined; }
}

export function saveIndex(index: RagIndex): void {
  const directory = path.join(index.repository, '.lumina', 'rag');
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `index.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(index), 'utf8');
  fs.renameSync(temporary, path.join(directory, 'index.json'));
}
