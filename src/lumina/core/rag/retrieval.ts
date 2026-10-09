import fs from 'node:fs';
import path from 'node:path';
import type { RagFilters, RagIndex, RagResult, RagSearchOptions } from './types.js';
import { buildIndex } from './indexer.js';
import { loadIndex, saveIndex } from './storage.js';
import { normalize, terms } from './utils.js';

function freshIndex(repository: string): RagIndex {
  const previous = loadIndex(repository);
  const current = buildIndex(repository, previous);
  if (!previous || current.generation !== previous.generation) saveIndex(current);
  return current;
}
function matches(chunk: RagIndex['chunks'][number], filters: RagFilters): boolean {
  return (!filters.repository || chunk.repository === filters.repository) &&
    (!filters.language || chunk.language === filters.language) &&
    (!filters.directory || chunk.filePath.startsWith(filters.directory.replace(/\/$/, '') + '/')) &&
    (!filters.documentType || chunk.documentType === filters.documentType) &&
    (!filters.symbolType || chunk.symbolType === filters.symbolType);
}
export function search(repository: string, query: string, options: RagSearchOptions = {}): { index: RagIndex; results: RagResult[] } {
  if (!fs.existsSync(repository)) throw new Error(`Repository does not exist: ${repository}`);
  const index = freshIndex(path.resolve(repository)); const queryTerms = terms(query); const exact = normalize(query);
  const ranked: Array<{ chunk: RagIndex['chunks'][number]; relevance: number; reason: string }> = [];
  for (const chunk of index.chunks) {
    if (!matches(chunk, options)) continue;
    const haystack = normalize(`${chunk.filePath} ${chunk.symbolName ?? ''} ${chunk.content}`);
    const hits = queryTerms.filter((term) => haystack.includes(term)).length;
    const exactSymbol = chunk.symbolName && normalize(chunk.symbolName) === exact;
    const pathHit = normalize(chunk.filePath).includes(exact);
    const relevance = (exactSymbol ? 1 : 0) + (pathHit ? 0.35 : 0) + (hits / Math.max(queryTerms.length, 1)) * 0.65;
    if (relevance > 0) ranked.push({
      chunk,
      relevance,
      reason: exactSymbol ? 'exact symbol match' : pathHit ? 'path match' : 'lexical match',
    });
  }
  ranked.sort((a, b) => b.relevance - a.relevance || a.chunk.filePath.localeCompare(b.chunk.filePath) || a.chunk.startLine - b.chunk.startLine);
  const selected: RagResult[] = []; const seen = new Set<string>(); let budget = options.maxTokens ?? 4000;
  for (const { chunk, relevance, reason } of ranked) {
    if (seen.has(chunk.contentHash) || chunk.tokenEstimate > budget) continue;
    selected.push({ ...chunk, relevance, reason }); seen.add(chunk.contentHash); budget -= chunk.tokenEstimate;
    if (selected.length >= (options.maxResults ?? 10)) break;
  }
  return { index, results: selected };
}
