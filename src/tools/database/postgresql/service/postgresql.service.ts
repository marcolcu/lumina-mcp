import { executePostgresQuery } from '../repository/postgresql.repository.js';
import { filterSensitiveColumns } from '../../utils/security.js';
import { assertReadOnlyQuery } from '../../../../lumina/core/database/index.js';
import { PostgresQueryAnalysisResult } from '../../types/database.types.js';

export function validateReadOnlyPostgresQuery(query: string): void {
  assertReadOnlyQuery(query);
}

export async function runPostgresQuery<T>(
  query: string,
  params?: unknown[],
  databaseName?: string,
): Promise<T[]> {
  validateReadOnlyPostgresQuery(query);
  const rows = await executePostgresQuery<T>(query, params, databaseName);
  return filterSensitiveColumns(rows);
}

export async function analyzePostgresQueryPlan(
  sql: string,
  databaseName?: string,
): Promise<PostgresQueryAnalysisResult> {
  const explainSQL = `EXPLAIN ${sql}`;
  const rows = await executePostgresQuery<Record<string, string>>(explainSQL, [], databaseName);
  const plan = rows.map((r) => Object.values(r)[0] as string);

  let explainAnalyzePlan: string[] | null = null;
  try {
    const analyzeRows = await executePostgresQuery<Record<string, string>>(
      `EXPLAIN ANALYZE ${sql}`,
      [],
      databaseName,
    );
    explainAnalyzePlan = analyzeRows.map((r) => Object.values(r)[0] as string);
  } catch (error) {
    // Ignore if fails or not permitted
    console.error('EXPLAIN ANALYZE failed or not permitted:', error);
  }

  // Parse plan for senior auditor logic
  const planStr = plan.join('\n').toLowerCase();

  const notes: string[] = [];
  const suggestions: string[] = [];

  let performanceVerdict: 'EXCELLENT' | 'GOOD' | 'NEEDS_OPTIMIZATION' | 'CRITICAL' = 'EXCELLENT';
  let speedVerdict: 'OPTIMAL' | 'ACCEPTABLE' | 'SLOW' = 'OPTIMAL';
  let securityVerdict: 'SECURE' | 'WARNING' | 'RISKY' = 'SECURE';

  const hasSeqScan = planStr.includes('seq scan');
  const hasSort = planStr.includes('sortkey') || planStr.includes('sort method:');

  if (hasSeqScan) {
    performanceVerdict = 'NEEDS_OPTIMIZATION';
    speedVerdict = 'SLOW';
    notes.push('Query performs a Sequential Scan (Seq Scan), which indicates a full table scan.');
    suggestions.push(
      'Create an index matching your filter/join criteria to allow Postgres to perform Index Scans.',
    );
  }

  if (hasSort) {
    if (performanceVerdict === 'EXCELLENT') performanceVerdict = 'GOOD';
    notes.push('Query contains explicit sort operations.');
    suggestions.push(
      'Ensure indexes are created with appropriate sorting order (ASC/DESC) to match ORDER BY clauses.',
    );
  }

  // 2. Security audit
  if (/\bselect\s+\*/i.test(sql)) {
    securityVerdict = 'WARNING';
    notes.push(
      'SELECT * wildcard is used. This exposes unnecessary columns and decreases efficiency.',
    );
    suggestions.push('Explicitly define the specific columns required in the SELECT statement.');
  }

  if (/'[^']*'/i.test(sql) || /"[^"]*"/i.test(sql)) {
    if (securityVerdict === 'SECURE') securityVerdict = 'WARNING';
    notes.push('Query contains hardcoded string literals.');
    suggestions.push(
      'Use prepared statement placeholders ($1, $2, etc.) to parameterize user input and avoid SQL injection risks.',
    );
  }

  const seniorAudit = {
    performanceVerdict,
    speedVerdict,
    securityVerdict,
    notes,
    suggestions,
  };

  return {
    explainPlan: plan,
    explainAnalyze: explainAnalyzePlan,
    seniorAudit,
  };
}
