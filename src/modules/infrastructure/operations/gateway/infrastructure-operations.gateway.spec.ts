jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));

import { InfrastructureOperationsGateway } from './infrastructure-operations.gateway';
import { AuthenticatedUser } from '../../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../../auth/entities/user.entity';

const person = (userId: string, isAdmin = false): AuthenticatedUser => ({
  userId,
  email: `${userId}@example.com`,
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

/**
 * The HTTP route stopped answering with somebody else's operation; the socket
 * that streams the very same events did not. Any authenticated connection that
 * guessed an id received progress, completion and failure — and the sandbox
 * fence is an HTTP guard, so it is not even in this path.
 */
describe('subscribing to an infrastructure operation', () => {
  const build = (opts: {
    operation?: { id: string; userId: string | null } | null;
    sectionLevel?: string;
    ownOnResource?: { id: string; userId: string | null } | null;
  }) => {
    const operations = {
      findOne: jest.fn(async (args: { where: Record<string, unknown> }) =>
        'userId' in args.where
          ? (opts.ownOnResource ?? null)
          : (opts.operation ?? null),
      ),
    };
    const policy = {
      resolveSectionAccess: jest
        .fn()
        .mockResolvedValue([
          { key: 'infrastructure', level: opts.sectionLevel ?? 'read-only' },
        ]),
    };
    return new InfrastructureOperationsGateway(
      {} as never,
      operations as never,
      policy as never,
    );
  };

  it('lets the person who started it in', async () => {
    const gw = build({ operation: { id: 'op-1', userId: 'alice' } });
    const client = socket(person('alice'));
    await gw.handleSubscribeOperation({ operationId: 'op-1' }, client as never);
    expect(client.joined).toEqual(['operation:op-1']);
    expect(client.emitted[0].event).toBe('subscribed');
  });

  it('keeps a second guest out of the first one’s operation', async () => {
    const gw = build({ operation: { id: 'op-1', userId: 'guest-a' } });
    const client = socket(person('guest-b'));
    await gw.handleSubscribeOperation({ operationId: 'op-1' }, client as never);
    expect(client.joined).toEqual([]);
    expect(client.emitted[0].event).toBe('subscription:refused');
  });

  it('refuses an operation with no owner to anyone but an operator', async () => {
    const gw = build({ operation: { id: 'op-1', userId: null } });
    const client = socket(person('guest-b'));
    await gw.handleSubscribeOperation({ operationId: 'op-1' }, client as never);
    expect(client.joined).toEqual([]);
  });

  it('lets the operator who holds the section at full follow anything', async () => {
    const gw = build({
      operation: { id: 'op-1', userId: 'alice' },
      sectionLevel: 'full',
    });
    const client = socket(person('ops'));
    await gw.handleSubscribeOperation({ operationId: 'op-1' }, client as never);
    expect(client.joined).toEqual(['operation:op-1']);
  });

  it('lets an administrator through without resolving anything', async () => {
    const gw = build({ operation: { id: 'op-1', userId: 'alice' } });
    const client = socket(person('root', true));
    await gw.handleSubscribeOperation({ operationId: 'op-1' }, client as never);
    expect(client.joined).toEqual(['operation:op-1']);
  });

  it('answers an id that does not exist exactly like one that is not yours', async () => {
    const gw = build({ operation: null });
    const client = socket(person('alice'));
    await gw.handleSubscribeOperation({ operationId: 'nope' }, client as never);
    expect(client.joined).toEqual([]);
    expect(client.emitted[0].payload).toEqual({
      operationId: 'nope',
      reason: 'not_found',
    });
  });

  it('refuses an unauthenticated socket', async () => {
    const gw = build({ operation: { id: 'op-1', userId: 'alice' } });
    const client = socket(undefined);
    await gw.handleSubscribeOperation({ operationId: 'op-1' }, client as never);
    expect(client.joined).toEqual([]);
  });
});

describe('subscribing to a resource, which is the same stream addressed differently', () => {
  const build = (opts: {
    ownOnResource?: { id: string; userId: string | null } | null;
    sectionLevel?: string;
  }) => {
    const operations = {
      findOne: jest.fn(async () => opts.ownOnResource ?? null),
    };
    const policy = {
      resolveSectionAccess: jest
        .fn()
        .mockResolvedValue([
          { key: 'infrastructure', level: opts.sectionLevel ?? 'read-only' },
        ]),
    };
    return new InfrastructureOperationsGateway(
      {} as never,
      operations as never,
      policy as never,
    );
  };

  it('lets you follow a resource you have an operation on', async () => {
    const gw = build({ ownOnResource: { id: 'op-1', userId: 'alice' } });
    const client = socket(person('alice'));
    await gw.handleSubscribeResource({ resourceId: 'app-1' }, client as never);
    expect(client.joined).toEqual(['resource:app-1']);
  });

  it('keeps a second guest off the first one’s application', async () => {
    const gw = build({ ownOnResource: null });
    const client = socket(person('guest-b'));
    await gw.handleSubscribeResource({ resourceId: 'app-1' }, client as never);
    expect(client.joined).toEqual([]);
    expect(client.emitted[0].event).toBe('subscription:refused');
  });

  it('lets the operator follow a cluster nothing has happened to yet', async () => {
    const gw = build({ ownOnResource: null, sectionLevel: 'full' });
    const client = socket(person('ops'));
    await gw.handleSubscribeResource(
      { resourceId: 'cluster-1' },
      client as never,
    );
    expect(client.joined).toEqual(['resource:cluster-1']);
  });
});
