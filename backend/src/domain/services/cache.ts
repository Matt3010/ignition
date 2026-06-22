export class TtlCache<K, V> {
  private readonly values = new Map<K, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 10_000,
  ) {}

  get(key: K): V | null {
    const cached = this.values.get(key);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return cached.value;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    this.clearExpired();
    if (!this.values.has(key) && this.values.size >= this.maxEntries) {
      const oldestKey = this.values.keys().next().value as K | undefined;
      if (oldestKey !== undefined) this.values.delete(oldestKey);
    }
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: K): void {
    this.values.delete(key);
  }

  clearExpired(now = Date.now()): void {
    for (const [key, cached] of this.values.entries()) {
      if (cached.expiresAt <= now) this.values.delete(key);
    }
  }

  get size(): number {
    this.clearExpired();
    return this.values.size;
  }
}
