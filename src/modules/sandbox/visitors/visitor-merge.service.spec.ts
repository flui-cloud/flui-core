jest.mock('@kubernetes/client-node', () => ({}));

import { NotFoundException } from '@nestjs/common';
import { VisitorMergeService } from './visitor-merge.service';
import * as fold from './visitor-fold';

jest.mock('./visitor-fold', () => ({
  lockVisitor: jest.fn(),
  flipVisitorToPerson: jest.fn(async () => ({ guest: true })),
  foldVisitorInto: jest.fn(async () => undefined),
}));

const mocked = fold as jest.Mocked<typeof fold>;

const build = (visitor: Record<string, unknown> | null) => {
  mocked.lockVisitor.mockResolvedValue(visitor as never);
  const dataSource = {
    transaction: jest.fn(async (work: (m: unknown) => unknown) => work({})),
  };
  const directory = { deleteUser: jest.fn(async () => undefined) };
  const projects = { removePersonal: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new VisitorMergeService(
    dataSource as never,
    { enrol: jest.fn() } as never,
    directory as never,
    projects as never,
    audit as never,
  );
  return { service, directory, projects, audit, dataSource };
};

const VISITOR = { id: 'v1', oidcSub: 'idp-v1', blockedAt: null };
const CHANGE = {
  email: 'mario@example.com',
  firstName: null,
  lastName: null,
  displayName: null,
};

describe('VisitorMergeService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('flips a visitor in one transaction and records it', async () => {
    const { service, audit, dataSource } = build(VISITOR);

    expect(await service.flip('v1', CHANGE, 'github')).toEqual({
      done: true,
      guest: true,
    });
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sandbox.visitor.upgrade',
        outcome: 'ok',
        target: { visitorUserId: 'v1', via: 'github' },
      }),
    );
  });

  it('refuses a blocked visitor and leaves it as it is', async () => {
    const { service, audit } = build({ ...VISITOR, blockedAt: new Date() });

    expect(await service.flip('v1', CHANGE, 'google')).toEqual({
      done: false,
      reason: 'blocked',
    });
    expect(mocked.flipVisitorToPerson).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'refused' }),
    );
  });

  it('folds into an account, then removes the visitor at the identity provider', async () => {
    const { service, directory, projects, audit } = build(VISITOR);

    const result = await service.fold(
      'v1',
      { id: 'r1', email: 'r@example.com' },
      'email',
    );

    expect(result).toEqual({ done: true });
    expect(mocked.foldVisitorInto).toHaveBeenCalledWith(
      {},
      VISITOR,
      'r1',
      expect.any(Date),
    );
    expect(projects.removePersonal).toHaveBeenCalledWith('v1');
    expect(directory.deleteUser).toHaveBeenCalledWith('idp-v1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sandbox.visitor.fold',
        userId: 'v1',
        email: null,
        target: { visitorUserId: 'v1', via: 'email', intoUserId: 'r1' },
      }),
    );
  });

  it('keeps the merge when the identity provider cannot remove the visitor', async () => {
    const { service, directory } = build(VISITOR);
    directory.deleteUser.mockRejectedValueOnce(new Error('down'));

    await expect(
      service.fold('v1', { id: 'r1', email: 'r@example.com' }, 'github'),
    ).resolves.toEqual({ done: true });
  });

  it('treats a visitor already removed at the provider as removed', async () => {
    const { service, directory } = build(VISITOR);
    directory.deleteUser.mockRejectedValueOnce(new NotFoundException());

    await expect(
      service.fold('v1', { id: 'r1', email: null } as never, 'github'),
    ).resolves.toEqual({ done: true });
  });

  it('does nothing for a visitor that is gone', async () => {
    const { service, directory } = build(null);

    expect(
      await service.fold('v1', { id: 'r1', email: null } as never, 'email'),
    ).toEqual({ done: false, reason: 'gone' });
    expect(directory.deleteUser).not.toHaveBeenCalled();
  });
});
