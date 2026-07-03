import { z } from 'zod';

export const QueryArgumentsSchema = z.object({
  query: z
    .string()
    .describe('The SQL query to run. Use placeholder parameters to prevent SQL injection.'),
  parameters: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe('Parameters to bind to the query placeholders.'),
  databaseName: z.string().optional().describe('Optional name of the database to use.'),
});

export const ListTablesSchema = z.object({
  databaseName: z
    .string()
    .optional()
    .describe('Optional name of the database to list tables from.'),
});

export const InspectTableSchema = z.object({
  table: z.string().describe('The name of the table to inspect.'),
  databaseName: z.string().optional().describe('Optional name of the database to use.'),
});

export const AnalyzeQuerySchema = z.object({
  query: z.string().describe('The SQL SELECT query to analyze using EXPLAIN.'),
  databaseName: z.string().optional().describe('Optional name of the database to use.'),
});

export const SaveAuditReportSchema = z.object({
  reportContent: z.string().describe('The full markdown content of the AI-generated audit report.'),
});

export const MySQLPromptSchema = {
  command: z
    .string()
    .optional()
    .describe(
      "Natural language command to generate a MySQL query. Example: 'show all users created last week from users table'",
    ),
};

export const PostgreSQLPromptSchema = {
  command: z
    .string()
    .optional()
    .describe(
      "Natural language command to generate a PostgreSQL query. Example: 'count orders grouped by status from orders table'",
    ),
};
