jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({
  __esModule: true,
  default: class {},
}));

import { ForbiddenException } from '@nestjs/common';
import { ApiKeysController } from './api-keys.controller';
import { PolicyEngineService } from '../../iam/services/policy-engine.service';
import { IdentityRole } from '../entities/user.entity';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { IAM_ROLE } from '../../iam/constants/iam-roles';
import { SHOWCASE_GRANT } from '../../iam/constants/iam-showcase';
import { PERMISSION_GROUPS } from '../constants/api-key-groups';

/**
 * A visitor who has not signed in connects an agent through the same ceiling
 * as everybody else: it holds reads only, so only the reading groups are
 * grantable, and a request that names a write is refused whole.
 */
describe('api keys — a visitor of the demo', () => {
  const visitor: AuthenticatedUser = {
    userId: 'v-1',
    email: 'visitor-1a2b3c4d@visitors.invalid',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  };

  const engine = new PolicyEngineService(
    {
      createQueryBuilder: () => {
        const qb: Record<string, unknown> = {};
        qb.where = () => qb;
        qb.orWhere = () => qb;
        qb.getMany = async () => [
          {
            principalType: 'user',
            principalRef: 'v-1',
            role: IAM_ROLE.SANDBOX_VISITOR,
            scopeType: 'selector',
            scopeRef: null,
            selector: { owner: 'v-1' },
          },
          {
            principalType: 'user',
            principalRef: 'v-1',
            role: SHOWCASE_GRANT.role,
            scopeType: 'selector',
            scopeRef: null,
            selector: SHOWCASE_GRANT.selector,
          },
        ];
        return qb;
      },
    } as never,
    { find: async () => [] } as never,
  );

  const generate = jest.fn(
    async (name: string, userId: string, _e: unknown, scopes?: string[]) => ({
      entity: {
        id: 'key-1',
        name,
        userId,
        revoked: false,
        createdAt: new Date(0),
        scopes: scopes ?? null,
      },
      plaintext: 'flui_test-key',
    }),
  );
  const createdAt = new Date('2026-10-13T10:00:00Z');
  const controller = new ApiKeysController(
    { generateApiKey: generate } as never,
    engine,
    { findOne: async () => ({ id: 'v-1', createdAt }) } as never,
  );
  const lastDay = new Date(createdAt.getTime() + 168 * 3_600_000);

  let previous: string | undefined;
  beforeAll(() => {
    previous = process.env.AUTH_MODE;
    process.env.AUTH_MODE = 'oidc';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
  });
  beforeEach(() => generate.mockClear());

  it('may switch on only the groups that read', async () => {
    const groups = await controller.listPermissionGroups({ user: visitor });
    const grantable = groups.filter((g) => g.grantable).map((g) => g.key);

    expect(grantable).toEqual(['apps:look', 'observability:look']);
    for (const key of grantable) {
      expect(PERMISSION_GROUPS.find((g) => g.key === key)!.depth).toBe('look');
    }
  });

  it('gets a key that reads', async () => {
    const created = await controller.createApiKey(
      { user: visitor },
      { name: 'my-agent', groups: ['apps:look', 'observability:look'] },
    );

    expect(created.key).toBe('flui_test-key');
    expect(created.groups).toEqual(['apps:look', 'observability:look']);
  });

  it.each([['apps:change'], ['apps:destroy']])(
    'is refused %s whole, even beside a group it may have',
    async (write) => {
      await expect(
        controller.createApiKey(
          { user: visitor },
          { name: 'greedy', groups: ['apps:look', write] },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(generate).not.toHaveBeenCalled();
    },
  );

  it('is refused an unscoped key, by name', async () => {
    await expect(
      controller.createApiKey(
        { user: visitor },
        { name: 'all', unscoped: true },
      ),
    ).rejects.toThrow(/unscoped/);
    expect(generate).not.toHaveBeenCalled();
  });

  it('gets a key that ends with the visitor, whatever it asked for', async () => {
    await controller.createApiKey(
      { user: visitor },
      { name: 'forever', groups: ['apps:look'] },
    );
    expect(generate.mock.calls[0][2]).toEqual(lastDay);

    await controller.createApiKey(
      { user: visitor },
      {
        name: 'later',
        groups: ['apps:look'],
        expiresAt: '2030-01-01T00:00:00Z',
      },
    );
    expect(generate.mock.calls[1][2]).toEqual(lastDay);

    const sooner = new Date(createdAt.getTime() + 3_600_000);
    await controller.createApiKey(
      { user: visitor },
      {
        name: 'sooner',
        groups: ['apps:look'],
        expiresAt: sooner.toISOString(),
      },
    );
    expect(generate.mock.calls[2][2]).toEqual(sooner);
  });
});
