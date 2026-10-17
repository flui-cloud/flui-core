/**
 * Shares one in-flight or recent answer per key: concurrent callers wait on
 * the same promise, a rejection is forgotten at once, and the map never holds
 * more than `maxEntries` keys (expired first, then oldest).
 */
export class PromiseCache<T> {
  private readonly entries = new Map<
    string,
    { expiresAt: number; value: Promise<T> }
  >();

  constructor(
    private readonly ttlMs: () => number,
    private readonly maxEntries = 500,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string, load: () => Promise<T>): Promise<T> {
    const ttlMs = this.ttlMs();
    if (ttlMs <= 0) return load();

    const now = Date.now();
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > now) return hit.value;

    this.dropExpired(now);
    const value = load();
    this.entries.set(key, { expiresAt: now + ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  private dropExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

/** Rounds a range down to `alignSeconds` so viewers a few seconds apart ask the same question. */
export function alignRange(
  start: number,
  end: number,
  alignSeconds: number,
): { start: number; end: number } {
  return {
    start: Math.floor(start / alignSeconds) * alignSeconds,
    end: Math.floor(end / alignSeconds) * alignSeconds,
  };
}
