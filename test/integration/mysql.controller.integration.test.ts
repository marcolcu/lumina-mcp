import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MySqlContainer, StartedMySqlContainer } from '@testcontainers/mysql';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerMysqlController } from '../../src/tools/database/mysql/controller/mysql.controller.js';
import { executeMySQLQuery, getMySQLPool } from '../../src/tools/database/mysql/repository/mysql.repository.js';

describe('MySQL Controller Integration Tests', () => {
  let mysqlContainer: StartedMySqlContainer;
  let client: Client;
  let server: McpServer;
  const dbName = 'lumina_test_db';

  beforeAll(async () => {
    // 1. Start MySQL Testcontainer
    // This provides an ephemeral, isolated MySQL database instance
    mysqlContainer = await new MySqlContainer("mysql:8.0")
      .withDatabase(dbName)
      .withRootPassword('testroot')
      .start();

    // 2. Set environment variables so the repository connects to the test container
    process.env.MYSQL_HOST = mysqlContainer.getHost();
    process.env.MYSQL_PORT = mysqlContainer.getPort().toString();
    process.env.MYSQL_USER = 'root';
    process.env.MYSQL_PASSWORD = 'testroot';
    process.env.MYSQL_DATABASE = dbName;
    process.env.MYSQL_URL = ''; // Clear URI to force discrete variables

    // 3. Seed some test data directly using the repository
    await executeMySQLQuery(`
      CREATE TABLE users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL,
        email VARCHAR(100) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await executeMySQLQuery(`
      INSERT INTO users (username, email) VALUES 
      ('alice', 'alice@example.com'),
      ('bob', 'bob@example.com')
    `);

    // 4. Setup MCP Server and Client using InMemoryTransport
    server = new McpServer({
      name: 'Test Server',
      version: '1.0.0',
    });
    registerMysqlController(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client(
      {
        name: 'Test Client',
        version: '1.0.0',
      },
      { capabilities: {} }
    );
    await client.connect(clientTransport);
  }, 60000); // 60s timeout for downloading docker image

  afterAll(async () => {
    if (client) await client.close();
    if (server) await server.close();

    try {
      const pool = getMySQLPool(dbName);
      if (pool) {
        await pool.end();
      }
    } catch (e) {
      console.warn('Failed to close MySQL pool during teardown', e);
    }

    if (mysqlContainer) {
      await mysqlContainer.stop();
    }
  });

  describe('Happy Path', () => {
    it('list_mysql_tables should return the list of tables', async () => {
      const response = await client.callTool({
        name: 'list_mysql_tables',
        arguments: { databaseName: dbName },
      });

      expect(response.isError).toBeFalsy();
      const content = (response.content as unknown[])[0] as { type: 'text', text: string };
      const parsed = JSON.parse(content.text) as Record<string, unknown>[];
      
      // Look for the users table
      const hasUsersTable = parsed.some((row: Record<string, unknown>) => Object.values(row)[0] === 'users');
      expect(hasUsersTable).toBe(true);
    });

    it('execute_mysql_query should execute a valid SELECT query', async () => {
      const response = await client.callTool({
        name: 'execute_mysql_query',
        arguments: {
          query: 'SELECT username, email FROM users ORDER BY username ASC',
          databaseName: dbName,
        },
      });

      expect(response.isError).toBeFalsy();
      const content = (response.content as unknown[])[0] as { type: 'text', text: string };
      const rows = JSON.parse(content.text) as Record<string, unknown>[];

      expect(rows).toHaveLength(2);
      expect(rows[0].username).toBe('alice');
      expect(rows[1].username).toBe('bob');
    });

    it('inspect_mysql_table should return schema for users table', async () => {
      const response = await client.callTool({
        name: 'inspect_mysql_table',
        arguments: {
          table: 'users',
          databaseName: dbName,
        },
      });

      if (response.isError) {
        console.error('inspect_mysql_table error:', (response.content as unknown[])[0]);
      }
      expect(response.isError).toBeFalsy();
      const content = (response.content as unknown[])[0] as { type: 'text', text: string };
      const rows = JSON.parse(content.text) as Record<string, unknown>[];

      expect(rows.length).toBeGreaterThan(0);
      const fields = rows.map((r: Record<string, unknown>) => r.Field);
      expect(fields).toContain('id');
      expect(fields).toContain('username');
      expect(fields).toContain('email');
    });

    it('analyze_mysql_query should return execution plan and auditor report', async () => {
      const response = await client.callTool({
        name: 'analyze_mysql_query',
        arguments: {
          query: 'SELECT * FROM users WHERE email = "alice@example.com"',
          databaseName: dbName,
        },
      });

      expect(response.isError).toBeFalsy();
      const content = (response.content as unknown[])[0] as { type: 'text', text: string };
      const result = JSON.parse(content.text) as {
        explainRows: Record<string, unknown>[];
        tableAnalysis: Record<string, unknown>;
        seniorAudit: {
          performanceVerdict: string;
          securityVerdict: string;
          notes: string[];
        };
      };

      // Verify structure of the response
      expect(result).toHaveProperty('explainRows');
      expect(result).toHaveProperty('tableAnalysis');
      expect(result).toHaveProperty('seniorAudit');

      // The auditor should catch the "SELECT *" and lack of indexes
      const audit = result.seniorAudit;
      expect(audit.performanceVerdict).toBeDefined();
      expect(audit.securityVerdict).toBe('WARNING'); // Because of SELECT *
      expect(audit.notes.some((n: string) => n.includes('SELECT *'))).toBe(true);
      expect(audit.notes.some((n: string) => n.includes('hardcoded string literals'))).toBe(true);
    });
  });

  describe('Negative Path & Security', () => {
    it('execute_mysql_query should reject UPDATE queries', async () => {
      const response = await client.callTool({
        name: 'execute_mysql_query',
        arguments: {
          query: 'UPDATE users SET email = "hacked@example.com"',
          databaseName: dbName,
        },
      });

      expect(response.isError).toBe(true);
      const content = (response.content as unknown[])[0] as { type: 'text', text: string };
      expect(content.text).toContain('Database Error:');
      expect(content.text).toContain('Database Error: Only SELECT or read-only queries are allowed.');
    });

    it('execute_mysql_query should reject INSERT queries', async () => {
      const response = await client.callTool({
        name: 'execute_mysql_query',
        arguments: {
          query: 'INSERT INTO users (username) VALUES ("eve")',
          databaseName: dbName,
        },
      });

      expect(response.isError).toBe(true);
      const content = (response.content as unknown[])[0] as { type: 'text', text: string };
      expect(content.text).toContain('Database Error: Only SELECT or read-only queries are allowed.');
    });

    it('execute_mysql_query should handle invalid syntax gracefully without crashing', async () => {
      const response = await client.callTool({
        name: 'execute_mysql_query',
        arguments: {
          query: 'SELECT * FROM nonexistent_table',
          databaseName: dbName,
        },
      });

      expect(response.isError).toBe(true);
      const content = (response.content as unknown[])[0] as { type: 'text', text: string };
      // Database specific error
      expect(content.text).toContain('Table \'lumina_test_db.nonexistent_table\' doesn\'t exist');
    });

    it('analyze_mysql_query should throw error if not a SELECT or WITH statement', async () => {
      const response = await client.callTool({
        name: 'analyze_mysql_query',
        arguments: {
          query: 'UPDATE users SET email = "hacked@example.com"',
          databaseName: dbName,
        },
      });

      expect(response.isError).toBe(true);
      const content = (response.content as unknown[])[0] as { type: 'text', text: string };
      expect(content.text).toContain('Only SELECT or WITH queries can be analyzed using EXPLAIN.');
    });
  });
});
