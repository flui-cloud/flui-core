export { advisoryKey } from '../advisory-lock';

const held = new Set<string>();
const queues = new Map<string, Promise<unknown>>();

/** Locks taken through the fake, in order, for tests to assert on. */
export const takenLocks: string[] = [];

/** Pretends another copy of the API holds `name` until the returned release runs. */
export function holdLock(name: string): () => void {
  held.add(name);
  return () => held.delete(name);
}

export function resetFakeLocks(): void {
  held.clear();
  queues.clear();
  takenLocks.length = 0;
}

export async function withAdvisoryLock<T>(
  _source: unknown,
  name: string,
  work: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
  if (held.has(name)) return { ran: false };
  held.add(name);
  takenLocks.push(name);
  try {
    return { ran: true, result: await work() };
  } finally {
    held.delete(name);
  }
}

export function withAdvisoryLockWaiting<T>(
  _source: unknown,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  const before = queues.get(name) ?? Promise.resolve();
  const run = before.then(() => {
    takenLocks.push(name);
    return work();
  });
  queues.set(
    name,
    run.catch(() => undefined),
  );
  return run;
}
