import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runMySQLQuery, analyzeMySQLQueryPlan } from '../service/mysql.service.js';
import { saveAuditReport } from '../../utils/report.js';
import { RUNNING_MYSQL_QUERY_PROMPT, AUDITOR_MYSQL_PROMPT } from '../../prompts/index.js';
import {
  QueryArgumentsSchema,
  InspectTableSchema,
  AnalyzeQuerySchema,
  MySQLPromptSchema,
  SaveAuditReportSchema,
  ListTablesSchema,
} from '../../dto/database.dto.js';

export function registerMysqlController(server: McpServer) {
  server.registerTool(
    'execute_mysql_query',
    {
      description:
        'Execute an SQL query against the MySQL database. Safe parameters binding is supported.',
      inputSchema: QueryArgumentsSchema,
    },
    async ({ query, parameters, databaseName }) => {
      try {
        const rows = await runMySQLQuery(query, parameters, databaseName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(rows, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Database Error: ${errorMessage}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'list_mysql_tables',
    {
      description: 'Show list of tables in the MySQL database.',
      inputSchema: ListTablesSchema,
    },
    async ({ databaseName }) => {
      try {
        const rows = await runMySQLQuery('SHOW TABLES', [], databaseName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(rows, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Database Error: ${errorMessage}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'inspect_mysql_table',
    {
      description: 'Inspect MySQL table structure (columns, types, keys).',
      inputSchema: InspectTableSchema,
    },
    async ({ table, databaseName }) => {
      try {
        const rows = await runMySQLQuery('SHOW COLUMNS FROM ??', [table], databaseName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(rows, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Database Error: ${errorMessage}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'analyze_mysql_query',
    {
      description: 'Analyze a MySQL SELECT query using EXPLAIN with Senior DB Auditor report.',
      inputSchema: AnalyzeQuerySchema,
    },
    async ({ query, databaseName }) => {
      try {
        const cleanQuery = query.trim().toLowerCase();
        if (!cleanQuery.startsWith('select') && !cleanQuery.startsWith('with')) {
          throw new Error('Only SELECT or WITH queries can be analyzed using EXPLAIN.');
        }
        const analysisResult = await analyzeMySQLQueryPlan(query, databaseName);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(analysisResult, null, 2),
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Database Error: ${errorMessage}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'save_audit_report',
    {
      description: 'Save an AI-generated audit report to the docs/database directory.',
      inputSchema: SaveAuditReportSchema,
    },
    async ({ reportContent }) => {
      try {
        const filePath = saveAuditReport(reportContent);
        return {
          content: [
            {
              type: 'text',
              text: `Audit report successfully saved to ${filePath}`,
            },
          ],
        };
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to save report: ${errorMessage}`,
            },
          ],
        };
      }
    },
  );

  server.registerPrompt(
    'running_query',
    {
      title: 'MySQL Query Generator',
      description:
        'Generate and execute a read-only SQL query based on natural language. Uses tools: execute_mysql_query, list_mysql_tables, inspect_mysql_table, analyze_mysql_query.',
      argsSchema: MySQLPromptSchema,
    },
    async ({ command }) => {
      const cmdLower = (command || '').toLowerCase();
      let schemaContext = '';

      // 1. Fetch all tables
      let tables: string[] = [];
      try {
        const rows = await runMySQLQuery<{ [key: string]: string }>('SHOW TABLES');
        tables = rows.map((row) => Object.values(row)[0]);
      } catch {
        console.error('MySQL connection not configured or not active');
      }

      // 2. Match mentioned tables and inspect their schemas
      const matchedSchemas: string[] = [];
      for (const table of tables) {
        const regex = new RegExp(`\\b${table}\\b`, 'i');
        if (regex.test(cmdLower)) {
          try {
            const columns = await runMySQLQuery<unknown>('SHOW COLUMNS FROM ??', [table]);
            matchedSchemas.push(`Table: ${table}\nColumns:\n${JSON.stringify(columns, null, 2)}`);
          } catch {
            console.error('Failed to inspect table');
          }
        }
      }

      if (matchedSchemas.length > 0) {
        schemaContext =
          'Here are the schemas for the target tables mentioned in your command:\n\n' +
          matchedSchemas.join('\n\n') +
          '\n\n';
      } else {
        schemaContext =
          tables.length > 0
            ? `Available tables:\n- ${tables.join(', ')}\n\n`
            : 'No tables found.\n\n';
      }

      const promptText = RUNNING_MYSQL_QUERY_PROMPT.replace(
        '{{schema_context}}',
        schemaContext,
      ).replace('{{command}}', command || 'Please list all tables');

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );

  server.registerPrompt(
    'auditor_query',
    {
      title: 'Database Query Auditor',
      description:
        'Audit an SQL query for performance and security. Uses tools: analyze_mysql_query, inspect_mysql_table, list_mysql_tables, execute_mysql_query, save_audit_report.',
      argsSchema: MySQLPromptSchema,
    },
    async ({ command }) => {
      const promptText = AUDITOR_MYSQL_PROMPT.replace(
        '{{command}}',
        command || 'No query provided. Please use list_mysql_tables to discover tables first.',
      );

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: promptText,
            },
          },
        ],
      };
    },
  );
}
