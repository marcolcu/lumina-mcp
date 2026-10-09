import { describe, it, expect, vi, beforeEach } from 'vitest';

interface ServerWithHandlers {
  _requestHandlers: Map<
    string,
    (request: { method: string; params?: unknown }) => Promise<{
      tools?: unknown[];
      content?: Array<{ type: string; text: string }>;
      isError?: boolean;
    }>
  >;
}

// Mock database services to prevent actual calls/connections during imports
vi.mock('../src/tools/database/mysql/service/mysql.service.js', () => ({
  runMySQLQuery: vi.fn(),
}));

vi.mock('../src/tools/database/postgresql/service/postgresql.service.js', () => ({
  runPostgresQuery: vi.fn(),
}));

// Set NODE_ENV to test to prevent main() auto-run, then import server
process.env.NODE_ENV = 'test';
import { server } from '../src/index.js';

describe('Lumina MCP Database Tools Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should list available tools', async () => {
    // Retrieve registered list tools request handler from the underlying low-level server
    const listHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
      'tools/list',
    );
    expect(listHandler).toBeDefined();

    const response = await listHandler!({ method: 'tools/list' });
    expect(response.tools).toBeDefined();
    expect(response.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'execute_mysql_query' }),
        expect.objectContaining({ name: 'list_mysql_tables' }),
        expect.objectContaining({ name: 'inspect_mysql_table' }),
        expect.objectContaining({ name: 'analyze_mysql_query' }),
        expect.objectContaining({ name: 'execute_postgres_query' }),
        expect.objectContaining({ name: 'list_postgresql_tables' }),
        expect.objectContaining({ name: 'inspect_postgresql_table' }),
        expect.objectContaining({ name: 'analyze_postgresql_query' }),
        expect.objectContaining({ name: 'lumina_memory_stats' }),
      ]),
    );
  });
});
