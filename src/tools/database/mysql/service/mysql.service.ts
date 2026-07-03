import { executeMySQLQuery, getMySQLPool } from '../repository/mysql.repository.js';
import { filterSensitiveColumns, detectSqlInjection } from '../../utils/security.js';
import {
  ExplainRow,
  TableAnalysis,
  SeniorAuditorReport,
  QueryAnalysisResult,
} from '../../types/database.types.js';

export function validateReadOnlyMySQLQuery(query: string): void {
  detectSqlInjection(query);
  const cleanQuery = query.trim().toLowerCase();

  // Must be SELECT or other read-only statement.
  const allowedPrefixes = ['select', 'show', 'describe', 'explain', 'with'];
  const hasAllowedPrefix = allowedPrefixes.some((prefix) => cleanQuery.startsWith(prefix));
  if (!hasAllowedPrefix) {
    throw new Error('Only SELECT or read-only queries are allowed.');
  }

  // Explicitly forbid modifying operations anywhere in the query to prevent multi-statements/injection
  const forbiddenKeywords = [
    'insert',
    'update',
    'delete',
    'drop',
    'alter',
    'create',
    'truncate',
    'replace',
  ];
  const hasForbiddenKeyword = forbiddenKeywords.some((keyword) => {
    const regex = new RegExp(`\\b${keyword}\\b`, 'i');
    return regex.test(cleanQuery);
  });
  if (hasForbiddenKeyword) {
    throw new Error(
      'Queries containing INSERT, UPDATE, DELETE, or other modifying operations are not allowed.',
    );
  }
}

export async function runMySQLQuery<T>(
  query: string,
  params?: unknown[],
  databaseName?: string,
): Promise<T[]> {
  validateReadOnlyMySQLQuery(query);
  const rows = await executeMySQLQuery<T>(query, params, databaseName);
  return filterSensitiveColumns(rows);
}

export async function analyzeMySQLQueryPlan(
  sql: string,
  databaseName?: string,
): Promise<QueryAnalysisResult> {
  const pool = getMySQLPool(databaseName);
  const connection = await pool.getConnection();

  try {
    const explainSQL = `EXPLAIN ${sql}`;
    const [rows] = await connection.execute(explainSQL);
    const [warnings] = await connection.query('SHOW WARNINGS');

    // Try EXPLAIN ANALYZE for actual execution statistics (MySQL 8.0.18+)
    let explainAnalyzeResult: string | null = null;
    try {
      const [analyzeRows] = (await connection.execute(
        `EXPLAIN ANALYZE ${sql}`,
      )) as unknown as Record<string, unknown>[];
      const firstAnalyzeRow = analyzeRows[0];
      if (firstAnalyzeRow) {
        explainAnalyzeResult = Object.values(firstAnalyzeRow)[0] as string;
      }
    } catch (error) {
      // Ignore EXPLAIN ANALYZE if not supported or fails
      console.error('EXPLAIN ANALYZE failed or not supported:', error);
    }

    const analysis: TableAnalysis[] = [];
    const explainRows = rows as ExplainRow[];

    let hasFullTableScan = false;
    let hasNoIndex = false;
    let hasFilesort = false;
    let hasTempTable = false;
    let totalRowsExamined = 0;

    for (const row of explainRows) {
      const result: TableAnalysis = {
        table: row.table,
        accessType: row.type,
        possibleKeys: row.possible_keys,
        usedKey: row.key,
        keyLen: row.key_len,
        ref: row.ref,
        rowsExamined: row.rows || 0,
        rowsFiltered: row.filtered || 0,
        extra: row.Extra,
        problems: [],
        recommendation: null,
      };

      totalRowsExamined += row.rows || 0;

      if (row.type === 'ALL') {
        result.problems.push('Full table scan detected (type=ALL)');
        hasFullTableScan = true;
      }

      if (row.type === 'index') {
        result.problems.push('Full index scan detected (type=index)');
        hasFullTableScan = true;
      }

      if (!row.key && row.type !== 'const' && row.type !== 'system') {
        result.problems.push('No index used');
        hasNoIndex = true;
      }

      if (row.Extra && row.Extra.includes('Using filesort')) {
        result.problems.push('Using filesort (expensive sorting operation)');
        hasFilesort = true;
      }

      if (row.Extra && row.Extra.includes('Using temporary')) {
        result.problems.push('Using temporary table (expensive)');
        hasTempTable = true;
      }

      if (!row.possible_keys && row.type !== 'const' && row.type !== 'system') {
        result.recommendation = 'Consider adding index based on WHERE / JOIN columns';
      }

      analysis.push(result);
    }

    // Senior Database Auditor logic
    const notes: string[] = [];
    const suggestions: string[] = [];

    // Verdict assessments
    let performanceVerdict: 'EXCELLENT' | 'GOOD' | 'NEEDS_OPTIMIZATION' | 'CRITICAL' = 'EXCELLENT';
    let speedVerdict: 'OPTIMAL' | 'ACCEPTABLE' | 'SLOW' = 'OPTIMAL';
    let securityVerdict: 'SECURE' | 'WARNING' | 'RISKY' = 'SECURE';

    // 1. Performance and Speed audit
    if (hasFullTableScan || hasNoIndex) {
      performanceVerdict = 'NEEDS_OPTIMIZATION';
      speedVerdict = 'SLOW';
      notes.push(
        'Query performs a full table scan or does not use indexes, which degrades database speed as tables grow.',
      );
      suggestions.push(
        'Add composite or single indexes matching your WHERE or JOIN clauses to avoid ALL/index scans.',
      );
    }

    if (hasFilesort || hasTempTable) {
      if (performanceVerdict === 'EXCELLENT') performanceVerdict = 'GOOD';
      notes.push(
        'Query performs in-memory/on-disk temporary table creation or filesort operations.',
      );
      suggestions.push(
        'Optimise ORDER BY / GROUP BY clauses or adjust index sorting to match query ordering.',
      );
    }

    if (totalRowsExamined > 10000) {
      performanceVerdict = 'CRITICAL';
      speedVerdict = 'SLOW';
      notes.push(`Large number of rows examined (${totalRowsExamined} rows).`);
      suggestions.push(
        'Use LIMIT to constrain result sets, or partition/archive tables if data volume is high.',
      );
    }

    if (performanceVerdict === 'EXCELLENT' && totalRowsExamined < 100) {
      notes.push('Query is well-optimized and utilizes indexes perfectly.');
    }

    // 2. Security audit
    // Check if query is using SELECT *
    if (/\bselect\s+\*/i.test(sql)) {
      securityVerdict = 'WARNING';
      notes.push(
        'SELECT * wildcard is used. This exposes unnecessary data columns and reduces bandwidth efficiency.',
      );
      suggestions.push('Explicitly define the specific columns required in the SELECT statement.');
    }

    // Check for potential SQL injection signs in static queries (e.g. unparameterized strings)
    if (/'[^']*'/i.test(sql) || /"[^"]*"/i.test(sql)) {
      if (securityVerdict === 'SECURE') securityVerdict = 'WARNING';
      notes.push('Query contains hardcoded string literals.');
      suggestions.push(
        'Use prepared statement placeholders (?) to parameterize user input and avoid SQL injection risks.',
      );
    }

    const seniorAudit: SeniorAuditorReport = {
      performanceVerdict,
      speedVerdict,
      securityVerdict,
      notes,
      suggestions,
    };

    return {
      explainRows,
      warnings: warnings as unknown[],
      explainAnalyze: explainAnalyzeResult,
      tableAnalysis: analysis,
      seniorAudit,
    };
  } finally {
    connection.release();
  }
}
