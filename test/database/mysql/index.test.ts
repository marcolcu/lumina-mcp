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

const { mockExecuteMySQLQuery } = vi.hoisted(() => ({
  mockExecuteMySQLQuery: vi.fn(),
}));

vi.mock('../../../src/tools/database/mysql/service/mysql.service.js', () => ({
  runMySQLQuery: mockExecuteMySQLQuery,
}));

// Mock postgresql service to avoid unexpected calls or side effects
vi.mock('../../../src/tools/database/postgresql/service/postgresql.service.js', () => ({
  runPostgresQuery: vi.fn(),
}));

// Mock mysql repository for actual database call simulations during service testing
vi.mock('../../../src/tools/database/mysql/repository/mysql.repository.js', () => ({
  getMySQLPool: () => ({
    getConnection: vi.fn().mockResolvedValue({
      execute: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('EXPLAIN ANALYZE')) {
          return [[{ 'EXPLAIN ANALYZE': 'explain analyze result' }]];
        }
        return [
          [
            {
              id: 1,
              select_type: 'SIMPLE',
              table: 'users',
              type: 'ALL',
              possible_keys: null,
              key: null,
              key_len: null,
              ref: null,
              rows: 15000,
              filtered: 100,
              Extra: 'Using filesort; Using temporary',
            },
          ],
        ];
      }),
      query: vi.fn().mockResolvedValue([[]]),
      release: vi.fn(),
    }),
  }),
  executeMySQLQuery: vi.fn(),
}));

// Set NODE_ENV to test to prevent main() auto-run, then import server
process.env.NODE_ENV = 'test';
import { server } from '../../../src/index.js';

