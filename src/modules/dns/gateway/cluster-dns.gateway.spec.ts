jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ClusterDnsGateway } from './cluster-dns.gateway';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { SectionAccess } from '../../iam/constants/iam-sections';

const person = (userId: string, isAdmin = false): AuthenticatedUser => ({
  userId,
  email: `${userId}@try.flui.cloud`,
  roles: {},
  role: IdentityRole.USER,
  isAdmin,
});

const socket = (user: AuthenticatedUser | undefined) => {
  const joined: string[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  return {
    id: 'socket-1',
    data: { user },
    join: (room: string) => joined.push(room),
    leave: jest.fn(),
    emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    joined,
    emitted,
  };
};

const gatewayFor = (sections: SectionAccess[]) =>
  new ClusterDnsGateway(
    {} as never,
    {
      resolveSectionAccess: async () => sections,
    } as never,
  );

/**
 * The last subscription on any gateway that asked nothing. Proved live before
 * it was closed: a sandbox guest named the cluster and was joined, and named a
 * cluster id that does not exist and was joined to that too.
 */
describe('subscribing to the cluster DNS room', () => {
  it('joins an operator who runs the area', async () => {
    const gateway = gatewayFor([{ key: 'infrastructure', level: 'full' }]);
    const client = socket(person('operator'));

    await gateway.handleSubscribe({ clusterId: 'c1' }, client as never);

    expect(client.joined).toEqual(['cluster:c1']);
  });

  it('joins an admin without resolving anything', async () => {
    const gateway = new ClusterDnsGateway(
      {} as never,
      {
        resolveSectionAccess: async () => {
          throw new Error('must not be asked');
        },
      } as never,
    );
    const client = socket(person('owner', true));

    await gateway.handleSubscribe({ clusterId: 'c1' }, client as never);

    expect(client.joined).toEqual(['cluster:c1']);
  });

  /** A guest holds the section read-only — that is how it sees it at all. */
  it('refuses a guest, whose level is read-only', async () => {
    const gateway = gatewayFor([{ key: 'infrastructure', level: 'read-only' }]);
    const client = socket(person('guest'));

    await gateway.handleSubscribe({ clusterId: 'c1' }, client as never);

    expect(client.joined).toEqual([]);
    expect(client.emitted).toEqual([
      {
        event: 'subscription:refused',
        payload: { clusterId: 'c1', reason: 'not_found' },
      },
    ]);
  });

  it('refuses somebody who does not hold the area at all', async () => {
    const gateway = gatewayFor([{ key: 'workloads', level: 'full' }]);
    const client = socket(person('operator'));

    await gateway.handleSubscribe({ clusterId: 'c1' }, client as never);

    expect(client.joined).toEqual([]);
  });

  it('refuses an unauthenticated socket without asking anything', async () => {
    const gateway = new ClusterDnsGateway(
      {} as never,
      {
        resolveSectionAccess: async () => {
          throw new Error('must not be asked');
        },
      } as never,
    );
    const client = socket(undefined);

    await gateway.handleSubscribe({ clusterId: 'c1' }, client as never);

    expect(client.joined).toEqual([]);
  });
});
