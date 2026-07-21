interface CacheEntry<T> {
  value: T
  expiresAt: number
}

/**
 * Small in-memory LRU/TTL cache suitable for a warm Lambda instance.
 * It also coalesces concurrent loads for the same key into one Promise.
 */
export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>()
  private readonly inFlightLoads = new Map<string, Promise<unknown>>()

  public constructor(
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('maxEntries must be a positive integer')
    }
  }

  public get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)

    if (entry === undefined) {
      return undefined
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return undefined
    }

    // Refresh insertion order, which makes the Map behave like a small LRU.
    this.entries.delete(key)
    this.entries.set(key, entry)

    return entry.value as T
  }

  public set<T>(key: string, value: T, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error('ttlMs must be greater than zero')
    }

    this.entries.delete(key)
    this.entries.set(key, {
      value,
      expiresAt: this.now() + ttlMs,
    })

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as string | undefined

      if (oldestKey === undefined) {
        return
      }

      this.entries.delete(oldestKey)
    }
  }

  public async getOrLoad<T>(
    key: string,
    ttlMs: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const cachedValue = this.get<T>(key)

    if (cachedValue !== undefined) {
      return cachedValue
    }

    const existingLoad = this.inFlightLoads.get(key)

    if (existingLoad !== undefined) {
      return existingLoad as Promise<T>
    }

    const load = loader()
      .then((value) => {
        this.set(key, value, ttlMs)
        return value
      })
      .finally(() => {
        this.inFlightLoads.delete(key)
      })

    this.inFlightLoads.set(key, load)
    return load
  }

  public clear(): void {
    this.entries.clear()
    this.inFlightLoads.clear()
  }
}
