jest.mock('@kubernetes/client-node', () => ({}));

import { TerminalTargetResolver } from './terminal-target.resolver';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

const node = {
  id: 'n1',
  clusterId: 'c1',
  serverName: 'c1-master',
  ipAddress: '10.0.0.1',
  providerResourceId: 'srv-1',
};

function resolverHolding(held: string[]) {
  const policy = {
    check: jest.fn(async (_p: unknown, permission: string) =>
      held.includes(permission),
    ),
  };
  const resolver = new TerminalTargetResolver(
    { findOne: async () => node } as never,
    {
      findOne: async () => ({ id: 'c1', name: 'c1', provider: 'hetzner' }),
    } as never,
    { findOne: async () => null } as never,
    policy as never,
  );
  return resolver;
}

const user = { userId: 'u1', email: 'op@support.example', isAdmin: false };

describe('TerminalTargetResolver', () => {
  it('opens a shell for someone who manages the cluster and may reach its data', async () => {
    const resolver = resolverHolding([
      IAM_PERMISSION.CLUSTER_MANAGE,
      IAM_PERMISSION.DATA_ACCESS,
    ]);
    await expect(
      resolver.resolve(user as never, 'srv-1'),
    ).resolves.toMatchObject({
      serverIp: '10.0.0.1',
    });
  });

  it('refuses a shell to someone who manages the cluster without data access', async () => {
    const resolver = resolverHolding([IAM_PERMISSION.CLUSTER_MANAGE]);
    await expect(resolver.resolve(user as never, 'srv-1')).resolves.toBeNull();
  });

  it('refuses an agent key whose scopes do not carry data access', async () => {
    const resolver = resolverHolding([
      IAM_PERMISSION.CLUSTER_MANAGE,
      IAM_PERMISSION.DATA_ACCESS,
    ]);
    const agent = { ...user, scopes: ['mcp:infra:read'] };
    await expect(resolver.resolve(agent as never, 'srv-1')).resolves.toBeNull();
  });
});
