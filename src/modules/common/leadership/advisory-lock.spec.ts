import {
  advisoryKey,
  withAdvisoryLock,
  withAdvisoryLockWaiting,
} from './advisory-lock';

const database = (held: boolean) => {
  const calls: string[] = [];
  let released = false;
  return {
    calls,
    released: () => released,
    source: {
      createQueryRunner: () => ({
        connect: async () => undefined,
        release: async () => {
          released = true;
        },
        query: async (sql: string) => {
          calls.push(sql.split('(')[0].replace('SELECT ', ''));
          return sql.includes('pg_try_advisory_lock') ? [{ held }] : [{}];
        },
      }),
    } as never,
  };
};

describe('named locks shared by every copy of the API', () => {
  it('runs the work when the lock is free, then lets it go before giving the connection back', async () => {
    const db = database(true);
    const out = await withAdvisoryLock(db.source, 'scaling:c1', async () => 42);
    expect(out).toEqual({ ran: true, result: 42 });
    expect(db.calls).toEqual(['pg_try_advisory_lock', 'pg_advisory_unlock']);
    expect(db.released()).toBe(true);
  });

  it('skips the work when another copy holds it', async () => {
    const db = database(false);
    const work = jest.fn();
    expect(await withAdvisoryLock(db.source, 'scaling:c1', work)).toEqual({
      ran: false,
    });
    expect(work).not.toHaveBeenCalled();
    expect(db.released()).toBe(true);
  });

  it('waits for the lock, and lets it go even when the work fails', async () => {
    const db = database(true);
    await expect(
      withAdvisoryLockWaiting(db.source, 'kopia:repo', async () => {
        throw new Error('job failed');
      }),
    ).rejects.toThrow('job failed');
    expect(db.calls).toEqual(['pg_advisory_lock', 'pg_advisory_unlock']);
    expect(db.released()).toBe(true);
  });

  it('names each lock with the same two numbers every time', () => {
    expect(advisoryKey('kopia:repo')).toEqual(advisoryKey('kopia:repo'));
    expect(advisoryKey('kopia:repo')).not.toEqual(advisoryKey('kopia:other'));
  });
});
