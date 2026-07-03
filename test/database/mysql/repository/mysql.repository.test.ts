import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import mysql from 'mysql2/promise';

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: vi.fn().mockReturnValue({}),
  },
}));

describe('MySQL Repository', () => {
  let getMySQLPool: (databaseName?: string) => mysql.Pool;
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
});
