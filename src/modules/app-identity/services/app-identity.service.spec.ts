jest.mock('@kubernetes/client-node', () => ({}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import { AppIdentityService } from './app-identity.service';
import { IdentityPoolResolver } from './identity-pool.resolver';
import { IdentityPool } from '../zitadel/identity-pool';

const USER = { userId: 'u1', email: 'u1@example.com' } as never;

function build(options: { serverKey?: string | null; denied?: boolean } = {}) {
  const pool = {
    issuer: '',
    ensureProject: jest.fn(async () => 'p1'),
    createClient: jest.fn(async () => ({
      appId: 'a1',
      clientId: 'client-1',
      clientSecret: 'shh',
    })),
    deleteClient: jest.fn(async () => undefined),
    listUsers: jest.fn(async () => []),
    inviteUser: jest.fn(async () => ({ id: 'new-user' })),
    blockUser: jest.fn(async () => undefined),
    unblockUser: jest.fn(async () => undefined),
    exportUsers: jest.fn(async () => ({ orgs: [] })),
  } satisfies IdentityPool;
  const made: Array<{ issuer: string; key: string }> = [];
  const server = {
    id: 'srv',
    slug: 'idp-zitadel',
    metadata: { composedComponent: 'zitadel' },
    env:
      options.serverKey === null
        ? []
        : [
            {
              name: 'FLUI_SYSTEM_KEY',
              value: `enc:${options.serverKey ?? 'KEY'}`,
              secret: true,
            },
          ],
  };
  const app = {
    id: 'app1',
    slug: 'shop',
    imageRef: 'img:1',
    env: [{ name: 'KEEP', value: 'x' }],
  };
  const stored: Record<string, unknown> = {};
  const links = {
    findOne: jest.fn(async () => stored.link ?? null),
    create: (v: object) => v,
    save: jest.fn(async (v: object) => {
      stored.link = v;
      return v;
    }),
    delete: jest.fn(async () => {
      delete stored.link;
    }),
  };
  const applications = {
    findById: jest.fn(async (id: string) => (id === 'app1' ? app : null)),
    findByCatalogInstall: jest.fn(async () => [server]),
    update: jest.fn(async () => undefined),
  };
  const endpoints = {
    listByApplicationId: jest.fn(async (id: string) => [
      { fqdn: id === 'srv' ? 'id.example.com' : 'shop.example.com' },
    ]),
  };
  const access = {
    assertCan: jest.fn(async () => {
      if (options.denied) throw new Error('forbidden');
    }),
  };
  const deploy = { deploy: jest.fn(async () => undefined) };
  const encryption = {
    decrypt: (v: string) => v.replace(/^enc:/, ''),
    encrypt: (v: string) => `enc:${v}`,
  };
  const resolver = new IdentityPoolResolver(
    applications as never,
    endpoints as never,
    encryption as never,
    (issuer: string, key: string) => {
      made.push({ issuer, key });
      return pool;
    },
  );
  const service = new AppIdentityService(
    links as never,
    applications as never,
    endpoints as never,
    encryption as never,
    access as never,
    deploy as never,
    {
      createQueryBuilder: () => {
        const qb = {
          where: () => qb,
          andWhere: () => qb,
          getMany: async () => [
            {
              ...server,
              name: 'Company login',
              metadata: { ...server.metadata, catalogInstallId: 'inst-1' },
            },
            {
              id: 'old',
              slug: 'old-zitadel',
              name: 'Old',
              metadata: {
                composedComponent: 'zitadel',
                catalogInstallId: 'inst-2',
              },
              env: [],
            },
          ],
        };
        return qb;
      },
    } as never,
    resolver,
  );
  return { service, pool, made, applications, deploy, links, access };
}

describe('sign-in for the users of a customer’s apps', () => {
  it('lists the identity installs the caller can read, and which Flui can manage', async () => {
    const { service, access } = build();
    (access as { filterReadable?: jest.Mock }).filterReadable = jest.fn(
      async (_u: unknown, apps: unknown[]) => apps,
    );
    await expect(service.installs(USER)).resolves.toEqual([
      {
        identityInstallId: 'inst-1',
        applicationId: 'srv',
        name: 'Company login',
        issuer: 'https://id.example.com',
        managed: true,
      },
      {
        identityInstallId: 'inst-2',
        applicationId: 'old',
        name: 'Old',
        issuer: 'https://shop.example.com',
        managed: false,
      },
    ]);
  });

  it('manages an identity install with the key only that install holds, at its own address', async () => {
    const { service, made } = build({ serverKey: 'PRIVATE' });
    await service.users(USER, 'inst-1');
    expect(made).toEqual([
      { issuer: 'https://id.example.com', key: 'PRIVATE' },
    ]);
  });

  it('exports users only for someone who may change the install', async () => {
    const { service, access } = build();
    await expect(service.exportUsers(USER, 'inst-1')).resolves.toEqual({
      orgs: [],
    });
    expect(access.assertCan).toHaveBeenCalledWith(
      USER,
      'app:write',
      expect.anything(),
    );
  });

  it('refuses an install that predates the management key', async () => {
    const { service } = build({ serverKey: null });
    await expect(service.users(USER, 'inst-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses an install that is not an identity install', async () => {
    const { service, applications } = build();
    applications.findByCatalogInstall.mockResolvedValueOnce([]);
    await expect(service.users(USER, 'x')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('asks the caller’s permission on the identity install before touching it', async () => {
    const { service, made } = build({ denied: true });
    await expect(
      service.invite(USER, 'inst-1', {
        email: 'a@example.com',
        givenName: 'A',
        familyName: 'B',
      }),
    ).rejects.toThrow('forbidden');
    expect(made).toHaveLength(0);
  });

  it('hands the application only the issuer, client id and an encrypted secret, then redeploys it', async () => {
    const { service, pool, applications, deploy } = build();
    const link = await service.connect(USER, 'app1', {
      identityInstallId: 'inst-1',
      redirectPaths: ['/auth/callback'],
    });
    expect(pool.createClient).toHaveBeenCalledWith('p1', {
      name: 'shop',
      redirectUris: ['https://shop.example.com/auth/callback'],
      postLogoutRedirectUris: ['https://shop.example.com/'],
    });
    const env = (applications.update.mock.calls[0] as unknown[])[1] as {
      env: Array<{
        name: string;
        value: string;
        secret?: boolean;
        source?: string;
      }>;
    };
    expect(env.env).toEqual([
      { name: 'KEEP', value: 'x' },
      { name: 'OIDC_ISSUER', value: 'https://id.example.com', source: 'link' },
      { name: 'OIDC_CLIENT_ID', value: 'client-1', source: 'link' },
      {
        name: 'OIDC_CLIENT_SECRET',
        value: 'enc:shh',
        secret: true,
        source: 'link',
      },
    ]);
    expect(deploy.deploy).toHaveBeenCalledWith(
      'app1',
      { useCurrentImage: true },
      'u1',
    );
    expect(link.clientId).toBe('client-1');
    expect(JSON.stringify(link)).not.toContain('shh');
  });

  it('takes the variable names the application reads', async () => {
    const { service, applications } = build();
    await service.connect(USER, 'app1', {
      identityInstallId: 'inst-1',
      redirectPaths: ['/cb'],
      envNames: { clientSecret: 'AUTH_SECRET' },
    });
    const { env } = (applications.update.mock.calls[0] as unknown[])[1] as {
      env: Array<{ name: string }>;
    };
    expect(env.map((e) => e.name)).toContain('AUTH_SECRET');
  });

  it('deletes the client it made when the application cannot be updated', async () => {
    const { service, pool, applications } = build();
    applications.update.mockRejectedValueOnce(new Error('db down'));
    await expect(
      service.connect(USER, 'app1', {
        identityInstallId: 'inst-1',
        redirectPaths: ['/cb'],
      }),
    ).rejects.toThrow('db down');
    expect(pool.deleteClient).toHaveBeenCalledWith('p1', 'a1');
  });

  it('refuses a second identity on the same application', async () => {
    const { service } = build();
    await service.connect(USER, 'app1', {
      identityInstallId: 'inst-1',
      redirectPaths: ['/cb'],
    });
    await expect(
      service.connect(USER, 'app1', {
        identityInstallId: 'inst-1',
        redirectPaths: ['/cb'],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('removes the client and the three variables on disconnect', async () => {
    const { service, pool, applications } = build();
    await service.connect(USER, 'app1', {
      identityInstallId: 'inst-1',
      redirectPaths: ['/cb'],
    });
    applications.update.mockClear();
    await service.disconnect(USER, 'app1');
    expect(pool.deleteClient).toHaveBeenCalledWith('p1', 'a1');
    const { env } = (applications.update.mock.calls[0] as unknown[])[1] as {
      env: Array<{ name: string }>;
    };
    expect(env.map((e) => e.name)).toEqual(['KEEP']);
  });
});
