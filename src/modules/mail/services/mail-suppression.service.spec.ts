import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { DeliveryEvent } from '@flui-cloud/mail';
import { MailSuppressionService } from './mail-suppression.service';
import { MailSuppressionEntity } from '../entities/mail-suppression.entity';

/** An in-memory stand-in that honours the `In(...)` filter the service relies on. */
function fakeRepository(seed: Partial<MailSuppressionEntity>[] = []) {
  let rows = seed.map((r, i) => ({
    id: r.id ?? `id-${i}`,
    address: r.address!,
    reason: r.reason ?? 'bounce',
    scope: r.scope ?? 'all',
    suppressedAt: r.suppressedAt ?? new Date('2026-08-01T00:00:00Z'),
    source: r.source ?? null,
    detail: r.detail ?? null,
  })) as MailSuppressionEntity[];

  return {
    rows: () => rows,
    find: jest.fn(async (options?: { where?: { address?: unknown } }) => {
      const where = options?.where?.address as
        | { _value?: string[] }
        | undefined;
      const wanted = where?._value;
      return wanted
        ? rows.filter((r) => wanted.includes(r.address))
        : [...rows];
    }),
    save: jest.fn(async (row: MailSuppressionEntity) => {
      rows = rows.filter((r) => r.address !== row.address);
      rows.push({
        ...row,
        id: row.id ?? `id-${rows.length}`,
      } as MailSuppressionEntity);
      return row;
    }),
    delete: jest.fn(async (criteria: { address: string }) => {
      rows = rows.filter((r) => r.address !== criteria.address);
      return { affected: 1 };
    }),
  };
}

async function build(repo: ReturnType<typeof fakeRepository>) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      MailSuppressionService,
      { provide: getRepositoryToken(MailSuppressionEntity), useValue: repo },
    ],
  }).compile();
  return moduleRef.get(MailSuppressionService);
}

describe('MailSuppressionService', () => {
  it('keeps a bulk suppression away from transactional mail', async () => {
    // The bug this column exists to prevent: someone leaves the newsletter and
    // silently stops receiving their own password resets.
    const repo = fakeRepository([
      { address: 'reader@example.com', reason: 'unsubscribe', scope: 'bulk' },
    ]);
    const service = await build(repo);

    expect(
      await service.suppressed(['reader@example.com'], 'transactional'),
    ).toEqual([]);
    expect(
      await service.suppressed(['reader@example.com'], 'bulk'),
    ).toHaveLength(1);
  });

  it('lets an `all` suppression stop both', async () => {
    const repo = fakeRepository([
      { address: 'dead@example.com', reason: 'bounce', scope: 'all' },
    ]);
    const service = await build(repo);

    expect(
      await service.suppressed(['dead@example.com'], 'transactional'),
    ).toHaveLength(1);
    expect(await service.suppressed(['dead@example.com'], 'bulk')).toHaveLength(
      1,
    );
  });

  it('normalises before comparing, which is how a suppression is slipped past', async () => {
    const repo = fakeRepository([
      { address: 'dead@example.com', scope: 'all' },
    ]);
    const service = await build(repo);

    expect(await service.suppressed([' Dead@EXAMPLE.com '])).toHaveLength(1);
  });

  it('asks nothing of the database when there is nothing to ask about', async () => {
    const repo = fakeRepository();
    const service = await build(repo);

    expect(await service.suppressed([])).toEqual([]);
    expect(repo.find).not.toHaveBeenCalled();
  });

  it('folds on write so one address keeps one row, strongest reason winning', async () => {
    const repo = fakeRepository([
      { address: 'a@example.com', reason: 'bounce', scope: 'all' },
    ]);
    const service = await build(repo);

    await service.add([
      {
        address: 'a@example.com',
        reason: 'complaint',
        scope: 'all',
        at: '2026-08-05T00:00:00Z',
      },
    ]);

    expect(repo.rows()).toHaveLength(1);
    expect(repo.rows()[0]).toMatchObject({ reason: 'complaint' });
  });

  it('widens the scope when a bulk suppression meets a dead mailbox', async () => {
    const repo = fakeRepository([
      { address: 'a@example.com', reason: 'unsubscribe', scope: 'bulk' },
    ]);
    const service = await build(repo);

    await service.add([
      {
        address: 'a@example.com',
        reason: 'bounce',
        scope: 'all',
        at: '2026-08-05T00:00:00Z',
      },
    ]);

    expect(repo.rows()[0]).toMatchObject({ reason: 'bounce', scope: 'all' });
  });

  it('records a permanent bounce from events and leaves an ambiguous one alone', async () => {
    const repo = fakeRepository();
    const service = await build(repo);

    const base: DeliveryEvent = {
      kind: 'bounced',
      provider: 'scaleway-tem',
      messageId: 'm1',
      recipient: 'gone@example.com',
      at: '2026-08-10T00:00:00Z',
    };
    const recorded = await service.recordEvents([
      { ...base, code: 550 },
      // 4xx is the receiver asking us back later — greylisting is designed to
      // look like this. Suppressing here would cut off a working address.
      { ...base, recipient: 'later@example.com', code: 451 },
      { ...base, recipient: 'unknown@example.com' },
    ]);

    expect(recorded).toBe(1);
    expect(repo.rows().map((r) => r.address)).toEqual(['gone@example.com']);
  });

  it('can undo — a mailbox full in March exists again in April', async () => {
    const repo = fakeRepository([
      { address: 'back@example.com', scope: 'all' },
    ]);
    const service = await build(repo);

    await service.remove('Back@Example.com');
    expect(repo.rows()).toHaveLength(0);
  });
});

// The fake reads `In(...)`'s internal shape; assert the assumption holds so an
// upgrade that changes it fails here rather than making every test vacuous.
describe('the In() assumption the fake depends on', () => {
  it('carries its values under _value', () => {
    expect((In(['a']) as unknown as { _value: string[] })._value).toEqual([
      'a',
    ]);
  });
});

export type _Repo = Repository<MailSuppressionEntity>;
