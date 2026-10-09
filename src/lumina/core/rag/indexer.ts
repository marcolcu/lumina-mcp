import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { RagChunk, RagIndex } from './types.js';
import { contentHash, estimateTokens, isIgnoredPath, splitLines } from './utils.js';

const CODE_EXTENSIONS: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript', '.go': 'go', '.py': 'python', '.java': 'java',
  '.rs': 'rust', '.rb': 'ruby', '.php': 'php', '.cs': 'csharp',
};
const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst']);

function* walk(root: string, current = root): Generator<string> {
  const entries = fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute);
    if (isIgnoredPath(relative)) continue;
    if (entry.isDirectory()) yield* walk(root, absolute);
    else yield absolute;
  }
}

function makeChunk(repository: string, filePath: string, language: string, content: string,
  startLine: number, endLine: number, symbolName?: string, symbolType?: string): RagChunk {
  const relative = path.relative(repository, filePath).replaceAll(path.sep, '/');
  const body = splitLines(content).slice(startLine - 1, endLine).join('\n');
  const hash = contentHash(body);
  return {
    id: `${relative}:${startLine}-${endLine}:${hash.slice(0, 12)}`,
    repository, filePath: relative, language, documentType: 'code', symbolName, symbolType,
    startLine, endLine, contentHash: hash, tokenEstimate: estimateTokens(body), content: body,
  };
}

function codeChunks(repository: string, filePath: string, language: string, source: string): RagChunk[] {
  const lines = splitLines(source);
  if (language !== 'typescript' && language !== 'javascript') {
    return [makeChunk(repository, filePath, language, source, 1, lines.length)];
  }
  const tree = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const chunks: RagChunk[] = [];
  function visit(node: ts.Node): void {
    const kind = ts.SyntaxKind[node.kind];
    const named = ts.isFunctionLike(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableStatement(node);
    if (named) {
      const name = (node as ts.NamedDeclaration).name?.getText(tree);
      const start = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      const end = tree.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      chunks.push(makeChunk(repository, filePath, language, source, start, end, name, kind));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return chunks.length > 0 ? chunks : [makeChunk(repository, filePath, language, source, 1, lines.length)];
}

function docChunks(repository: string, filePath: string, source: string): RagChunk[] {
  const lines = splitLines(source); const chunks: RagChunk[] = []; let start = 1; let title: string | undefined;
  for (let i = 0; i <= lines.length; i += 1) {
    if (i === lines.length || /^#{1,6}\s+/.test(lines[i])) {
      if (i >= start) {
        const body = lines.slice(start - 1, i).join('\n').trim();
        if (body) {
          const hash = contentHash(body);
          chunks.push({ id: `${path.relative(repository, filePath)}:${start}-${i}:${hash.slice(0, 12)}`,
            repository, filePath: path.relative(repository, filePath).replaceAll(path.sep, '/'),
            language: 'text', documentType: 'documentation', symbolName: title, symbolType: 'heading',
            startLine: start, endLine: i, contentHash: hash, tokenEstimate: estimateTokens(body), content: body });
        }
      }
      start = i + 1; title = i < lines.length ? lines[i].replace(/^#+\s+/, '').trim() : undefined;
    }
  }
  return chunks;
}

export function buildIndex(repository: string, previous?: RagIndex): RagIndex {
  const files: RagIndex['files'] = {}; const chunks: RagChunk[] = [];
  const previousChunks = new Map(previous?.chunks.map((chunk) => [chunk.id, chunk]));
  let changed = previous === undefined;
  for (const filePath of walk(repository)) {
    const relative = path.relative(repository, filePath).replaceAll(path.sep, '/');
    const source = fs.readFileSync(filePath, 'utf8'); const hash = contentHash(source);
    const old = previous?.files[relative];
    if (old?.contentHash === hash) {
      files[relative] = old;
      for (const id of old.chunkIds) {
        const chunk = previousChunks.get(id);
        if (chunk) chunks.push(chunk);
      }
      continue;
    }
    changed = true;
    const extension = path.extname(filePath).toLowerCase();
    const fresh = CODE_EXTENSIONS[extension] ? codeChunks(repository, filePath, CODE_EXTENSIONS[extension], source)
      : DOC_EXTENSIONS.has(extension) ? docChunks(repository, filePath, source) : [];
    files[relative] = { contentHash: hash, chunkIds: fresh.map((chunk) => chunk.id) }; chunks.push(...fresh);
  }
  if (previous && Object.keys(previous.files).length !== Object.keys(files).length) changed = true;
  return {
    version: 1,
    repository,
    revision: undefined,
    generation: (previous?.generation ?? 0) + (changed ? 1 : 0),
    files,
    chunks,
  };
}
