import { BadRequestException } from '@nestjs/common';
import { AgentIdentityService } from './agent-identity.service';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { IamPrincipal } from '../../iam/interfaces/iam.types';
import { IdentityRole } from '../entities/user.entity';
import { ASSIGNABLE_ROLE_KEYS } from '../../iam/constants/iam-roles';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

/**
 * An agent's own identity in the provider.
 *
 * The two properties worth a test are not "it calls the API": they are that an
 * identity is never worth more than whoever asked for it, and that it carries a
 * ceiling and never a rung.
 */

const issuer = (overrides: Partial<IamPrincipal> = {}): IamPrincipal => ({
  userId: 'u-1',
  email: 'maintainer@acme.com',
  role: IdentityRole.USER,
  isAdmin: false,
  ...overrides,
});

interface Recorded {
  createdMachine?: { userName: string; name: string };
  grantedRoles?: string[];
  secretFor?: string;
}

function makeService(opts: { canAll?: boolean; machines?: string[] } = {}) {
  const recorded: Recorded = {};
  const provider = {
    findProjectByName: async () => ({ id: 'p-1', name: 'Flui' }),
    listMachineUsers: async () =>
      (opts.machines ?? []).map((userName, i) => ({
        id: `m-${i}`,
        userName,
      })),
    createMachineUser: async (
      _pat: string,
      _host: string,
      params: { userName: string; name: string },
    ) => {
      recorded.createdMachine = params;
      return { id: 'm-new', userName: params.userName, name: params.name };
    },
    grantUserRole: async (
      _pat: string,
      _host: string,
      _userId: string,
      _projectId: string,
      roleKeys: string[],
    ) => {
      recorded.grantedRoles = roleKeys;
    },
    generateMachineSecret: async (
      _pat: string,
      _host: string,
      userId: string,
    ) => {
      recorded.secretFor = userId;
      return { clientId: 'cid', clientSecret: 'csecret' };
    },
    deleteUser: async () => undefined,
  };
  const bootstrap = {
    resolveProviderContext: async () => ({
      cluster: {},
      kubeconfig: 'k',
      pat: 'p',
      providerDomain: 'auth.example',
      issuer: 'https://auth.example',
    }),
    reconcileProjectRoles: async () => ({ created: 0 }),
  };
  const policy = {
    resolveAccess: async () => ({}),
    can: () => opts.canAll ?? true,
  };
  const service = new AgentIdentityService(
    provider as never,
    bootstrap as never,
    policy as never,
    { find: async () => [] } as never,
  );
  return { service, recorded };
}

