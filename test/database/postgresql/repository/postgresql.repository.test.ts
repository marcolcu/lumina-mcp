import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pg from 'pg';

vi.mock('pg', () => {
  const mockPool = vi.fn().mockReturnValue({});
  return {
    default: {
      Pool: mockPool,
    },
  };
});

describe('PostgreSQL Repository', () => {
  let getPostgresPool: (databaseName?: string) => pg.Pool;
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
});
