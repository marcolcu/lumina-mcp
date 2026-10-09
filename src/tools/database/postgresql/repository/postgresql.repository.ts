import pg from 'pg';
import dotenv from 'dotenv';
import { LruTtlCache } from '../../../../utils/lru-ttl-cache.js';

dotenv.config();

const { Pool } = pg;
const MAX_CACHED_DATABASE_POOLS = 8;
const POOL_CACHE_TTL_MS = 60_000;
function closeEvictedPool(pool: pg.Pool): void {
  void Promise.resolve().then(() => pool.end()).catch((error: unknown) => console.error('Failed to close evicted PostgreSQL pool:', error));
}
const pools = new LruTtlCache<string, pg.Pool>(MAX_CACHED_DATABASE_POOLS, POOL_CACHE_TTL_MS, closeEvictedPool);

export function getPostgresPoolCacheStats() {
  return pools.stats();
}

export async function closePostgresPools(): Promise<void> {
  const openPools = pools.clear();
  const results = await Promise.allSettled(openPools.map((pool) => Promise.resolve().then(() => pool.end())));
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (errors.length > 0) throw new AggregateError(errors.map((result) => result.reason), 'Failed to close PostgreSQL pools.');
}

function resolveDatabaseName(databaseName?: string): string {
  let defaultDbName = process.env.PG_DATABASE || 'lumina_db';
  if (process.env.POSTGRES_URL) {
    try {
      const url = new URL(process.env.POSTGRES_URL);
      if (url.pathname && url.pathname !== '/') {
        defaultDbName = url.pathname.substring(1);
      }
    } catch (error) {
      // Ignore URL parsing errors
      console.error('Failed to parse POSTGRES_URL:', error);
    }
  }
  return databaseName || defaultDbName;
}

function createPool(dbName: string, hasOverride: boolean): pg.Pool {
  let config: pg.PoolConfig = {
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };

  if (process.env.POSTGRES_URL) {
    if (hasOverride) {
      // Parse URL and override database
      const url = new URL(process.env.POSTGRES_URL);
      url.pathname = `/${dbName}`;
      config.connectionString = url.toString();
    } else {
      config.connectionString = process.env.POSTGRES_URL;
    }
  } else {
    config = {
      ...config,
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432', 10),
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD || 'password',
      database: dbName,
    };
  }

  return new Pool(config);
}

export function getPostgresPool(databaseName?: string): pg.Pool {
  const dbName = resolveDatabaseName(databaseName);
  return pools.getOrCreate(dbName, () => createPool(dbName, databaseName !== undefined));
}

export function acquirePostgresPool(databaseName?: string): { pool: pg.Pool; release(): void } {
  const dbName = resolveDatabaseName(databaseName);
  const lease = pools.acquire(dbName, () => createPool(dbName, databaseName !== undefined));
  return { pool: lease.value, release: lease.release };
}

export async function executePostgresQuery<T>(
  query: string,
  params?: unknown[],
  databaseName?: string,
): Promise<T[]> {
  const { pool, release } = acquirePostgresPool(databaseName);
  try {
    const result = await pool.query(query, params);
    return result.rows as T[];
  } finally {
    release();
  }
}
