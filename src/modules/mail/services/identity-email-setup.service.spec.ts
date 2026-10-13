jest.mock('./mail-provider.resolver', () => ({
  MailProviderResolver: class MailProviderResolver {},
}));
jest.mock('./mail-readiness.service', () => ({
  MailReadinessService: class MailReadinessService {},
}));
jest.mock('./identity-email-dedupe.service', () => ({
  IdentityEmailDedupeService: class IdentityEmailDedupeService {},
}));
jest.mock('../../access/services/key-storage.service', () => ({
  KeyStorageService: class KeyStorageService {},
}));

import { Logger } from '@nestjs/common';
import {
  IDENTITY_EMAIL_DESCRIPTION,
  IdentityEmailSetupService,
  identityEmailEndpoint,
} from './identity-email-setup.service';
import type { IdentityEmailProvider } from './identity-provider-email.client';
import type { IdentityEmailProviderEntity } from '../entities/identity-email-provider.entity';

const IN_CLUSTER =
  'http://flui-api.flui-system.svc.cluster.local:3000/api/v1/identity/email';

function lockingDataSource() {
  return {
    createQueryRunner: () => ({
      connect: async () => undefined,
      release: async () => undefined,
      query: async (sql: string) =>
        sql.includes('pg_try_advisory_lock') ? [{ held: true }] : [],
    }),
  };
}

function fakeZitadel() {
  const providers: IdentityEmailProvider[] = [];
  let next = 1;
  const client = {
    list: jest.fn(async () => providers.map((p) => ({ ...p }))),
    addHttp: jest.fn(
      async (_c: unknown, endpoint: string, description: string) => {
        const id = `p${next++}`;
        const signingKey = `key-${id}`;
        providers.push({
          id,
          description,
          state: 'EMAIL_PROVIDER_INACTIVE',
          http: { endpoint, signingKey },
        });
        return { id, signingKey };
      },
    ),
    updateHttp: jest.fn(
      async (
        _c: unknown,
        id: string,
        endpoint: string,
        _d: string,
        rotate: boolean,
      ) => {
        const p = providers.find((x) => x.id === id)!;
        p.http = {
          endpoint,
          signingKey: rotate ? `rotated-${id}` : p.http!.signingKey,
        };
        return { signingKey: rotate ? `rotated-${id}` : null };
      },
    ),
    activate: jest.fn(async (_c: unknown, id: string) => {
      for (const p of providers) {
        p.state =
          p.id === id ? 'EMAIL_PROVIDER_ACTIVE' : 'EMAIL_PROVIDER_INACTIVE';
      }
    }),
  };
  return { client, providers };
}

function build(
  options: {
    sending?: boolean;
    ready?: boolean;
    mailFrom?: string;
    sendingDomain?: string | null;
  } = {},
) {
  let row: IdentityEmailProviderEntity | null = null;
  const repo = {
    findOne: jest.fn(async () => (row ? { ...row } : null)),
    upsert: jest.fn(async (fields: Partial<IdentityEmailProviderEntity>) => {
      row = { ...(row ?? {}), ...fields } as IdentityEmailProviderEntity;
    }),
  };
  const zitadel = fakeZitadel();
  const providers = {
    connectionFor: jest.fn(async () => {
      if (options.sending === false) throw new Error('none');
      return {
        connection: {
          provider: 'scaleway-tem',
          sendingDomain:
            options.sendingDomain === undefined
              ? 'mail.example.com'
              : options.sendingDomain,
        },
      };
    }),
  };
  const readiness = {
    current: jest.fn(async () => ({ ready: options.ready ?? true })),
  };
  const keys = {
    encryptKeyToString: (v: string) => `sealed:${v}`,
    decryptKeyFromString: (v: string) => v.replace(/^sealed:/, ''),
  };
  const config = {
    get: (name: string) =>
      name === 'MAIL_FROM' ? options.mailFrom : undefined,
  };
  const service = new IdentityEmailSetupService(
    repo as never,
    zitadel.client as never,
    providers as never,
    readiness as never,
    keys as never,
    config as never,
    lockingDataSource() as never,
    { purge: jest.fn().mockResolvedValue(undefined) } as never,
  );
  return { service, zitadel, repo, row: () => row };
}

