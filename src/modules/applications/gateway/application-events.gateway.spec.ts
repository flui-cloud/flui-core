jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));

import { ApplicationEventsGateway } from './application-events.gateway';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

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

/**
 * Two sandbox guests, and the door the HTTP fence is not standing in.
 *
 * Proved live before it was closed: guest 2 named guest 1's application, was
 * joined without a question, and received the rollout progress of a restart
 * guest 1's agent had started — completion snapshot, namespace and deployment
 * name included. The route that answers the same data has asked
 * `AppAccessGuard` all along.
 */
describe('subscribing to an application room', () => {
  const build = (opts: {
    app?: { id: string } | null;
    mayRead?: boolean;
    build?: {
      id: string;
      applicationId: string | null;
      operationId?: string | null;
    } | null;
    operation?: { userId?: string | null } | null;
    sections?: { key: string; level: string }[];
  }) => {
    const applications = {
      findOne: jest.fn().mockResolvedValue(opts.app ?? null),
    };
    const access = {
      can: jest.fn().mockResolvedValue(opts.mayRead ?? false),
    };
    const builds = {
      findOne: jest.fn().mockResolvedValue(opts.build ?? null),
    };
    const operations = {
      findOne: jest.fn().mockResolvedValue(opts.operation ?? null),
    };
    const policy = {
      resolveSectionAccess: jest.fn().mockResolvedValue(opts.sections ?? []),
    };
    return {
      gateway: new ApplicationEventsGateway(
        {} as never,
        applications as never,
        access as never,
        builds as never,
        operations as never,
        policy as never,
      ),
      access,
    };
  };

  it('joins the owner', async () => {
    const { gateway, access } = build({ app: { id: 'a1' }, mayRead: true });
    const client = socket(person('owner'));

    await gateway.handleSubscribe({ appId: 'a1' }, client as never);

    expect(client.joined).toEqual(['application:a1']);
    expect(access.can).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner' }),
      IAM_PERMISSION.APP_READ,
      { id: 'a1' },
    );
  });

  it('refuses a guest naming another guest’s application', async () => {
    const { gateway } = build({ app: { id: 'a1' }, mayRead: false });
    const client = socket(person('other-guest'));

    await gateway.handleSubscribe({ appId: 'a1' }, client as never);

    expect(client.joined).toEqual([]);
    expect(client.emitted).toEqual([
      {
        event: 'subscription:refused',
        payload: { appId: 'a1', reason: 'not_found' },
      },
    ]);
  });

  /** An application nobody has and one somebody else has answer alike. */
  it('says the same thing about an id that names nothing', async () => {
    const { gateway } = build({ app: null });
    const client = socket(person('other-guest'));

    await gateway.handleSubscribe({ appId: 'ghost' }, client as never);

    expect(client.emitted[0]).toEqual({
      event: 'subscription:refused',
      payload: { appId: 'ghost', reason: 'not_found' },
    });
  });

  it('refuses an unauthenticated socket without asking anything', async () => {
    const { gateway, access } = build({ app: { id: 'a1' }, mayRead: true });
    const client = socket(undefined);

    await gateway.handleSubscribe({ appId: 'a1' }, client as never);

    expect(client.joined).toEqual([]);
    expect(access.can).not.toHaveBeenCalled();
  });

  it('lets an admin through without resolving access', async () => {
    const { gateway, access } = build({ app: { id: 'a1' }, mayRead: false });
    const client = socket(person('operator', true));

    await gateway.handleSubscribe({ appId: 'a1' }, client as never);

    expect(client.joined).toEqual(['application:a1']);
    expect(access.can).not.toHaveBeenCalled();
  });

  /**
   * The build room carries log lines, which is the most revealing stream here.
   * It is answered by the application the build belongs to.
   */
  describe('the build room', () => {
    it('joins the owner of the application the build belongs to', async () => {
      const { gateway } = build({
        app: { id: 'a1' },
        mayRead: true,
        build: { id: 'b1', applicationId: 'a1' },
      });
      const client = socket(person('owner'));

      await gateway.handleBuildSubscribe({ buildId: 'b1' }, client as never);

      expect(client.joined).toEqual(['build:b1']);
    });

    it('refuses everybody else', async () => {
      const { gateway } = build({
        app: { id: 'a1' },
        mayRead: false,
        build: { id: 'b1', applicationId: 'a1' },
      });
      const client = socket(person('other-guest'));

      await gateway.handleBuildSubscribe({ buildId: 'b1' }, client as never);

      expect(client.joined).toEqual([]);
      expect(client.emitted[0]).toEqual({
        event: 'subscription:refused',
        payload: { buildId: 'b1', reason: 'not_found' },
      });
    });

    it('refuses a build id that names nothing', async () => {
      const { gateway } = build({ app: { id: 'a1' }, mayRead: true });
      const client = socket(person('owner'));

      await gateway.handleBuildSubscribe({ buildId: 'ghost' }, client as never);

      expect(client.joined).toEqual([]);
    });

    /**
     * The wizard builds before the application exists, so this room has no
     * application to ask about. Closing it on that basis shut the deploy wizard
     * out of its own progress — including for an operator.
     */
    it('joins whoever started a build that has no application yet', async () => {
      const { gateway } = build({
        build: { id: 'b1', applicationId: null, operationId: 'op-1' },
        operation: { userId: 'owner' },
      });
      const client = socket(person('owner'));

      await gateway.handleBuildSubscribe({ buildId: 'b1' }, client as never);

      expect(client.joined).toEqual(['build:b1']);
    });

    it('refuses somebody else the same room', async () => {
      const { gateway } = build({
        build: { id: 'b1', applicationId: null, operationId: 'op-1' },
        operation: { userId: 'owner' },
      });
      const client = socket(person('other-guest'));

      await gateway.handleBuildSubscribe({ buildId: 'b1' }, client as never);

      expect(client.joined).toEqual([]);
    });

    it('refuses a build nobody is recorded as having started', async () => {
      const { gateway } = build({
        build: { id: 'b1', applicationId: null, operationId: null },
      });
      const client = socket(person('somebody'));

      await gateway.handleBuildSubscribe({ buildId: 'b1' }, client as never);

      expect(client.joined).toEqual([]);
    });
  });
});
