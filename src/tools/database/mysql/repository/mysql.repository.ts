import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { LruTtlCache } from '../../../../utils/lru-ttl-cache.js';

dotenv.config();

const MAX_CACHED_DATABASE_POOLS = 8;
const POOL_CACHE_TTL_MS = 60_000;
function closeEvictedPool(pool: mysql.Pool): void {
  void Promise.resolve().then(() => pool.end()).catch((error: unknown) => console.error('Failed to close evicted MySQL pool:', error));
}
const pools = new LruTtlCache<string, mysql.Pool>(MAX_CACHED_DATABASE_POOLS, POOL_CACHE_TTL_MS, closeEvictedPool);

export function getMySQLPoolCacheStats() {
  return pools.stats();
}

export async function closeMySQLPools(): Promise<void> {
  const openPools = pools.clear();
  const results = await Promise.allSettled(openPools.map((pool) => Promise.resolve().then(() => pool.end())));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length > 0) throw new AggregateError(errors.map((result) => result.reason), 'Failed to close MySQL pools.');
}

function resolveDatabaseName(databaseName?: string): string {
  let defaultDbName = process.env.MYSQL_DATABASE || 'db_name';
  if (process.env.MYSQL_URL) {
    try {
      const url = new URL(process.env.MYSQL_URL);
      if (url.pathname && url.pathname !== '/') {
        defaultDbName = url.pathname.substring(1);
      }
    } catch (e) {
      // Ignore URL parsing errors
      console.error('ERROR while parse MYSQL_URL', e);
    }
  }
  return databaseName || defaultDbName;
}

function createPool(dbName: string, hasOverride: boolean): mysql.Pool {
  // Parse MYSQL_URL if available, otherwise use discrete env vars
  let config: mysql.PoolOptions = {
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  };

  if (process.env.MYSQL_URL) {
    config = { ...config, uri: process.env.MYSQL_URL };
    // Override database from URI if databaseName is explicitly provided
    if (hasOverride) {
      config.database = dbName;
    }
  } else {
    config = {
      ...config,
      host: process.env.MYSQL_HOST || 'localhost',
      port: parseInt(process.env.MYSQL_PORT || '3306', 10),
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || 'password',
      database: dbName,
    };
  }

  return mysql.createPool(config);
}

export function getMySQLPool(databaseName?: string): mysql.Pool {
  const dbName = resolveDatabaseName(databaseName);
  return pools.getOrCreate(dbName, () => createPool(dbName, databaseName !== undefined));
}

export function acquireMySQLPool(databaseName?: string): { pool: mysql.Pool; release(): void } {
  const dbName = resolveDatabaseName(databaseName);
  const lease = pools.acquire(dbName, () => createPool(dbName, databaseName !== undefined));
  return { pool: lease.value, release: lease.release };
}

export async function executeMySQLQuery<T>(
  query: string,
  params?: unknown[],
  databaseName?: string,
): Promise<T[]> {
  const { pool, release } = acquireMySQLPool(databaseName);
  try {
    const typedParams = params as (string | number | boolean | null | Date | Buffer)[] | undefined;
    const [rows] = await pool.execute(query, typedParams);
    return rows as T[];
  } finally {
    release();
  }
}