describe('MySQL Database Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call execute_mysql_query with correct parameters', async () => {
    mockExecuteMySQLQuery.mockResolvedValueOnce([{ id: 1, name: 'Alice' }]);

    const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
      'tools/call',
    );
    expect(callHandler).toBeDefined();

    const response = await callHandler!({
      method: 'tools/call',
      params: {
        name: 'execute_mysql_query',
        arguments: {
          query: 'SELECT * FROM users WHERE id = ?',
          parameters: ['1'],
        },
      },
    });

    expect(mockExecuteMySQLQuery).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE id = ?',
      ['1'],
      undefined,
    );
    expect(response).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify([{ id: 1, name: 'Alice' }], null, 2),
        },
      ],
    });
  });

  it('should return error for invalid parameters', async () => {
    const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
      'tools/call',
    );

    const response = await callHandler!({
      method: 'tools/call',
      params: {
        name: 'execute_mysql_query',
        arguments: {
          // Missing query parameter
          parameters: ['1'],
        },
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content![0].text).toContain('Input validation error:');
  });

  it('should validate read-only queries correctly', async () => {
    const { validateReadOnlyMySQLQuery } = await vi.importActual<
      typeof import('../../../src/tools/database/mysql/service/mysql.service.js')
    >('../../../src/tools/database/mysql/service/mysql.service.js');

    // Valid queries
    expect(() => validateReadOnlyMySQLQuery('SELECT * FROM users')).not.toThrow();
    expect(() => validateReadOnlyMySQLQuery('  select id from products; ')).not.toThrow();
    expect(() =>
      validateReadOnlyMySQLQuery('WITH cte AS (SELECT 1) SELECT * FROM cte'),
    ).not.toThrow();
    expect(() => validateReadOnlyMySQLQuery('SHOW TABLES')).not.toThrow();
    expect(() => validateReadOnlyMySQLQuery('DESCRIBE users')).not.toThrow();
    expect(() => validateReadOnlyMySQLQuery('EXPLAIN SELECT * FROM users')).not.toThrow();

    // Invalid queries (non-select/non-read-only)
    expect(() => validateReadOnlyMySQLQuery('INSERT INTO users VALUES (1)')).toThrow();
    expect(() => validateReadOnlyMySQLQuery('UPDATE users SET name = "Bob"')).toThrow();
    expect(() => validateReadOnlyMySQLQuery('DELETE FROM users')).toThrow();
    expect(() => validateReadOnlyMySQLQuery('DROP TABLE users')).toThrow();
    expect(() => validateReadOnlyMySQLQuery('CREATE TABLE users (id INT)')).toThrow();

    // SQL Injection detection (tautologies, comments, union select)
    expect(() => validateReadOnlyMySQLQuery('SELECT * FROM users WHERE id = 1 OR 1=1')).toThrow();
    expect(() =>
      validateReadOnlyMySQLQuery("SELECT * FROM users WHERE username = 'admin' OR 'a'='a'"),
    ).toThrow();
    expect(() => validateReadOnlyMySQLQuery('SELECT * FROM users -- comment')).toThrow();
    expect(() => validateReadOnlyMySQLQuery('SELECT * FROM users /* comment */')).toThrow();
    expect(() => validateReadOnlyMySQLQuery('SELECT * FROM users # comment')).toThrow();
    expect(() =>
      validateReadOnlyMySQLQuery('SELECT * FROM users UNION SELECT * FROM passwords'),
    ).toThrow();
    expect(() =>
      validateReadOnlyMySQLQuery('SELECT * FROM users WHERE active = true OR true'),
    ).toThrow();
  });

  it('should filter sensitive columns correctly', async () => {
    const { filterSensitiveColumns, clearRestrictedColumnsCache } = await vi.importActual<
      typeof import('../../../src/tools/database/utils/security.js')
    >('../../../src/tools/database/utils/security.js');

    // Default filters
    clearRestrictedColumnsCache();
    const rows = [
      {
        id: 1,
        username: 'admin',
        password: 'secretpassword',
        token: 'sometoken',
        email: 'admin@test.com',
      },
    ];
    const filtered = filterSensitiveColumns(rows);
    expect(filtered[0]).toEqual({ id: 1, username: 'admin', email: 'admin@test.com' });
    expect(filtered[0]).not.toHaveProperty('password');
    expect(filtered[0]).not.toHaveProperty('token');

    // Custom filters
    const fs = await import('fs');
    const path = await import('path');
    const dirPath = path.join(process.cwd(), '.lumina/database');
    const filePath = path.join(dirPath, 'restricColumn_mysql.json');
    process.env.LUMINA_RESTRICTED_COLUMNS_PATH = filePath;

    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify({ COLUMNS: ['email', 'username'] }));

      clearRestrictedColumnsCache();

      const customFiltered = filterSensitiveColumns(rows);
      expect(customFiltered[0]).toEqual({ id: 1 });
      expect(customFiltered[0]).not.toHaveProperty('password'); // defaults are still restricted
      expect(customFiltered[0]).not.toHaveProperty('token');
      expect(customFiltered[0]).not.toHaveProperty('email');
      expect(customFiltered[0]).not.toHaveProperty('username');
    } finally {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      delete process.env.LUMINA_RESTRICTED_COLUMNS_PATH;
      clearRestrictedColumnsCache();
    }
  });

  it('should analyze MySQL query plan correctly', async () => {
    const { analyzeMySQLQueryPlan } = await vi.importActual<
      typeof import('../../../src/tools/database/mysql/service/mysql.service.js')
    >('../../../src/tools/database/mysql/service/mysql.service.js');

    const result = await analyzeMySQLQueryPlan('SELECT * FROM users ORDER BY created_at');
    expect(result.explainRows).toBeDefined();
    expect(result.tableAnalysis).toBeDefined();
    expect(result.seniorAudit).toBeDefined();
    expect(result.seniorAudit.performanceVerdict).toBe('CRITICAL');
    expect(result.seniorAudit.speedVerdict).toBe('SLOW');
    expect(result.seniorAudit.securityVerdict).toBe('WARNING');
  });
});
