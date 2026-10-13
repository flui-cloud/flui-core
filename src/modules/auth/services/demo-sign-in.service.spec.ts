import {
  BadGatewayException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DemoSignInService } from './demo-sign-in.service';

const fakeProvider = (policy: {
  isDefault: boolean;
  allowRegister: boolean;
  allowExternalIdp: boolean;
  idpIds: string[];
}) => {
  const idps: Array<{ id: string; name: string; type: string }> = [];
  const metadata = new Map<string, string>();
  const calls: string[] = [];
  const sent: Array<Record<string, unknown>> = [];
  let next = 0;
  return {
    calls,
    sent,
    metadata,
    idps,
    client: {
      getLoginPolicy: async () => ({
        ...policy,
        idpIds: [...policy.idpIds],
        settings: {},
      }),
      openSelfRegistration: async (
        _p: string,
        _h: string,
        current: { isDefault: boolean },
      ) => {
        calls.push(current.isDefault ? 'create-policy' : 'update-policy');
        policy.isDefault = false;
        policy.allowRegister = true;
        policy.allowExternalIdp = true;
      },
      listIdentityProviders: async () => [...idps],
      addSocialIdentityProvider: async (
        _p: string,
        _h: string,
        kind: string,
        params: Record<string, unknown>,
      ) => {
        next += 1;
        const id = next === 1 ? `${kind}-id` : `${kind}-id-${next}`;
        idps.push({ id, name: params.name as string, type: kind });
        calls.push(`add-${kind}`);
        sent.push({ op: 'add', kind, ...params });
        return id;
      },
      updateSocialIdentityProvider: async (
        _p: string,
        _h: string,
        kind: string,
        id: string,
        params: Record<string, unknown>,
      ) => {
        calls.push(`update-${id}`);
        sent.push({ op: 'update', kind, id, ...params });
      },
      addIdentityProviderToLogin: async (
        _p: string,
        _h: string,
        id: string,
      ) => {
        policy.idpIds.push(id);
        calls.push(`link-${id}`);
      },
      removeIdentityProviderFromLogin: async (
        _p: string,
        _h: string,
        id: string,
      ) => {
        policy.idpIds = policy.idpIds.filter((i) => i !== id);
        calls.push(`unlink-${id}`);
      },
      deleteIdentityProvider: async (_p: string, _h: string, id: string) => {
        const at = idps.findIndex((p) => p.id === id);
        if (at >= 0) idps.splice(at, 1);
        calls.push(`delete-${id}`);
      },
      findOrgMetadata: async (_p: string, _h: string, key: string) =>
        metadata.get(key) ?? null,
      setOrgMetadata: async (
        _p: string,
        _h: string,
        key: string,
        value: string,
      ) => {
        metadata.set(key, value);
      },
    },
  };
};

/** Postgres advisory locks as a queue: a second holder waits for the first to let go. */
const lockSource = () => {
  let chain = Promise.resolve();
  const events: string[] = [];
  return {
    events,
    createQueryRunner: () => {
      let letGo: () => void = () => undefined;
      return {
        connect: async () => undefined,
        release: async () => undefined,
        query: async (sql: string) => {
          if (sql.includes('pg_advisory_unlock')) {
            events.push('unlock');
            letGo();
          } else if (sql.includes('pg_advisory_lock')) {
            const held = chain;
            chain = new Promise<void>((resolve) => (letGo = resolve));
            await held;
            events.push('lock');
          }
          return [];
        },
      };
    },
  };
};

const ENV = {
  ZITADEL_SERVICE_ACCOUNT_PAT: 'pat',
  OIDC_ISSUER: 'https://auth.demo.flui.cloud',
};
const DEMO = { ...ENV, SANDBOX_ENABLED: 'true' };
const SECRET = 'gh-secret-value-0123456789';

const fresh = () =>
  fakeProvider({
    isDefault: true,
    allowRegister: false,
    allowExternalIdp: false,
    idpIds: [],
  });

