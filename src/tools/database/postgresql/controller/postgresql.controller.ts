import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { runPostgresQuery, analyzePostgresQueryPlan } from '../service/postgresql.service.js';
import { saveAuditReport } from '../../utils/report.js';
import { RUNNING_PG_QUERY_PROMPT, AUDITOR_PG_PROMPT } from '../../prompts/index.js';
import {
  QueryArgumentsSchema,
  InspectTableSchema,
  AnalyzeQuerySchema,
  PostgreSQLPromptSchema,
  SaveAuditReportSchema,
  ListTablesSchema,
} from '../../dto/database.dto.js';

export function registerPostgresqlController(server: McpServer) {
  server.registerTool(
    'execute_postgres_query',
    {
      description:
        'Execute an SQL query against the PostgreSQL database. Safe parameters binding is supported.',
      inputSchema: QueryArgumentsSchema,
    },
    async ({ query, parameters, databaseName }) => {
      try {
        const rows = await runPostgresQuery(query, parameters, databaseName);
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
    'list_postgresql_tables',
    {
      description: 'Show list of tables in the PostgreSQL database.',
      inputSchema: ListTablesSchema,
    },
    async ({ databaseName }) => {
      try {
        const rows = await runPostgresQuery(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';",
          [],
          databaseName,
        );
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
    'inspect_postgresql_table',
    {
      description: 'Inspect PostgreSQL table structure (columns, types, nullability, defaults).',
      inputSchema: InspectTableSchema,
    },
    async ({ table, databaseName }) => {
      try {
        const rows = await runPostgresQuery(
          "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public';",
          [table],
          databaseName,
        );
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
    'analyze_postgresql_query',
    {
      description: 'Analyze a PostgreSQL SELECT query using EXPLAIN with Senior DB Auditor report.',
      inputSchema: AnalyzeQuerySchema,
    },
    async ({ query, databaseName }) => {
      try {
        const cleanQuery = query.trim().toLowerCase();
        if (!cleanQuery.startsWith('select') && !cleanQuery.startsWith('with')) {
          throw new Error('Only SELECT or WITH queries can be analyzed using EXPLAIN.');
        }
        const analysisResult = await analyzePostgresQueryPlan(query, databaseName);
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
    'save_audit_report_pg',
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
    'running_pg_query',
    {
      title: 'PostgreSQL Query Generator',
      description:
        'Generate and execute a read-only PostgreSQL query based on natural language. Uses tools: execute_postgres_query, list_postgresql_tables, inspect_postgresql_table, analyze_postgresql_query.',
      argsSchema: PostgreSQLPromptSchema,
    },
    async ({ command }) => {
      const cmdLower = (command || '').toLowerCase();
      let schemaContext = '';

      // 1. Fetch all PostgreSQL tables
      let tables: string[] = [];
      try {
        const rows = await runPostgresQuery<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';",
        );
        tables = rows.map((row) => row.table_name);
      } catch {
        console.error('PostgreSQL connection not configured or not active');
      }

      // 2. Match mentioned tables and inspect their schemas
      const matchedSchemas: string[] = [];
      for (const table of tables) {
        const regex = new RegExp(`\\b${table}\\b`, 'i');
        if (regex.test(cmdLower)) {
          try {
            const columns = await runPostgresQuery<unknown>(
              "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public';",
              [table],
            );
            matchedSchemas.push(
              `PostgreSQL Table: ${table}\nColumns:\n${JSON.stringify(columns, null, 2)}`,
            );
          } catch {
            console.error('Failed to inspect postgresql table');
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
            ? `Available PostgreSQL tables:\n- ${tables.join(', ')}\n\n`
            : 'No PostgreSQL tables found.\n\n';
      }

      const promptText = RUNNING_PG_QUERY_PROMPT.replace(
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
    'auditor_pg_query',
    {
      title: 'PostgreSQL Query Auditor',
      description:
        'Audit a PostgreSQL query for performance and security. Uses tools: analyze_postgresql_query, inspect_postgresql_table, list_postgresql_tables, execute_postgres_query, save_audit_report_pg.',
      argsSchema: PostgreSQLPromptSchema,
    },
    async ({ command }) => {
      const promptText = AUDITOR_PG_PROMPT.replace(
        '{{command}}',
        command || 'No query provided. Please use list_postgresql_tables to discover tables first.',
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
