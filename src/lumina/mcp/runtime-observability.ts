import { getMySQLPoolCacheStats } from '../../tools/database/mysql/repository/mysql.repository.js';
import { getPostgresPoolCacheStats } from '../../tools/database/postgresql/repository/postgresql.repository.js';

let activeRequests = 0;

export function trackRequest<T extends (...args: never[]) => unknown>(handler: T): T {
  return (async (...args: Parameters<T>) => {
    activeRequests += 1;
    try {
      return await handler(...args);
    } finally {
      activeRequests -= 1;
    }
  }) as T;
}

export function getRuntimeStats() {
  const memory = process.memoryUsage();
  return {
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    uptimeSeconds: process.uptime(),
    activeRequests,
    caches: {
      mysqlPools: getMySQLPoolCacheStats(),
      postgresPools: getPostgresPoolCacheStats(),
    },
  };
}
