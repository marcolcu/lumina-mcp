import { afterEach, describe, expect, it, vi } from 'vitest';
import { LruTtlCache } from '../../src/utils/lru-ttl-cache.js';

afterEach(() => vi.useRealTimers());

describe('LruTtlCache', () => {
  it('deduplicates keys, refreshes LRU order, and evicts the least recently used value', () => {
    const evicted: string[] = [];
    const cache = new LruTtlCache<string, string>(2, 1000, (value) => evicted.push(value));
    expect(cache.getOrCreate('a', () => 'A')).toBe('A');
    expect(cache.getOrCreate('b', () => 'B')).toBe('B');
    expect(cache.getOrCreate('a', () => 'duplicate')).toBe('A');
    cache.getOrCreate('c', () => 'C');

    expect(evicted).toEqual(['B']);
    expect(cache.stats()).toMatchObject({ size: 2, hits: 1, misses: 3, evictions: 1 });
  });

  it('expires entries by TTL without creating a timer', () => {
    vi.useFakeTimers();
    const evicted: string[] = [];
    const cache = new LruTtlCache<string, string>(2, 1000, (value) => evicted.push(value));
    cache.getOrCreate('a', () => 'A');
    vi.advanceTimersByTime(1001);

    expect(cache.getOrCreate('a', () => 'new A')).toBe('new A');
    expect(evicted).toEqual(['A']);
    expect(cache.stats().size).toBe(1);
  });

  it('defers disposal of an evicted value until its active request releases it', () => {
    const evicted: string[] = [];
    const cache = new LruTtlCache<string, string>(1, 1000, (value) => evicted.push(value));
    const active = cache.acquire('a', () => 'A');
    cache.getOrCreate('b', () => 'B');
    expect(evicted).toEqual([]);

    active.release();
    expect(evicted).toEqual(['A']);
  });
});
