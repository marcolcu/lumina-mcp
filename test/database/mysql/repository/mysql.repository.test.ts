import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mysql from 'mysql2/promise';

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: vi.fn().mockImplementation(() => ({ end: vi.fn().mockResolvedValue(undefined) })),
  },
}));

describe('MySQL Repository', () => {
  let getMySQLPool: (databaseName?: string) => mysql.Pool;
  let getCacheStats: () => { size: number; hits: number; misses: number; evictions: number };
  let closeMySQLPools: () => Promise<void>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    delete process.env.MYSQL_URL;
    delete process.env.MYSQL_DATABASE;
    delete process.env.MYSQL_HOST;

    const repo =
      await import('../../../../src/tools/database/mysql/repository/mysql.repository.js');
    getMySQLPool = repo.getMySQLPool;
    getCacheStats = repo.getMySQLPoolCacheStats;
    closeMySQLPools = repo.closeMySQLPools;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should use MYSQL_URL and extract database name when databaseName is not provided', () => {
    process.env.MYSQL_URL = 'mysql://root:pass@localhost:3306/db_name';
    getMySQLPool();

    expect(mysql.createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: 'mysql://root:pass@localhost:3306/db_name',
      }),
    );
  });

  it('should override database from MYSQL_URL when databaseName is explicitly provided', () => {
    process.env.MYSQL_URL = 'mysql://root:pass@localhost:3306/db_name';
    getMySQLPool('override_db');

    expect(mysql.createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: 'mysql://root:pass@localhost:3306/db_name',
        database: 'override_db',
      }),
    );
  });

  it('bounds distinct database pools and reuses cached entries', () => {
    for (let i = 0; i < 10; i += 1) getMySQLPool(`database-${i}`);
    expect(getMySQLPool('database-9')).toBe(getMySQLPool('database-9'));
    expect(getCacheStats()).toMatchObject({ size: 8, misses: 10, evictions: 2, hits: 2 });
  });

  it('closes every cached pool during shutdown', async () => {
    const first = getMySQLPool('first');
    const second = getMySQLPool('second');
    await closeMySQLPools();

    expect(vi.mocked(first.end)).toHaveBeenCalledOnce();
    expect(vi.mocked(second.end)).toHaveBeenCalledOnce();
    expect(getCacheStats().size).toBe(0);
  });
});
