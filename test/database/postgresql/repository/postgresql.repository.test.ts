import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pg from 'pg';

vi.mock('pg', () => {
  const mockPool = vi.fn().mockImplementation(() => ({ end: vi.fn().mockResolvedValue(undefined) }));
  return {
    default: {
      Pool: mockPool,
    },
  };
});

describe('PostgreSQL Repository', () => {
  let getPostgresPool: (databaseName?: string) => pg.Pool;
  let getCacheStats: () => { size: number; hits: number; misses: number; evictions: number };
  let closePostgresPools: () => Promise<void>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    originalEnv = { ...process.env };
    delete process.env.POSTGRES_URL;
    delete process.env.PG_DATABASE;

    const repo =
      await import('../../../../src/tools/database/postgresql/repository/postgresql.repository.js');
    getPostgresPool = repo.getPostgresPool;
    getCacheStats = repo.getPostgresPoolCacheStats;
    closePostgresPools = repo.closePostgresPools;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should extract database name from POSTGRES_URL when databaseName is not provided', () => {
    process.env.POSTGRES_URL = 'postgres://postgres:pass@localhost:5432/db_name';
    getPostgresPool();

    expect(pg.Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://postgres:pass@localhost:5432/db_name',
      }),
    );
  });

  it('should override database from POSTGRES_URL when databaseName is explicitly provided', () => {
    process.env.POSTGRES_URL = 'postgres://postgres:pass@localhost:5432/db_name';
    getPostgresPool('override_db');

    expect(pg.Pool).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: 'postgres://postgres:pass@localhost:5432/override_db',
      }),
    );
  });

  it('bounds distinct database pools and reuses cached entries', () => {
    for (let i = 0; i < 10; i += 1) getPostgresPool(`database-${i}`);
    expect(getPostgresPool('database-9')).toBe(getPostgresPool('database-9'));
    expect(getCacheStats()).toMatchObject({ size: 8, misses: 10, evictions: 2, hits: 2 });
  });

  it('closes every cached pool during shutdown', async () => {
    const first = getPostgresPool('first');
    const second = getPostgresPool('second');
    await closePostgresPools();

    expect(vi.mocked(first.end)).toHaveBeenCalledOnce();
    expect(vi.mocked(second.end)).toHaveBeenCalledOnce();
    expect(getCacheStats().size).toBe(0);
  });
});
