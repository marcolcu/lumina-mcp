export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface Entry<Value> {
  value: Value;
  expiresAt: number;
  active: number;
  evicted: boolean;
}

/** A small synchronous LRU cache. Expiration is checked on access, so it owns no timer. */
export class LruTtlCache<Key, Value> {
  private readonly entries = new Map<Key, Entry<Value>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly ttlMs: number,
    private readonly onEvict: (value: Value) => void,
  ) {}

  getOrCreate(key: Key, create: () => Value): Value {
    return this.getEntry(key, create).value;
  }

  acquire(key: Key, create: () => Value): { value: Value; release(): void } {
    const entry = this.getEntry(key, create);
    entry.active += 1;
    let released = false;
    return {
      value: entry.value,
      release: () => {
        if (released) return;
        released = true;
        entry.active -= 1;
        if (entry.evicted && entry.active === 0) this.dispose(entry);
      },
    };
  }

  values(): Value[] {
    return [...this.entries.values()].map((entry) => entry.value);
  }

  clear(): Value[] {
    const values = this.values();
    this.entries.clear();
    return values;
  }

  stats(): CacheStats {
    this.expire();
    return { size: this.entries.size, hits: this.hits, misses: this.misses, evictions: this.evictions };
  }

  private expire(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.evict(key, entry);
    }
  }

  private evictOldest(): void {
    const first = this.entries.entries().next().value as [Key, Entry<Value>] | undefined;
    if (first) this.evict(first[0], first[1]);
  }

  private evict(key: Key, entry: Entry<Value>): void {
    this.entries.delete(key);
    this.evictions += 1;
    entry.evicted = true;
    if (entry.active === 0) this.dispose(entry);
  }

  private getEntry(key: Key, create: () => Value): Entry<Value> {
    this.expire();
    const existing = this.entries.get(key);
    if (existing) {
      this.hits += 1;
      this.entries.delete(key);
      existing.expiresAt = Date.now() + this.ttlMs;
      this.entries.set(key, existing);
      return existing;
    }

    this.misses += 1;
    const entry: Entry<Value> = {
      value: create(),
      expiresAt: Date.now() + this.ttlMs,
      active: 0,
      evicted: false,
    };
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) this.evictOldest();
    return entry;
  }

  private dispose(entry: Entry<Value>): void {
    if (!entry.evicted) return;
    entry.evicted = false;
    this.onEvict(entry.value);
  }
}
