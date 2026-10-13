jest.mock('@kubernetes/client-node', () => ({}));

import {
  ConflictException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { VisitorLinkService, hashSecret } from './visitor-link.service';

type Row = Record<string, unknown> & { id: string };

const build = (opts: {
  users?: Record<string, Record<string, unknown>>;
  merge?: { done: boolean; reason?: string };
}) => {
  const rows: Row[] = [];
  const users = opts.users ?? {};
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) =>
      v && typeof v === 'object' && '_type' in (v as object)
        ? (row[k] ?? null) === null
        : row[k] === v,
    );
  const upgrades = {
    create: (row: Record<string, unknown>) => row,
    save: jest.fn(async (row: Record<string, unknown>) => {
      const saved = {
        id: `u${rows.length + 1}`,
        claimedAt: null,
        outcome: null,
        ...row,
      };
      rows.push(saved as Row);
      return saved;
    }),
    findOne: jest.fn(
      async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => matches(r, where)) ?? null,
    ),
    update: jest.fn(
      async (where: Record<string, unknown>, set: Record<string, unknown>) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, set));
        return { affected: hit.length };
      },
    ),
    delete: jest.fn(async () => ({ affected: 2 })),
  };
  const userRepo = {
    findOne: jest.fn(
      async ({ where }: { where: { id: string } }) => users[where.id] ?? null,
    ),
  };
  const merge = {
    fold: jest.fn(async () => opts.merge ?? { done: true }),
  };
  const service = new VisitorLinkService(
    upgrades as never,
    userRepo as never,
    merge as never,
  );
  return { service, rows, merge, upgrades };
};

const VISITOR = { id: 'v1', kind: 'visitor', blockedAt: null };
const ACCOUNT = { id: 'r1', kind: 'person', email: 'r@example.com' };
const NOW = new Date('2026-10-13T12:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe('VisitorLinkService', () => {
  it('gives a visitor a single-use nonce, kept only as its hash, for 15 minutes', async () => {
    const { service, rows } = build({ users: { v1: VISITOR } });

    const intent = await service.createIntent('v1', '/apps', NOW);

    expect(intent.nonce.length).toBeGreaterThanOrEqual(40);
    expect(intent.expiresAt).toEqual(later(15 * 60_000));
    expect(rows[0]).toEqual(
      expect.objectContaining({
        visitorUserId: 'v1',
        method: 'email',
        secretHash: hashSecret(intent.nonce),
        returnTo: '/apps',
      }),
    );
    expect(JSON.stringify(rows)).not.toContain(intent.nonce);
  });

  it('refuses a nonce to anybody who is not a visitor', async () => {
    const { service } = build({ users: { r1: ACCOUNT } });

    await expect(service.visitorOrRefuse('r1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('folds the visit into the account that comes back with the nonce', async () => {
    const { service, merge, rows } = build({
      users: { v1: VISITOR, r1: ACCOUNT },
    });
    const { nonce } = await service.createIntent('v1', '/apps', NOW);

    const result = await service.link('r1', nonce, later(60_000));

    expect(result).toEqual({ outcome: 'linked', returnTo: '/apps' });
    expect(merge.fold).toHaveBeenCalledWith(
      'v1',
      ACCOUNT,
      'email',
      later(60_000),
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({ outcome: 'linked', linkedUserId: 'r1' }),
    );
  });

  it('answers the same again to the same account, without merging twice', async () => {
    const { service, merge } = build({ users: { v1: VISITOR, r1: ACCOUNT } });
    const { nonce } = await service.createIntent('v1', null, NOW);
    await service.link('r1', nonce, NOW);

    await expect(service.link('r1', nonce, NOW)).resolves.toEqual({
      outcome: 'linked',
      returnTo: null,
    });
    expect(merge.fold).toHaveBeenCalledTimes(1);
  });

  it('refuses a used nonce to another account', async () => {
    const { service } = build({
      users: { v1: VISITOR, r1: ACCOUNT, r2: { ...ACCOUNT, id: 'r2' } },
    });
    const { nonce } = await service.createIntent('v1', null, NOW);
    await service.link('r1', nonce, NOW);

    await expect(service.link('r2', nonce, NOW)).rejects.toBeInstanceOf(
      GoneException,
    );
  });

  it('refuses an expired nonce', async () => {
    const { service, merge } = build({ users: { v1: VISITOR, r1: ACCOUNT } });
    const { nonce } = await service.createIntent('v1', null, NOW);

    await expect(
      service.link('r1', nonce, later(16 * 60_000)),
    ).rejects.toBeInstanceOf(GoneException);
    expect(merge.fold).not.toHaveBeenCalled();
  });

  it('does not know a nonce it never gave', async () => {
    const { service } = build({ users: { r1: ACCOUNT } });

    await expect(
      service.link('r1', 'x'.repeat(43), NOW),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a visitor sending its own nonce', async () => {
    const { service } = build({
      users: { v1: VISITOR, v2: { ...VISITOR, id: 'v2' } },
    });
    const { nonce } = await service.createIntent('v1', null, NOW);

    await expect(service.link('v2', nonce, NOW)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses the link of a blocked visitor, and leaves the account alone', async () => {
    const { service, rows } = build({
      users: { v1: VISITOR, r1: ACCOUNT },
      merge: { done: false, reason: 'blocked' },
    });
    const { nonce } = await service.createIntent('v1', null, NOW);

    await expect(service.link('r1', nonce, NOW)).rejects.toMatchObject({
      response: expect.objectContaining({ reason: 'blocked' }),
    });
    expect(rows[0].outcome).toBe('refused');
  });

  it('lets a failed merge be tried again', async () => {
    const { service, merge, rows } = build({
      users: { v1: VISITOR, r1: ACCOUNT },
    });
    merge.fold.mockRejectedValueOnce(new Error('db down'));
    const { nonce } = await service.createIntent('v1', null, NOW);

    await expect(service.link('r1', nonce, NOW)).rejects.toThrow('db down');
    expect(rows[0].claimedAt).toBeNull();
    await expect(service.link('r1', nonce, NOW)).resolves.toEqual(
      expect.objectContaining({ outcome: 'linked' }),
    );
  });
});
