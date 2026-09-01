import { describe, expect, it } from 'vitest';
import {
  assertReadOnlyQuery,
  detectSqlInjection,
  filterSensitiveColumns,
  mergeRestrictedColumns,
} from '../../../src/lumina/core/index.js';

describe('database core', () => {
  describe('assertReadOnlyQuery', () => {
    it.each([
      'SELECT * FROM users',
      '  select id FROM users; ',
      'WITH active_users AS (SELECT * FROM users) SELECT * FROM active_users',
      'SHOW TABLES',
      'DESCRIBE users',
      'EXPLAIN SELECT * FROM users',
    ])('accepts a read-only statement: %s', (query) => {
      expect(() => assertReadOnlyQuery(query)).not.toThrow();
    });

    it.each([
      'INSERT INTO users VALUES (1)',
      'SELECT * FROM users; UPDATE users SET active = false',
      'WITH removed AS (DELETE FROM users RETURNING *) SELECT * FROM removed',
      'DROP TABLE users',
    ])('rejects a modifying statement: %s', (query) => {
      expect(() => assertReadOnlyQuery(query)).toThrow(/read-only|modifying/i);
    });

    it('rejects empty input', () => {
      expect(() => assertReadOnlyQuery('   ')).toThrow(/read-only/i);
    });
  });

  describe('detectSqlInjection', () => {
    it.each([
      'SELECT * FROM users -- bypass',
      'SELECT * FROM users /* bypass */',
      'SELECT * FROM users # bypass',
      'SELECT * FROM users WHERE id = 1 OR 1=1',
      "SELECT * FROM users WHERE name = 'admin' OR 'a'='a'",
      'SELECT * FROM users WHERE active = true OR true',
      'SELECT * FROM users UNION SELECT * FROM credentials',
    ])('rejects a suspicious query: %s', (query) => {
      expect(() => detectSqlInjection(query)).toThrow(/SQL Injection/i);
    });
  });

  describe('sensitive data filtering', () => {
    it('merges custom restricted columns case-insensitively without duplicates', () => {
      expect(mergeRestrictedColumns(['Email', 'TOKEN', 'email'])).toEqual([
        'password',
        'credential',
        'credentials',
        'token',
        'secret',
        'secret_key',
        'passphrase',
        'email',
      ]);
    });

    it('preserves legacy whitespace and empty custom column semantics', () => {
      const restricted = mergeRestrictedColumns([' Email ', '']);
      expect(restricted).toContain(' email ');
      expect(restricted).toContain('');
    });

    it('returns copies only for records that contain restricted fields', () => {
      const untouched = { id: 1, name: 'Ada' };
      const sensitive = { id: 2, name: 'Lin', Password: 'hidden' };

      const result = filterSensitiveColumns([untouched, sensitive], ['password']);

      expect(result).toEqual([untouched, { id: 2, name: 'Lin' }]);
      expect(result[0]).toBe(untouched);
      expect(result[1]).not.toBe(sensitive);
      expect(sensitive).toHaveProperty('Password', 'hidden');
    });

    it('preserves primitive and array rows', () => {
      const rows = [null, 'value', ['token']] as unknown[];
      expect(filterSensitiveColumns(rows, ['token'])).toEqual(rows);
    });
  });
});
