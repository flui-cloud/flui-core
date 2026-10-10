import { createHash } from 'node:crypto';
import { DataSource } from 'typeorm';

/** Two 32-bit halves of a stable hash, Flui's way of naming an advisory lock. */
export function advisoryKey(name: string): [number, number] {
  const digest = createHash('sha256').update(name).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Runs `work` only if no other copy of the API holds the same named lock, and
 * says whether it ran. The lock lives on a connection of its own for the
 * duration, and is let go before that connection returns to the pool.
 */
export async function withAdvisoryLock<T>(
  dataSource: DataSource,
  name: string,
  work: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  const [a, b] = advisoryKey(name);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    const [row] = await runner.query(
      'SELECT pg_try_advisory_lock($1, $2) AS held',
      [a, b],
    );
    if (row?.held !== true) return { ran: false };
    try {
      return { ran: true, result: await work() };
    } finally {
      await runner
        .query('SELECT pg_advisory_unlock($1, $2)', [a, b])
        .catch(() => undefined);
    }
  } finally {
    await runner.release();
  }
}

/**
 * Runs `work` once no other copy of the API holds the same named lock, waiting
 * for it as long as it takes. For work that must happen, one copy at a time.
 */
export async function withAdvisoryLockWaiting<T>(
  dataSource: DataSource,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const [a, b] = advisoryKey(name);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query('SELECT pg_advisory_lock($1, $2)', [a, b]);
    try {
      return await work();
    } finally {
      await runner
        .query('SELECT pg_advisory_unlock($1, $2)', [a, b])
        .catch(() => undefined);
    }
  } finally {
    await runner.release();
  }
}
