import fs from 'fs';
import path from 'path';
import {
  filterSensitiveColumns as filterSensitiveColumnsCore,
  mergeRestrictedColumns,
} from '../../../lumina/core/database/index.js';

export { detectSqlInjection } from '../../../lumina/core/database/index.js';

let restrictedColumnsCache: string[] | null = null;

export function getRestrictedColumns(): string[] {
  if (restrictedColumnsCache !== null) {
    return restrictedColumnsCache;
  }

  const configPath =
    process.env.LUMINA_RESTRICTED_COLUMNS_PATH ||
    path.join(process.cwd(), '.lumina/database/restricColumn.json');

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);
    if (config && Array.isArray(config.COLUMNS)) {
      restrictedColumnsCache = mergeRestrictedColumns(config.COLUMNS);
      return restrictedColumnsCache;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Error reading restricted columns config:', error);
    }
  }

  restrictedColumnsCache = mergeRestrictedColumns();
  return restrictedColumnsCache;
}

export function clearRestrictedColumnsCache(): void {
  restrictedColumnsCache = null;
}

export function filterSensitiveColumns<T>(rows: T[]): T[] {
  return filterSensitiveColumnsCore(rows, getRestrictedColumns());
}