describe('DemoSignInService', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  describe('on start', () => {
    it('opens self-registration on the instance default and adds the providers the old variables still name', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      const added = await service.apply({
        ...ENV,
        SANDBOX_GITHUB_CLIENT_ID: 'gh-id',
        SANDBOX_GITHUB_CLIENT_SECRET: 'gh-secret',
      });

      expect(added).toEqual(['GitHub']);
      expect(zitadel.calls).toEqual([
        'create-policy',
        'add-github',
        'link-github-id',
      ]);
    });

    it('tells the administrator to move the variables, without repeating the secret', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      await service.apply({
        ...ENV,
        SANDBOX_GITHUB_CLIENT_ID: 'gh-id',
        SANDBOX_GITHUB_CLIENT_SECRET: SECRET,
      });

      expect(logged.join('\n')).toContain(
        'flui sandbox sign-in connect github',
      );
      expect(logged.join('\n')).not.toContain(SECRET);
    });

    it('changes nothing the second time', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );
      const env = {
        ...ENV,
        SANDBOX_GOOGLE_CLIENT_ID: 'g-id',
        SANDBOX_GOOGLE_CLIENT_SECRET: 'g-secret',
      };

      await service.apply(env);
      zitadel.calls.length = 0;
      await service.apply(env);

      expect(zitadel.calls).toEqual([]);
    });

    it('opens email registration even with no external provider configured', async () => {
      const zitadel = fakeProvider({
        isDefault: false,
        allowRegister: false,
        allowExternalIdp: true,
        idpIds: [],
      });
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      expect(await service.apply(ENV)).toEqual([]);
      expect(zitadel.calls).toEqual(['update-policy']);
    });

    it('does nothing when the identity provider cannot be reached from here', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      expect(await service.apply({})).toEqual([]);
      expect(zitadel.calls).toEqual([]);
    });

    it('ignores the old variables once Flui manages the provider, and says so', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );
      await service.connect(
        'github',
        { clientId: 'new-id', clientSecret: SECRET },
        'admin@flui.cloud',
        DEMO,
      );
      zitadel.calls.length = 0;
      logged.length = 0;

      await service.apply({
        ...DEMO,
        SANDBOX_GITHUB_CLIENT_ID: 'old-id',
        SANDBOX_GITHUB_CLIENT_SECRET: 'old-secret',
      });

      expect(zitadel.calls).toEqual([]);
      expect(logged.join('\n')).toContain(
        'SANDBOX_GITHUB_CLIENT_ID and SANDBOX_GITHUB_CLIENT_SECRET are ignored',
      );
    });

    it('adds a provider once when several copies of the API start together', async () => {
      const zitadel = fresh();
      const locks = lockSource();
      const copies = [1, 2, 3].map(
        () => new DemoSignInService(zitadel.client as never, locks as never),
      );
      const env = {
        ...ENV,
        SANDBOX_GITHUB_CLIENT_ID: 'gh-id',
        SANDBOX_GITHUB_CLIENT_SECRET: 'gh-secret',
      };

      await Promise.all(copies.map((copy) => copy.apply(env)));

      expect(zitadel.idps).toHaveLength(1);
      expect(zitadel.calls.filter((c) => c === 'add-github')).toHaveLength(1);
      expect(locks.events).toEqual([
        'lock',
        'unlock',
        'lock',
        'unlock',
        'lock',
        'unlock',
      ]);
    });

    it('puts a connected provider back on the sign-in page when it fell off', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );
      await service.connect(
        'github',
        { clientId: 'id', clientSecret: SECRET },
        'admin',
        DEMO,
      );
      await zitadel.client.removeIdentityProviderFromLogin(
        'pat',
        'host',
        'github-id',
      );
      zitadel.calls.length = 0;

      await service.apply(DEMO);

      expect(zitadel.calls).toEqual(['link-github-id']);
    });
  });

  describe('connect', () => {
    it('hands the client id and secret to the identity provider as arguments, and shows the button', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      const status = await service.connect(
        'github',
        { clientId: ' Iv23li-client ', clientSecret: SECRET },
        'admin@flui.cloud',
        DEMO,
      );

      expect(zitadel.sent).toEqual([
        {
          op: 'add',
          kind: 'github',
          name: 'GitHub',
          clientId: 'Iv23li-client',
          clientSecret: SECRET,
        },
      ]);
      expect(zitadel.calls).toEqual([
        'create-policy',
        'add-github',
        'link-github-id',
      ]);
      expect(status).toMatchObject({
        provider: 'github',
        connected: true,
        source: 'flui',
        clientId: 'Iv23li-client',
        connectedBy: 'admin@flui.cloud',
        onSignInPage: true,
      });
    });

    it('keeps only non-secret facts, and never echoes or logs the secret', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      const status = await service.connect(
        'google',
        { clientId: 'g-client', clientSecret: SECRET },
        'admin@flui.cloud',
        DEMO,
      );

      const stored = zitadel.metadata.get('flui.sandbox.sign-in.google');
      expect(JSON.parse(stored as string)).toEqual({
        clientId: 'g-client',
        idpId: 'google-id',
        connectedAt: expect.any(String),
        connectedBy: 'admin@flui.cloud',
        disconnectedAt: null,
      });
      expect([...zitadel.metadata.values()].join()).not.toContain(SECRET);
      expect(JSON.stringify(status)).not.toContain(SECRET);
      expect(logged.join('\n')).not.toContain(SECRET);
    });

    it('rotates by updating the same provider, so the accounts made with it stay', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );
      await service.connect(
        'github',
        { clientId: 'id-1', clientSecret: 'first' },
        'a',
        DEMO,
      );
      zitadel.calls.length = 0;
      zitadel.sent.length = 0;

      const status = await service.connect(
        'github',
        { clientId: 'id-2', clientSecret: 'second' },
        'b',
        DEMO,
      );

      expect(zitadel.calls).toEqual(['update-github-id']);
      expect(zitadel.sent).toEqual([
        {
          op: 'update',
          kind: 'github',
          id: 'github-id',
          name: 'GitHub',
          clientId: 'id-2',
          clientSecret: 'second',
        },
      ]);
      expect(status).toMatchObject({ clientId: 'id-2', connectedBy: 'b' });
    });

    it('takes over a provider the old variables created instead of adding a second one', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );
      await service.apply({
        ...DEMO,
        SANDBOX_GITHUB_CLIENT_ID: 'env-id',
        SANDBOX_GITHUB_CLIENT_SECRET: 'env-secret',
      });
      zitadel.calls.length = 0;

      await service.connect(
        'github',
        { clientId: 'new-id', clientSecret: SECRET },
        'admin',
        DEMO,
      );

      expect(zitadel.calls).toEqual(['update-github-id']);
      expect(zitadel.idps).toHaveLength(1);
    });

    it('lets one connect finish before the next starts, so two at once leave one provider', async () => {
      const zitadel = fresh();
      const locks = lockSource();
      const service = new DemoSignInService(
        zitadel.client as never,
        locks as never,
      );

      await Promise.all([
        service.connect(
          'github',
          { clientId: 'a', clientSecret: SECRET },
          'a',
          DEMO,
        ),
        service.connect(
          'github',
          { clientId: 'b', clientSecret: SECRET },
          'b',
          DEMO,
        ),
      ]);

      expect(zitadel.idps).toHaveLength(1);
      expect(zitadel.calls.filter((c) => c.startsWith('add-'))).toEqual([
        'add-github',
      ]);
      expect(locks.events).toEqual(['lock', 'unlock', 'lock', 'unlock']);
    });

    it('takes over a provider left on the identity provider after the old variables were removed', async () => {
      const zitadel = fresh();
      zitadel.idps.push({ id: 'legacy-gh', name: 'GitHub', type: 'github' });
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      const status = await service.connect(
        'github',
        { clientId: 'new-id', clientSecret: SECRET },
        'admin',
        DEMO,
      );

      expect(zitadel.calls).toEqual([
        'create-policy',
        'update-legacy-gh',
        'link-legacy-gh',
      ]);
      expect(zitadel.idps).toHaveLength(1);
      expect(status).toMatchObject({ connected: true, source: 'flui' });
    });

    it('refuses outside a demo, where it would open registration on the control plane', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      await expect(
        service.connect(
          'github',
          { clientId: 'id', clientSecret: SECRET },
          'admin',
          ENV,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(zitadel.calls).toEqual([]);
    });

    it('says the identity provider is unreachable when there is no service account', async () => {
      const service = new DemoSignInService(
        fresh().client as never,
        lockSource() as never,
      );

      await expect(
        service.connect(
          'github',
          { clientId: 'id', clientSecret: SECRET },
          'admin',
          { SANDBOX_ENABLED: 'true' },
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("reports the identity provider's answer, never the request that carried the secret", async () => {
      const zitadel = fresh();
      const refusal = Object.assign(new Error('Request failed'), {
        isAxiosError: true,
        config: { data: JSON.stringify({ clientSecret: SECRET }) },
        response: { status: 400, data: { message: 'Errors.IDP.Invalid' } },
      });
      zitadel.client.addSocialIdentityProvider = async () => {
        throw refusal;
      };
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      const failure = await service
        .connect(
          'github',
          { clientId: 'id', clientSecret: SECRET },
          'admin',
          DEMO,
        )
        .catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(BadGatewayException);
      expect((failure as Error).message).toContain('Errors.IDP.Invalid');
      expect(JSON.stringify(failure)).not.toContain(SECRET);
      expect(zitadel.metadata.size).toBe(0);
    });
  });

  describe('disconnect', () => {
    it('takes it off the sign-in page, deletes it and remembers that, so the old variables cannot bring it back', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );
      await service.connect(
        'github',
        { clientId: 'id', clientSecret: SECRET },
        'admin',
        DEMO,
      );
      zitadel.calls.length = 0;

      const status = await service.disconnect('github', 'admin', DEMO);

      expect(zitadel.calls).toEqual(['unlink-github-id', 'delete-github-id']);
      expect(status).toMatchObject({
        connected: false,
        source: null,
        clientId: null,
        onSignInPage: false,
        disconnectedAt: expect.any(String),
      });

      zitadel.calls.length = 0;
      await service.apply({
        ...DEMO,
        SANDBOX_GITHUB_CLIENT_ID: 'env-id',
        SANDBOX_GITHUB_CLIENT_SECRET: 'env-secret',
      });
      expect(zitadel.calls).toEqual([]);
    });

    it('removes one the old variables created, too', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );
      await service.apply({
        ...DEMO,
        SANDBOX_GOOGLE_CLIENT_ID: 'env-id',
        SANDBOX_GOOGLE_CLIENT_SECRET: 'env-secret',
      });
      zitadel.calls.length = 0;

      await service.disconnect('google', 'admin', DEMO);

      expect(zitadel.calls).toEqual(['unlink-google-id', 'delete-google-id']);
    });

    it('removes one left on the identity provider after the old variables were removed', async () => {
      const zitadel = fakeProvider({
        isDefault: false,
        allowRegister: true,
        allowExternalIdp: true,
        idpIds: ['legacy-gh'],
      });
      zitadel.idps.push({ id: 'legacy-gh', name: 'GitHub', type: 'github' });
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      await service.disconnect('github', 'admin', DEMO);

      expect(zitadel.calls).toEqual(['unlink-legacy-gh', 'delete-legacy-gh']);
      expect(zitadel.idps).toEqual([]);
    });
  });

  describe('list', () => {
    it('reports each provider without its secret, and the callback URL to register', async () => {
      const zitadel = fresh();
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );
      const env = {
        ...DEMO,
        SANDBOX_GOOGLE_CLIENT_ID: 'env-google',
        SANDBOX_GOOGLE_CLIENT_SECRET: 'env-secret',
      };
      await service.apply(env);
      await service.connect(
        'github',
        { clientId: 'gh', clientSecret: SECRET },
        'admin@flui.cloud',
        env,
      );

      const view = await service.list(env);

      expect(view.demo).toBe(true);
      expect(view.callbackUrl).toBe(
        'https://auth.demo.flui.cloud/ui/login/login/externalidp/callback',
      );
      expect(view.providers).toEqual([
        expect.objectContaining({
          provider: 'github',
          connected: true,
          source: 'flui',
          clientId: 'gh',
          connectedBy: 'admin@flui.cloud',
          onSignInPage: true,
        }),
        expect.objectContaining({
          provider: 'google',
          connected: true,
          source: 'environment',
          clientId: 'env-google',
          onSignInPage: true,
        }),
      ]);
      expect(JSON.stringify(view)).not.toContain(SECRET);
      expect(JSON.stringify(view)).not.toContain('env-secret');
    });

    it('reports a provider the identity provider still holds after the old variables were removed, so it can be managed', async () => {
      const zitadel = fakeProvider({
        isDefault: false,
        allowRegister: true,
        allowExternalIdp: true,
        idpIds: ['legacy-gh'],
      });
      zitadel.idps.push(
        { id: 'legacy-gh', name: 'GitHub', type: 'github' },
        { id: 'legacy-g', name: 'Google', type: 'google' },
      );
      const service = new DemoSignInService(
        zitadel.client as never,
        lockSource() as never,
      );

      const view = await service.list(DEMO);

      expect(view.providers).toEqual([
        expect.objectContaining({
          provider: 'github',
          connected: true,
          source: 'identity-provider',
          clientId: null,
          onSignInPage: true,
        }),
        expect.objectContaining({
          provider: 'google',
          connected: true,
          source: 'identity-provider',
          onSignInPage: false,
        }),
      ]);
    });

    it('answers without the identity provider when it cannot reach it', async () => {
      const service = new DemoSignInService(
        fresh().client as never,
        lockSource() as never,
      );

      const view = await service.list({ SANDBOX_ENABLED: 'true' });

      expect(view.callbackUrl).toBeNull();
      expect(view.providers.map((p) => p.connected)).toEqual([false, false]);
    });
  });
});
