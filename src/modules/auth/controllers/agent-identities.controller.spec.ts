import {
  BadRequestException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';
import { AgentIdentitiesController } from './agent-identities.controller';
import { AgentIdentityService } from '../services/agent-identity.service';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { findPermissionGroup } from '../constants/api-key-groups';
import { orderScopes } from '../constants/api-key-scopes';

/**
 * The route decision 113 asked for: `AgentIdentityService` was built, tested and
 * exposed by nothing.
 *
 * What is worth testing here is the half that lives on the route rather than in
 * the service. The service refuses a scope the *caller's own credential* does
 * not carry; the route refuses a scope the caller has no *permission* to confer,
 * and it has to do that before anything is written to the provider — a machine
 * account created and then refused is an orphan in somebody else's system.
 */
const caller = (over: Partial<AuthenticatedUser> = {}): AuthenticatedUser =>
  ({
    userId: 'u-1',
    email: 'maintainer@acme.com',
    isAdmin: false,
    ...over,
  }) as AuthenticatedUser;

interface Stub {
  provisioned?: { name: string; scopes: string[] };
  revoked?: string;
}

function build(opts: { beyond?: string[]; listed?: unknown[] } = {}) {
  const stub: Stub = {};
  const agents = {
    beyondPermissions: jest.fn().mockResolvedValue(opts.beyond ?? []),
    provision: jest.fn(async (_issuer, name: string, scopes: string[]) => {
      stub.provisioned = { name, scopes };
      return {
        userId: 'm-1',
        userName: `flui-agent-${name}`,
        clientId: 'cid',
        clientSecret: 'shhh',
        scopes,
      };
    }),
    revoke: jest.fn(async (name: string) => {
      stub.revoked = name;
      return true;
    }),
    localAccountIds: jest.fn(
      async (ids: string[]) => new Map(ids.map((id) => [id, `local-${id}`])),
    ),
    list: jest.fn().mockResolvedValue(
      opts.listed ?? [
        {
          id: 'm-1',
          userName: 'flui-agent-release-bot',
          name: 'release-bot',
        },
      ],
    ),
  };
  const controller = new AgentIdentitiesController(
    agents as unknown as AgentIdentityService,
  );
  return { controller, agents, stub };
}

describe('POST /auth/agent-identities', () => {
  const previous = process.env.AUTH_MODE;
  beforeAll(() => {
    process.env.AUTH_MODE = 'oidc';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
  });

  it('mints the scopes asked for and hands the secret over once', async () => {
    const { controller, stub } = build();
    const result = await controller.create({ user: caller() }, {
      name: 'release-bot',
      scopes: [MCP_SCOPE.APP_READ],
    } as never);
    expect(stub.provisioned).toEqual({
      name: 'release-bot',
      scopes: [MCP_SCOPE.APP_READ],
    });
    expect(result.userName).toBe('flui-agent-release-bot');
    expect(result.clientSecret).toBe('shhh');
  });

  /**
   * A group is the unit a person consents to, and it has to mean the same thing
   * here as it does on an API key — otherwise two ways of connecting the same
   * agent hand it different powers under the same word.
   */
  it('expands a group into exactly the scopes the key surface would', async () => {
    const { controller, stub } = build();
    await controller.create({ user: caller() }, {
      name: 'ops',
      groups: ['apps:change'],
    } as never);
    // In the catalogue's own order, which is what the API-key path stores too:
    // two identical grants must not read as two different credentials.
    expect(stub.provisioned?.scopes).toEqual(
      orderScopes([...findPermissionGroup('apps:change')!.scopes]),
    );
  });

  it('derives the groups back onto the answer, so the caller reads what it asked for', async () => {
    const { controller } = build();
    const result = await controller.create({ user: caller() }, {
      name: 'ops',
      groups: ['apps:change'],
    } as never);
    expect(result.groups).toEqual(['apps:change', 'observability:look']);
  });

  describe('a scope above the caller', () => {
    it('is refused before anything is created in the provider', async () => {
      const { controller, agents } = build({ beyond: [MCP_SCOPE.IAM_WRITE] });
      await expect(
        controller.create({ user: caller() }, {
          name: 'ops',
          scopes: [MCP_SCOPE.APP_READ, MCP_SCOPE.IAM_WRITE],
        } as never),
      ).rejects.toThrow(ForbiddenException);
      expect(agents.provision).not.toHaveBeenCalled();
    });

    it('names which scope stopped it', async () => {
      const { controller } = build({ beyond: [MCP_SCOPE.IAM_WRITE] });
      await expect(
        controller.create({ user: caller() }, {
          name: 'ops',
          scopes: [MCP_SCOPE.IAM_WRITE],
        } as never),
      ).rejects.toThrow(/mcp:iam:write/);
    });
  });

  describe('a request that says nothing', () => {
    it('is refused, because there is no unscoped agent identity', async () => {
      const { controller, agents } = build();
      await expect(
        controller.create({ user: caller() }, { name: 'ops' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(agents.beyondPermissions).not.toHaveBeenCalled();
    });

    it('refuses a group and a scope this installation does not have', async () => {
      const { controller } = build();
      await expect(
        controller.create({ user: caller() }, {
          name: 'ops',
          groups: ['apps:everything'],
        } as never),
      ).rejects.toThrow(/Unknown group/);
      await expect(
        controller.create({ user: caller() }, {
          name: 'ops',
          scopes: ['mcp:not:a:scope'],
        } as never),
      ).rejects.toThrow(/Unknown scope/);
    });
  });

  /**
   * `AUTH_MODE=local` installs no provider at all (decision 101, second
   * constraint). Answering 501 here rather than letting the service reach for a
   * provider context that will not be there keeps the failure legible.
   */
  it('says so plainly on an installation with no identity provider', async () => {
    process.env.AUTH_MODE = 'local';
    const { controller, agents } = build();
    await expect(
      controller.create({ user: caller() }, {
        name: 'ops',
        scopes: [MCP_SCOPE.APP_READ],
      } as never),
    ).rejects.toThrow(HttpException);
    expect(agents.provision).not.toHaveBeenCalled();
    process.env.AUTH_MODE = 'oidc';
  });
});

describe('the rest of the surface', () => {
  it('lists what Flui minted, in the shape a screen needs', async () => {
    const { controller } = build();
    expect(await controller.list()).toEqual([
      {
        userId: 'm-1',
        userName: 'flui-agent-release-bot',
        name: 'release-bot',
        fluiUserId: 'local-m-1',
      },
    ]);
  });

  /**
   * The identity is in the provider from the moment it is minted; the account
   * its calls are recorded against does not exist until it presents a token.
   * Saying `null` is the honest reading of "connected, never active" — the row
   * is still listed, and the panel has nothing to join it to yet.
   */
  it('says so when a minted identity has never authenticated', async () => {
    const { controller, agents } = build();
    agents.localAccountIds.mockResolvedValue(new Map());
    const [identity] = await controller.list();
    expect(identity.fluiUserId).toBeNull();
  });

  it('revokes by the name it was minted under', async () => {
    const { controller, stub } = build();
    expect(await controller.revoke('release-bot')).toEqual({ revoked: true });
    expect(stub.revoked).toBe('release-bot');
  });
});
