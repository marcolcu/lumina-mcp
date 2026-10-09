import { closeMySQLPools } from '../../tools/database/mysql/repository/mysql.repository.js';
import { closePostgresPools } from '../../tools/database/postgresql/repository/postgresql.repository.js';

export async function closeDatabasePools(): Promise<void> {
  const results = await Promise.allSettled([closeMySQLPools(), closePostgresPools()]);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length > 0) {
    throw new AggregateError(errors.map((result) => result.reason), 'Failed to close database pools.');
  }
}
