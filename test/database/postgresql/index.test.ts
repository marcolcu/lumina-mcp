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

const { mockExecutePostgresQuery } = vi.hoisted(() => ({
  mockExecutePostgresQuery: vi.fn(),
}));

vi.mock('../../../src/tools/database/postgresql/service/postgresql.service.js', () => ({
  runPostgresQuery: mockExecutePostgresQuery,
}));

// Mock mysql service to avoid unexpected calls or side effects
vi.mock('../../../src/tools/database/mysql/service/mysql.service.js', () => ({
  runMySQLQuery: vi.fn(),
}));

// Mock postgres repository for actual database call simulations during service testing
vi.mock('../../../src/tools/database/postgresql/repository/postgresql.repository.js', () => ({
  executePostgresQuery: vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('EXPLAIN ANALYZE')) {
      return [
        {
          'QUERY PLAN':
            'Seq Scan on users  (cost=0.00..15.00 rows=1000 width=40) (actual time=0.01..0.02 rows=1000)',
        },
      ];
    }
    return [{ 'QUERY PLAN': 'Seq Scan on users  (cost=0.00..15.00 rows=1000 width=40)' }];
  }),
}));

// Set NODE_ENV to test to prevent main() auto-run, then import server
process.env.NODE_ENV = 'test';
import { server } from '../../../src/index.js';

describe('PostgreSQL Database Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call execute_postgres_query with correct parameters', async () => {
    mockExecutePostgresQuery.mockResolvedValueOnce([{ id: 2, name: 'Bob' }]);

    const callHandler = (server.server as unknown as ServerWithHandlers)._requestHandlers.get(
      'tools/call',
    );
    expect(callHandler).toBeDefined();

    const response = await callHandler!({
      method: 'tools/call',
      params: {
        name: 'execute_postgres_query',
        arguments: {
          query: 'SELECT * FROM users WHERE id = $1',
          parameters: ['2'],
        },
      },
    });

    expect(mockExecutePostgresQuery).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE id = $1',
      ['2'],
      undefined,
    );
    expect(response).toEqual({
      content: [
        {
          type: 'text',
          text: JSON.stringify([{ id: 2, name: 'Bob' }], null, 2),
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
        name: 'execute_postgres_query',
        arguments: {
          // Missing query parameter
          parameters: ['2'],
        },
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content![0].text).toContain('Input validation error:');
  });

  it('should validate read-only queries correctly', async () => {
    const { validateReadOnlyPostgresQuery } = await vi.importActual<
      typeof import('../../../src/tools/database/postgresql/service/postgresql.service.js')
    >('../../../src/tools/database/postgresql/service/postgresql.service.js');

    // Valid queries
    expect(() => validateReadOnlyPostgresQuery('SELECT * FROM users')).not.toThrow();
    expect(() => validateReadOnlyPostgresQuery('  select id from products; ')).not.toThrow();
    expect(() =>
      validateReadOnlyPostgresQuery('WITH cte AS (SELECT 1) SELECT * FROM cte'),
    ).not.toThrow();
    expect(() => validateReadOnlyPostgresQuery('SHOW TABLES')).not.toThrow();
    expect(() => validateReadOnlyPostgresQuery('DESCRIBE users')).not.toThrow();
    expect(() => validateReadOnlyPostgresQuery('EXPLAIN SELECT * FROM users')).not.toThrow();

    // Invalid queries (non-select/non-read-only)
    expect(() => validateReadOnlyPostgresQuery('INSERT INTO users VALUES (1)')).toThrow();
    expect(() => validateReadOnlyPostgresQuery('UPDATE users SET name = "Bob"')).toThrow();
    expect(() => validateReadOnlyPostgresQuery('DELETE FROM users')).toThrow();
    expect(() => validateReadOnlyPostgresQuery('DROP TABLE users')).toThrow();
    expect(() => validateReadOnlyPostgresQuery('CREATE TABLE users (id INT)')).toThrow();

    // SQL Injection detection (tautologies, comments, union select)
    expect(() =>
      validateReadOnlyPostgresQuery('SELECT * FROM users WHERE id = 1 OR 1=1'),
    ).toThrow();
    expect(() =>
      validateReadOnlyPostgresQuery("SELECT * FROM users WHERE username = 'admin' OR 'a'='a'"),
    ).toThrow();
    expect(() => validateReadOnlyPostgresQuery('SELECT * FROM users -- comment')).toThrow();
    expect(() => validateReadOnlyPostgresQuery('SELECT * FROM users /* comment */')).toThrow();
    expect(() => validateReadOnlyPostgresQuery('SELECT * FROM users # comment')).toThrow();
    expect(() =>
      validateReadOnlyPostgresQuery('SELECT * FROM users UNION SELECT * FROM passwords'),
    ).toThrow();
    expect(() =>
      validateReadOnlyPostgresQuery('SELECT * FROM users WHERE active = true OR true'),
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
    const filePath = path.join(dirPath, 'restricColumn_pg.json');
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

  it('should analyze PostgreSQL query plan correctly', async () => {
    const { analyzePostgresQueryPlan } = await vi.importActual<
      typeof import('../../../src/tools/database/postgresql/service/postgresql.service.js')
    >('../../../src/tools/database/postgresql/service/postgresql.service.js');

    const result = await analyzePostgresQueryPlan('SELECT * FROM users ORDER BY created_at');
    expect(result.explainPlan).toBeDefined();
    expect(result.seniorAudit).toBeDefined();
    expect(result.seniorAudit.performanceVerdict).toBe('NEEDS_OPTIMIZATION');
    expect(result.seniorAudit.securityVerdict).toBe('WARNING');
  });
});
