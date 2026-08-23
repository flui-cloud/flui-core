jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));

import { mayActOnBuild } from './build-ownership.helper';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

const person = (userId: string, isAdmin = false): AuthenticatedUser => ({
  userId,
  email: `${userId}@example.test`,
  roles: {},
  role: IdentityRole.USER,
  isAdmin,
});

const lookups = (opts: {
  app?: { id: string } | null;
  mayRead?: boolean;
  operation?: { userId?: string | null } | null;
  sections?: { key: string; level: string }[];
}) => ({
  application: jest.fn().mockResolvedValue(opts.app ?? null),
  canOnApplication: jest.fn().mockResolvedValue(opts.mayRead ?? false),
  operation: jest.fn().mockResolvedValue(opts.operation ?? null),
  policy: {
    resolveSectionAccess: jest.fn().mockResolvedValue(opts.sections ?? []),
  } as never,
});

/**
 * One rule for four doors: the two per-application build routes, the standalone
 * ones, and the WebSocket room that streams the same log lines. Three of them
 * used to answer differently or not at all.
 */
describe('who may act on a build', () => {
  it('asks the application when the build has one', async () => {
    const deps = lookups({ app: { id: 'a1' }, mayRead: true });

    await expect(
      mayActOnBuild(
        { applicationId: 'a1' },
        person('owner'),
        IAM_PERMISSION.APP_READ,
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.canOnApplication).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner' }),
      IAM_PERMISSION.APP_READ,
      { id: 'a1' },
    );
  });

  it('refuses when the application says no', async () => {
    await expect(
      mayActOnBuild(
        { applicationId: 'a1' },
        person('stranger'),
        IAM_PERMISSION.APP_READ,
        lookups({ app: { id: 'a1' }, mayRead: false }),
      ),
    ).resolves.toBe(false);
  });

  /**
   * The wizard builds before the application exists. Its owner is the operation
   * that started it — the same rule the operations route and room already ask.
   */
  it('asks the operation when the build has no application yet', async () => {
    await expect(
      mayActOnBuild(
        { applicationId: null, operationId: 'op-1' },
        person('owner'),
        IAM_PERMISSION.APP_READ,
        lookups({ operation: { userId: 'owner' } }),
      ),
    ).resolves.toBe(true);
  });

  it('refuses somebody else that same build', async () => {
    await expect(
      mayActOnBuild(
        { applicationId: null, operationId: 'op-1' },
        person('stranger'),
        IAM_PERMISSION.APP_READ,
        lookups({ operation: { userId: 'owner' } }),
      ),
    ).resolves.toBe(false);
  });

  it('lets an operator through on the section instead', async () => {
    await expect(
      mayActOnBuild(
        { applicationId: null, operationId: 'op-1' },
        person('operator'),
        IAM_PERMISSION.APP_READ,
        lookups({
          operation: { userId: 'somebody' },
          sections: [{ key: 'infrastructure', level: 'full' }],
        }),
      ),
    ).resolves.toBe(true);
  });

  it('refuses a build nobody is recorded as having started', async () => {
    await expect(
      mayActOnBuild(
        { applicationId: null, operationId: null },
        person('somebody'),
        IAM_PERMISSION.APP_READ,
        lookups({}),
      ),
    ).resolves.toBe(false);
  });

  it('refuses an unauthenticated caller without looking anything up', async () => {
    const deps = lookups({ app: { id: 'a1' }, mayRead: true });

    await expect(
      mayActOnBuild(
        { applicationId: 'a1' },
        undefined,
        IAM_PERMISSION.APP_READ,
        deps,
      ),
    ).resolves.toBe(false);
    expect(deps.application).not.toHaveBeenCalled();
  });

  it('lets an admin through without looking anything up', async () => {
    const deps = lookups({ app: { id: 'a1' }, mayRead: false });

    await expect(
      mayActOnBuild(
        { applicationId: 'a1' },
        person('operator', true),
        IAM_PERMISSION.APP_READ,
        deps,
      ),
    ).resolves.toBe(true);
    expect(deps.canOnApplication).not.toHaveBeenCalled();
  });

  it('refuses a build that is not there', async () => {
    await expect(
      mayActOnBuild(
        null,
        person('owner'),
        IAM_PERMISSION.APP_READ,
        lookups({}),
      ),
    ).resolves.toBe(false);
  });
});
