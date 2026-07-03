import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pools: Record<string, mysql.Pool> = {};

export function getMySQLPool(databaseName?: string): mysql.Pool {
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
  const dbName = databaseName || defaultDbName;

  if (pools[dbName]) {
    return pools[dbName];
  }

  // Parse MYSQL_URL if available, otherwise use discrete env vars
  let config: mysql.PoolOptions = {
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
  };

  if (process.env.MYSQL_URL) {
    config = { ...config, uri: process.env.MYSQL_URL };
    // Override database from URI if databaseName is explicitly provided
    if (databaseName) {
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

  pools[dbName] = mysql.createPool(config);

  return pools[dbName];
}

export async function executeMySQLQuery<T>(
  query: string,
  params?: unknown[],
  databaseName?: string,
): Promise<T[]> {
  const connectionPool = getMySQLPool(databaseName);
  const typedParams = params as (string | number | boolean | null | Date | Buffer)[] | undefined;
  const [rows] = await connectionPool.execute(query, typedParams);
  return rows as T[];
}
