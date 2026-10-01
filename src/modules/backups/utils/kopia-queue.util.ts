/**
 * How many kopia Jobs run at once, and never two on one repository.
 *
 * Two Jobs on the same repository would both be its maintenance owner, and
 * kopia assumes one maintainer at a time; they also skew each other's upload
 * accounting. Across repositories the cap keeps a night of scheduled copies
 * from landing on a small cluster, and on the object store, all at once.
 */
export class KopiaJobQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error('maxConcurrent must be at least 1');
  }

  get active(): number {
    return this.running;
  }

  /** Runs `task` after every earlier task on `key`, within the global cap. */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    try {
      await previous;
      await this.acquire();
      try {
        return await task();
      } finally {
        this.releaseSlot();
      }
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      }),
    );
  }

  private releaseSlot(): void {
    this.running -= 1;
    this.waiting.shift()?.();
  }
}

/** Spreads scheduled starts, so a shared cron minute does not start them together. */
export function kopiaStartJitterMs(
  random: () => number = Math.random,
  maxMs = 30_000,
): number {
  return Math.floor(random() * maxMs);
}
