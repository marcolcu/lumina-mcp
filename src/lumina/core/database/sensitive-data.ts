export const DEFAULT_RESTRICTED_COLUMNS = [
  'password',
  'credential',
  'credentials',
  'token',
  'secret',
  'secret_key',
  'passphrase',
] as const;

/**
 * Produces the normalized policy consumed by result filtering.
 */
export function mergeRestrictedColumns(customColumns: readonly unknown[] = []): string[] {
  const normalizedCustomColumns = customColumns.map((column) => String(column).toLowerCase());

  return Array.from(new Set([...DEFAULT_RESTRICTED_COLUMNS, ...normalizedCustomColumns]));
}

/**
 * Removes restricted top-level fields without mutating the source rows.
 */
export function filterSensitiveColumns<T>(
  rows: T[],
  restrictedColumns: readonly string[] = DEFAULT_RESTRICTED_COLUMNS,
): T[] {
  if (!Array.isArray(rows)) {
    return rows;
  }

  const restricted = new Set(restrictedColumns.map((column) => column.toLowerCase()));

  return rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      return row;
    }

    const restrictedKeys = Object.keys(row).filter((key) => restricted.has(key.toLowerCase()));
    if (restrictedKeys.length === 0) {
      return row;
    }

    const filteredRow = { ...row } as Record<string, unknown>;
    for (const key of restrictedKeys) {
      delete filteredRow[key];
    }

    return filteredRow as T;
  });
}