describe('keeping the identity provider pointed at Flui for its mail', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.ZITADEL_SERVICE_ACCOUNT_PAT = 'pat';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';
    delete process.env.IDENTITY_EMAIL_ENDPOINT;
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = { ...saved };
    jest.restoreAllMocks();
  });

  it('creates, seals the key, and activates on the first run', async () => {
    const { service, zitadel, row } = build();
    const status = await service.sync();

    expect(zitadel.client.addHttp).toHaveBeenCalledWith(
      expect.anything(),
      IN_CLUSTER,
      IDENTITY_EMAIL_DESCRIPTION,
    );
    expect(zitadel.client.activate).toHaveBeenCalledTimes(1);
    expect(row()!.encryptedSigningKey).toBe('sealed:key-p1');
    expect(status).toMatchObject({
      state: 'active',
      reason: null,
      providerId: 'p1',
      active: true,
      endpoint: IN_CLUSTER,
      mailProvider: 'scaleway-tem',
    });
    await expect(service.signingKey()).resolves.toBe('key-p1');
  });

  it('changes nothing on a second run', async () => {
    const { service, zitadel } = build();
    await service.sync();
    await service.sync();

    expect(zitadel.client.addHttp).toHaveBeenCalledTimes(1);
    expect(zitadel.client.updateHttp).not.toHaveBeenCalled();
    expect(zitadel.client.activate).toHaveBeenCalledTimes(1);
  });

  it('moves the endpoint when it changed', async () => {
    const { service, zitadel } = build();
    await service.sync();
    process.env.IDENTITY_EMAIL_ENDPOINT =
      'https://api.example.com/api/v1/identity/email';
    await service.sync();

    expect(zitadel.client.updateHttp).toHaveBeenCalledWith(
      expect.anything(),
      'p1',
      'https://api.example.com/api/v1/identity/email',
      IDENTITY_EMAIL_DESCRIPTION,
      false,
    );
    expect(zitadel.providers).toHaveLength(1);
  });

  it('finds its own provider again when the row is lost, and takes the key the identity provider reports', async () => {
    const first = build();
    await first.service.sync();
    const second = build();
    second.zitadel.providers.push(...first.zitadel.providers);
    await second.service.sync();

    expect(second.zitadel.client.addHttp).not.toHaveBeenCalled();
    await expect(second.service.signingKey()).resolves.toBe('key-p1');
  });

  it('rotates the key when neither side holds it', async () => {
    const { service, zitadel } = build();
    zitadel.providers.push({
      id: 'p9',
      description: IDENTITY_EMAIL_DESCRIPTION,
      state: 'EMAIL_PROVIDER_ACTIVE',
      http: { endpoint: IN_CLUSTER, signingKey: null },
    });
    await service.sync();

    expect(zitadel.client.updateHttp).toHaveBeenCalledWith(
      expect.anything(),
      'p9',
      IN_CLUSTER,
      IDENTITY_EMAIL_DESCRIPTION,
      true,
    );
    await expect(service.signingKey()).resolves.toBe('rotated-p9');
    expect(zitadel.client.activate).not.toHaveBeenCalled();
  });

  it('leaves the identity provider as it is without a transactional connection', async () => {
    const { service, zitadel } = build({ sending: false });
    const status = await service.sync();

    expect(zitadel.client.list).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      state: 'not_configured',
      reason: 'no_transactional_connection',
      mailProvider: null,
    });
  });

  it('leaves it as it is while the sender is not ready', async () => {
    const { service, zitadel } = build({ ready: false });
    const status = await service.sync();
    expect(zitadel.client.list).not.toHaveBeenCalled();
    expect(status.reason).toBe('sender_not_ready');
  });

  it('leaves it as it is when there is no sender address', async () => {
    const { service, zitadel } = build({ sendingDomain: null });
    const status = await service.sync();
    expect(zitadel.client.list).not.toHaveBeenCalled();
    expect(status.reason).toBe('no_sender');
  });

  it('prefers MAIL_FROM over the connection domain', async () => {
    const { service } = build({ mailFrom: 'hello@example.org' });
    await expect(service.sender()).resolves.toMatchObject({
      email: 'hello@example.org',
    });
  });

  it('records a failed sync instead of throwing', async () => {
    const { service, zitadel } = build();
    zitadel.client.list.mockRejectedValueOnce(new Error('403 Forbidden'));
    await expect(service.ensureQuietly()).resolves.toBeUndefined();
    const status = await service.status();
    expect(status).toMatchObject({
      state: 'error',
      reason: 'sync_failed',
      lastSyncError: '403 Forbidden',
    });
  });

  it('never repoints the identity provider from outside the cluster', async () => {
    delete process.env.KUBERNETES_SERVICE_HOST;
    const { service, zitadel } = build();
    const status = await service.sync();
    expect(zitadel.client.list).not.toHaveBeenCalled();
    expect(status.reason).toBe('endpoint_unknown');
  });

  it('says so when the identity provider cannot be reached', async () => {
    delete process.env.ZITADEL_SERVICE_ACCOUNT_PAT;
    const { service, zitadel } = build();
    const status = await service.sync();
    expect(zitadel.client.list).not.toHaveBeenCalled();
    expect(status.reason).toBe('identity_provider_unreachable');
  });
});

describe('where the identity provider posts its mail', () => {
  it('uses the in-cluster address inside the cluster', () => {
    expect(identityEmailEndpoint({ KUBERNETES_SERVICE_HOST: 'x' })).toBe(
      IN_CLUSTER,
    );
  });

  it('honours an explicit override, and has none from a workstation', () => {
    expect(
      identityEmailEndpoint({ IDENTITY_EMAIL_ENDPOINT: 'https://a/b' }),
    ).toBe('https://a/b');
    expect(identityEmailEndpoint({})).toBeNull();
  });
});
