import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { search } from '../../../lumina/core/rag/index.js';

const SearchSchema = {
  query: z.string().min(1).describe('Identifier, keywords, or task description.'),
  repositoryPath: z.string().optional().describe('Repository root; defaults to the current directory.'),
  directory: z.string().optional(),
  language: z.string().optional(),
  maxResults: z.number().int().positive().max(50).optional(),
  maxTokens: z.number().int().positive().max(20000).optional(),
};
const RangeSchema = {
  file: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  repositoryPath: z.string().optional(),
};

function root(value?: string): string { return path.resolve(value ?? process.cwd()); }
function resultText(results: ReturnType<typeof search>['results']): string {
  return JSON.stringify(results.map(({ content: _content, ...metadata }) => metadata), null, 2);
}
function safeFile(rootPath: string, file: string): string {
  const resolved = path.resolve(rootPath, file);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) throw new Error('File must be inside the repository.');
  return resolved;
}

export function registerRagController(server: McpServer): void {
  server.registerTool('search_code', {
    description: 'Use when compact local code search is needed; returns ranked symbols and line ranges, not full files.',
    inputSchema: SearchSchema,
  }, async ({ query, repositoryPath, ...options }) => ({ content: [{ type: 'text', text: resultText(search(root(repositoryPath), query, { ...options, documentType: 'code' }).results) }] }));

  server.registerTool('search_docs', {
    description: 'Use when compact local documentation search is needed; returns ranked sections and line ranges.',
    inputSchema: SearchSchema,
  }, async ({ query, repositoryPath, ...options }) => ({ content: [{ type: 'text', text: resultText(search(root(repositoryPath), query, { ...options, documentType: 'documentation' }).results) }] }));

  server.registerTool('find_symbol', {
    description: 'Use when you know an exact local function, class, interface, or constant name.',
    inputSchema: SearchSchema,
  }, async ({ query, repositoryPath, ...options }) => ({ content: [{ type: 'text', text: resultText(search(root(repositoryPath), query, { ...options, documentType: 'code' }).results) }] }));

  server.registerTool('get_context', {
    description: 'Use when a coding task needs minimum sufficient local context under a token budget.',
    inputSchema: { task: z.string().min(1), repositoryPath: z.string().optional(), maxTokens: z.number().int().positive().max(20000).optional().default(4000), maxResults: z.number().int().positive().max(50).optional().default(10) },
  }, async ({ task, repositoryPath, maxTokens, maxResults }) => {
    const found = search(root(repositoryPath), task, { maxTokens, maxResults });
    return { content: [{ type: 'text', text: JSON.stringify({ query: task, estimated_tokens: found.results.reduce((sum, item) => sum + item.tokenEstimate, 0), results: found.results }, null, 2) }] };
  });

  server.registerTool('find_references', {
    description: 'Use when finding local source locations that reference a known symbol or identifier.',
    inputSchema: SearchSchema,
  }, async ({ query, repositoryPath, ...options }) => ({ content: [{ type: 'text', text: resultText(search(root(repositoryPath), query, { ...options, documentType: 'code' }).results) }] }));

  server.registerTool('get_symbol', {
    description: 'Use after search_code or find_symbol identifies the symbol whose source is needed.',
    inputSchema: SearchSchema,
  }, async ({ query, repositoryPath }) => ({ content: [{ type: 'text', text: JSON.stringify(search(root(repositoryPath), query, { documentType: 'code', maxResults: 1 }).results, null, 2) }] }));

  server.registerTool('read_range', {
    description: 'Use when an exact local file line range is needed; paths are restricted to the repository.',
    inputSchema: RangeSchema,
  }, async ({ file, startLine, endLine, repositoryPath }) => {
    if (endLine < startLine) return { isError: true, content: [{ type: 'text', text: 'endLine must be greater than or equal to startLine.' }] };
    const filePath = safeFile(root(repositoryPath), file);
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).slice(startLine - 1, endLine);
    return { content: [{ type: 'text', text: JSON.stringify({ file, startLine, endLine, content: lines.join('\n') }, null, 2) }] };
  });
}
