import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const pools: Record<string, pg.Pool> = {};

export function getPostgresPool(databaseName?: string): pg.Pool {
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
  const dbName = databaseName || defaultDbName;

  if (pools[dbName]) {
    return pools[dbName];
  }

  let config: pg.PoolConfig = {
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };

  if (process.env.POSTGRES_URL) {
    if (databaseName) {
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

  pools[dbName] = new Pool(config);

  return pools[dbName];
}

export async function executePostgresQuery<T>(
  query: string,
  params?: unknown[],
  databaseName?: string,
): Promise<T[]> {
  const connectionPool = getPostgresPool(databaseName);
  const result = await connectionPool.query(query, params);
  return result.rows as T[];
}
