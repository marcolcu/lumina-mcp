const ALLOWED_READ_ONLY_PREFIXES = ['select', 'show', 'describe', 'explain', 'with'] as const;

const FORBIDDEN_MODIFYING_KEYWORDS = [
  'insert',
  'update',
  'delete',
  'drop',
  'alter',
  'create',
  'truncate',
  'replace',
] as const;

const FORBIDDEN_MODIFYING_KEYWORD_PATTERN = new RegExp(
  `\\b(?:${FORBIDDEN_MODIFYING_KEYWORDS.join('|')})\\b`,
  'i',
);

function assertNoSqlInjection(normalizedQuery: string): void {
  if (
    normalizedQuery.includes('--') ||
    normalizedQuery.includes('/*') ||
    normalizedQuery.includes('#')
  ) {
    throw new Error('Potential SQL Injection detected: Comments are not allowed in queries.');
  }

  const tautologyPattern = /\bor\b\s+(['"]?)[a-zA-Z0-9_-]+\1\s*=\s*\1[a-zA-Z0-9_-]+\1/i;
  const booleanTautologyPattern = /\bor\b\s+true\b/i;
  if (tautologyPattern.test(normalizedQuery) || booleanTautologyPattern.test(normalizedQuery)) {
    throw new Error('Potential SQL Injection detected: Tautologies are not allowed.');
  }

  if (/\bunion\b\s+(all\s+)?\bselect\b/i.test(normalizedQuery)) {
    throw new Error('Potential SQL Injection detected: UNION SELECT queries are not allowed.');
  }
}

/**
 * Rejects common SQL-injection shapes that Lumina does not need for read-only queries.
 */
export function detectSqlInjection(query: string): void {
  assertNoSqlInjection(query.toLowerCase());
}

/**
 * Enforces Lumina's database-independent read-only SQL policy.
 */
export function assertReadOnlyQuery(query: string): void {
  const normalizedQuery = query.trim().toLowerCase();
  assertNoSqlInjection(normalizedQuery);
  const hasAllowedPrefix = ALLOWED_READ_ONLY_PREFIXES.some((prefix) =>
    normalizedQuery.startsWith(prefix),
  );

  if (!hasAllowedPrefix) {
    throw new Error('Only SELECT or read-only queries are allowed.');
  }

  if (FORBIDDEN_MODIFYING_KEYWORD_PATTERN.test(normalizedQuery)) {
    throw new Error(
      'Queries containing INSERT, UPDATE, DELETE, or other modifying operations are not allowed.',
    );
  }
}
