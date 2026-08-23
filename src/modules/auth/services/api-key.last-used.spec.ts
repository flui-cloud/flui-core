import { Repository } from 'typeorm';
import { ApiKeyService } from './api-key.service';
import { ApiKeyEntity } from '../entities/api-key.entity';

/**
 * The threshold IS the decision (72), not an implementation detail: this write
 * sits on the hot path of every authenticated request, and an `UPDATE` per
 * request would make every call to this product pay for a column read by a
 * screen somebody opens twice a year.
 */
describe('ApiKeyService.touch — at most one write a minute per key', () => {
  const build = () => {
    const executed: Array<{ where: string; and: string }> = [];
    const qb = {
      update: () => qb,
      set: () => qb,
      where: (w: string) => {
        executed.push({ where: w, and: '' });
        return qb;
      },
      andWhere: (a: string) => {
        executed[executed.length - 1].and = a;
        return qb;
      },
      execute: () => Promise.resolve({ affected: 1 }),
    };
    const repo = {
      createQueryBuilder: () => qb,
    } as unknown as Repository<ApiKeyEntity>;
    return { service: new ApiKeyService(repo), executed };
  };

  it('writes the first time it sees a key', () => {
    const { service, executed } = build();
    service.touch('key-1');
    expect(executed).toHaveLength(1);
  });

  it('does not write again within the minute', () => {
    const { service, executed } = build();
    for (let i = 0; i < 500; i++) service.touch('key-1');
    expect(executed).toHaveLength(1);
  });

  it('counts the minute per key, not globally', () => {
    const { service, executed } = build();
    service.touch('key-1');
    service.touch('key-2');
    service.touch('key-1');
    expect(executed).toHaveLength(2);
  });

  it('writes again once the minute has passed', () => {
    jest.useFakeTimers();
    try {
      const { service, executed } = build();
      service.touch('key-1');
      jest.advanceTimersByTime(60_001);
      service.touch('key-1');
      expect(executed).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The in-process map is only half the promise. With three replicas it would
   * be three writes a minute per key; the predicate makes the statement true
   * wherever it is issued from.
   */
  it('carries the same threshold in the statement, for the other replicas', () => {
    const { service, executed } = build();
    service.touch('key-1');
    expect(executed[0].and).toContain("interval '1 minute'");
    expect(executed[0].and).toContain('IS NULL');
  });

  it('never throws into the authentication path', async () => {
    const failing = {
      createQueryBuilder: () => ({
        update: () => failingQb,
        set: () => failingQb,
        where: () => failingQb,
        andWhere: () => failingQb,
        execute: () => Promise.reject(new Error('database is away')),
      }),
    } as unknown as Repository<ApiKeyEntity>;
    const failingQb = failing.createQueryBuilder() as never;
    const service = new ApiKeyService(failing);
    expect(() => service.touch('key-1')).not.toThrow();
    // And the rejection is swallowed rather than left unhandled.
    await new Promise((r) => setImmediate(r));
  });
});