describe('AgentIdentityService', () => {
  describe('an identity is never worth more than whoever asked for it', () => {
    it('refuses a scope the issuer’s own credential does not carry', async () => {
      const { service } = makeService();
      await expect(
        service.provision(
          issuer({ scopes: [MCP_SCOPE.APP_READ] }),
          'deploy-bot',
          [MCP_SCOPE.APP_DESTRUCTIVE],
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses the whole request rather than trimming it', async () => {
      const { service, recorded } = makeService();
      await expect(
        service.provision(issuer({ scopes: [MCP_SCOPE.APP_READ] }), 'bot', [
          MCP_SCOPE.APP_READ,
          MCP_SCOPE.APP_WRITE,
        ]),
      ).rejects.toThrow(/does not carry/);
      expect(recorded.createdMachine).toBeUndefined();
    });

    it('leaves an uncapped issuer uncapped', async () => {
      const { service, recorded } = makeService();
      await service.provision(issuer(), 'bot', [MCP_SCOPE.APP_DESTRUCTIVE]);
      expect(recorded.grantedRoles).toEqual([MCP_SCOPE.APP_DESTRUCTIVE]);
    });

    it('names the permission half separately, without minting anything', async () => {
      const { service, recorded } = makeService({ canAll: false });
      const beyond = await service.beyondPermissions(issuer(), [
        MCP_SCOPE.APP_WRITE,
        MCP_SCOPE.CATALOG_READ,
      ]);
      expect(beyond).toEqual([MCP_SCOPE.APP_WRITE, MCP_SCOPE.CATALOG_READ]);
      expect(recorded.createdMachine).toBeUndefined();
      // …and the same call against an issuer who holds everything is empty.
      const open = makeService({ canAll: true });
      expect(
        await open.service.beyondPermissions(issuer(), [MCP_SCOPE.APP_WRITE]),
      ).toEqual([]);
    });

    it('refuses a name that means nothing to this installation', async () => {
      const { service } = makeService();
      await expect(
        service.provision(issuer(), 'bot', ['mcp:not:a:scope']),
      ).rejects.toThrow(/Not scopes of this installation/);
      await expect(service.provision(issuer(), 'bot', [])).rejects.toThrow(
        /must name the scopes/,
      );
    });
  });

  describe('the identity carries a ceiling, never a rung', () => {
    /**
     * The disjointness of decision 101, on the writing side: an agent gets
     * `mcp:*` roles and nothing from the ladder. A rung would be standing of its
     * own, and an agent acts for a person.
     */
    it('grants only mcp:* roles', async () => {
      const { service, recorded } = makeService();
      await service.provision(issuer(), 'deploy bot', [
        MCP_SCOPE.APP_WRITE,
        MCP_SCOPE.APP_READ,
      ]);
      for (const role of recorded.grantedRoles ?? []) {
        expect(role.startsWith('mcp:')).toBe(true);
        expect(ASSIGNABLE_ROLE_KEYS).not.toContain(role);
      }
    });

    it('refuses a rung asked for as if it were a scope', async () => {
      const { service } = makeService();
      for (const rung of ASSIGNABLE_ROLE_KEYS) {
        await expect(
          service.provision(issuer(), 'bot', [rung]),
        ).rejects.toThrow(/Not scopes of this installation/);
      }
      await expect(
        service.provision(issuer(), 'bot', [IAM_PERMISSION.IAM_MANAGE_USERS]),
      ).rejects.toThrow(/Not scopes of this installation/);
    });
  });

  describe('naming and rotation', () => {
    it('mints under a prefix that says whose it is', async () => {
      const { service, recorded } = makeService();
      const out = await service.provision(issuer(), 'Deploy Bot!', [
        MCP_SCOPE.APP_READ,
      ]);
      expect(recorded.createdMachine?.userName).toBe('flui-agent-deploy-bot');
      expect(out.userName).toBe('flui-agent-deploy-bot');
      expect(out.clientSecret).toBe('csecret');
    });

    it('rotates rather than duplicating when the name already exists', async () => {
      const { service, recorded } = makeService({
        machines: ['flui-agent-deploy-bot'],
      });
      await service.provision(issuer(), 'deploy-bot', [MCP_SCOPE.APP_READ]);
      expect(recorded.createdMachine).toBeUndefined();
      expect(recorded.secretFor).toBe('m-0');
    });

    it('lists only what Flui minted', async () => {
      const { service } = makeService({
        machines: ['flui-agent-a', 'some-other-service-account'],
      });
      expect((await service.list()).map((u) => u.userName)).toEqual([
        'flui-agent-a',
      ]);
    });

    it('revokes by name, and says so when there is nothing to revoke', async () => {
      const present = makeService({ machines: ['flui-agent-a'] });
      expect(await present.service.revoke('a')).toBe(true);
      const absent = makeService({ machines: [] });
      expect(await absent.service.revoke('a')).toBe(false);
    });
  });

  describe('no provider, no identity', () => {
    it('refuses rather than pretending, when there is no IdP to mint in', async () => {
      const provider = {} as never;
      const bootstrap = {
        resolveProviderContext: async () => null,
        reconcileProjectRoles: async () => null,
      } as never;
      const service = new AgentIdentityService(
        provider,
        bootstrap,
        {
          resolveAccess: async () => ({}),
          can: () => true,
        } as never,
        { find: async () => [] } as never,
      );
      await expect(
        service.provision(issuer(), 'bot', [MCP_SCOPE.APP_READ]),
      ).rejects.toThrow(/identity provider/);
      expect(await service.list()).toEqual([]);
      expect(await service.revoke('bot')).toBe(false);
    });
  });
});
