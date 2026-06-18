export class TtlCache<K, V> {
  private readonly values = new Map<K, { value: V; expiresAt: number }>();

  constructor(private readonly ttlMs: number) {}

  get(key: K): V | null {
    const cached = this.values.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      this.values.delete(key);
      return null;
    }
    return cached.value;
  }

  set(key: K, value: V, ttlMs = this.ttlMs): void {
    this.values.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key: K): void {
    this.values.delete(key);
  }

  clearExpired(now = Date.now()): void {
    for (const [key, cached] of this.values.entries()) {
      if (cached.expiresAt < now) this.values.delete(key);
    }
  }
}
