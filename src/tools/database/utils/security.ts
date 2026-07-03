import fs from 'fs';
import path from 'path';

let restrictedColumnsCache: string[] | null = null;

export function getRestrictedColumns(): string[] {
  if (restrictedColumnsCache !== null) {
    return restrictedColumnsCache;
  }

  const defaultRestricted = [
    'password',
    'credential',
    'credentials',
    'token',
    'secret',
    'secret_key',
    'passphrase',
  ];
  const configPath =
    process.env.LUMINA_RESTRICTED_COLUMNS_PATH ||
    path.join(process.cwd(), '.lumina/database/restricColumn.json');

  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(content);
      if (config && Array.isArray(config.COLUMNS)) {
        // Normalize to lowercase
        const customRestricted = config.COLUMNS.map((col: unknown) => String(col).toLowerCase());
        // Merge custom and default, ensuring uniqueness
        restrictedColumnsCache = Array.from(new Set([...defaultRestricted, ...customRestricted]));
        return restrictedColumnsCache;
      }
    }
  } catch (error) {
    console.error('Error reading restricted columns config:', error);
  }

  restrictedColumnsCache = defaultRestricted;
  return restrictedColumnsCache;
}

export function clearRestrictedColumnsCache(): void {
  restrictedColumnsCache = null;
}

export function filterSensitiveColumns<T>(rows: T[]): T[] {
  if (!Array.isArray(rows)) {
    return rows;
  }

  const restricted = getRestrictedColumns();

  return rows.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) {
      const newRow = { ...row } as Record<string, unknown>;
      let modified = false;

      for (const key of Object.keys(newRow)) {
        if (restricted.includes(key.toLowerCase())) {
          delete newRow[key];
          modified = true;
        }
      }

      return modified ? (newRow as T) : row;
    }
    return row;
  });
}

export function detectSqlInjection(query: string): void {
  const cleanQuery = query.toLowerCase();

  // 1. Check for SQL comments (commonly used in SQLi to bypass rest of query)
  if (cleanQuery.includes('--') || cleanQuery.includes('/*') || cleanQuery.includes('#')) {
    throw new Error('Potential SQL Injection detected: Comments are not allowed in queries.');
  }

  // 2. Check for tautologies (e.g. OR 1=1, OR 'a'='a', OR true)
  const tautologyRegex = /\bor\b\s+(['"]?)[a-zA-Z0-9_-]+\1\s*=\s*\1[a-zA-Z0-9_-]+\1/i;
  const booleanTautologyRegex = /\bor\b\s+true\b/i;
  if (tautologyRegex.test(cleanQuery) || booleanTautologyRegex.test(cleanQuery)) {
    throw new Error('Potential SQL Injection detected: Tautologies are not allowed.');
  }

  // 3. Check for UNION SELECT injections
  if (/\bunion\b\s+(all\s+)?\bselect\b/i.test(cleanQuery)) {
    throw new Error('Potential SQL Injection detected: UNION SELECT queries are not allowed.');
  }
}
