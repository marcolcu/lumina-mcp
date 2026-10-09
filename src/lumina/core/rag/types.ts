export type DocumentType = 'code' | 'documentation';

export interface RagChunk {
  id: string;
  repository: string;
  revision?: string;
  filePath: string;
  language: string;
  documentType: DocumentType;
  symbolName?: string;
  symbolType?: string;
  module?: string;
  startLine: number;
  endLine: number;
  contentHash: string;
  tokenEstimate: number;
  content: string;
}

export interface RagIndex {
  version: 1;
  repository: string;
  revision?: string;
  generation: number;
  files: Record<string, { contentHash: string; chunkIds: string[] }>;
  chunks: RagChunk[];
}

export interface RagFilters {
  repository?: string;
  branch?: string;
  language?: string;
  directory?: string;
  documentType?: DocumentType;
  symbolType?: string;
}

export interface RagResult extends RagChunk {
  relevance: number;
  reason: string;
}

export interface RagSearchOptions extends RagFilters {
  maxResults?: number;
  maxTokens?: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(text: string): Promise<number[]>;
}
