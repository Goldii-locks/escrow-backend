type CacheEntry<T> = {
  data: T;
  expiry: number;
};

class CacheService {
  private cache = new Map<string, CacheEntry<any>>();
  private defaultTTL = 60000;

  get<T>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set<T>(key: string, data: T, ttlMs: number = this.defaultTTL): void {
    this.cache.set(key, {
      data,
      expiry: Date.now() + ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

export const cacheService = new CacheService();
