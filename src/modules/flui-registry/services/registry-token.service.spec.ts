jest.mock('@kubernetes/client-node', () => ({}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  FluiRegistryConfig,
  registryRepositoryFor,
} from '../flui-registry.config';
import { RegistryCredentialsService } from './registry-credentials.service';
import { RegistrySigningKeyService } from './registry-signing-key.service';
import { RegistryTokenService } from './registry-token.service';

type Row = Record<string, unknown>;

/** Just enough of a TypeORM repository: equality and `IsNull()` in `where`. */
function table() {
  const rows: Row[] = [];
  const matches = (row: Row, where: Row) =>
    Object.entries(where).every(([key, value]) =>
      value && typeof value === 'object' && '_type' in value
        ? row[key] === null || row[key] === undefined
        : row[key] === value,
    );
  return {
    rows,
    create: (data: Row) => ({ ...data }),
    save: async (row: Row) => {
      const saved = { id: row.id ?? `${crypto.randomUUID()}`, ...row };
      rows.push(saved);
      return saved;
    },
    findOne: async ({ where }: { where: Row }) =>
      rows.find((row) => matches(row, where)) ?? null,
    update: async (where: Row, patch: Row) => {
      for (const row of rows.filter((r) => matches(r, where))) {
        Object.assign(row, patch);
      }
    },
  };
}

const APP_A = '11111111-1111-4111-8111-111111111111';
const APP_B = '22222222-2222-4222-8222-222222222222';

function harness(overrides: Partial<FluiRegistryConfig> = {}) {
  const config: FluiRegistryConfig = {
    mode: 'flui',
    host: 'api.example.com',
    internalUrl: null,
    realm: null,
    service: 'flui-registry',
    issuer: 'flui-api',
    pushTokenSeconds: 900,
    pullTokenSeconds: 300,
    image: 'zot',
    storage: '1Gi',
    storageBackend: 'filesystem',
    storageClass: null,
    replicas: 1,
    cacheImage: 'redis',
    keepTags: 3,
    appQuotaMb: 0,
    maxRequestMb: 0,
    rateAverage: 0,
    rateBurst: 0,
    ioTimeoutSeconds: 600,
    spaceAlertPercent: 80,
    spaceAlertGib: 50,
    ...overrides,
  };
  const encryption = new EncryptionService({
    get: (name: string) =>
      name === 'ENCRYPTION_KEY' ? randomBytes(32).toString('hex') : undefined,
  } as unknown as ConfigService);
  const credentialRows = table();
  const keyRows = table();
  const applications = [
    { id: APP_A, deletedAt: null },
    { id: APP_B, deletedAt: null },
  ];
  const credentials = new RegistryCredentialsService(credentialRows as never);
  const keys = new RegistrySigningKeyService(keyRows as never, encryption);
  const sizes = { bytes: 0 };
  const tokens = new RegistryTokenService(
    config,
    credentials,
    keys,
    {
      findOne: async ({ where }: { where: { id: string } }) =>
        applications.find((a) => a.id === where.id && !a.deletedAt) ?? null,
    } as never,
    { repositorySizeBytes: async () => sizes.bytes } as never,
  );
  return { tokens, credentials, keys, keyRows, applications, sizes };
}

const claimsOf = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

describe('registry tokens', () => {
  it('signs a token the registry can verify with the public key alone', async () => {
    const { tokens, credentials, keys } = harness();
    const pull = await credentials.issue(APP_A, 'pull');

    const { token } = await tokens.issue({
      ...pull,
      scope: `repository:${registryRepositoryFor(APP_A)}:pull`,
      service: 'flui-registry',
    });

    const [header, payload, signature] = token.split('.');
    expect(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        {
          key: createPublicKey(await keys.publicKeyPem()),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
    const claims = claimsOf(token);
    expect(claims).toMatchObject({
      iss: 'flui-api',
      aud: 'flui-registry',
      access: [
        {
          type: 'repository',
          name: registryRepositoryFor(APP_A),
          actions: ['pull'],
        },
      ],
    });
    expect(claims.exp - claims.iat).toBe(300);
  });

  it('never lets one application’s credential reach another application’s images', async () => {
    const { tokens, credentials } = harness();
    const push = await credentials.issue(APP_A, 'push');

    const { token } = await tokens.issue({
      ...push,
      scope: [
        `repository:${registryRepositoryFor(APP_B)}:pull,push`,
        `repository:${registryRepositoryFor(APP_A)}:push`,
      ],
    });

    expect(claimsOf(token).access).toEqual([
      {
        type: 'repository',
        name: registryRepositoryFor(APP_A),
        actions: ['push'],
      },
    ]);
  });

  it('gives a pull credential no push, and a push token a longer life', async () => {
    const { tokens, credentials } = harness();
    const pull = await credentials.issue(APP_A, 'pull');
    const push = await credentials.issue(APP_A, 'push');
    const scope = `repository:${registryRepositoryFor(APP_A)}:pull,push`;

    expect(
      claimsOf((await tokens.issue({ ...pull, scope })).token).access[0]
        .actions,
    ).toEqual(['pull']);
    const pushed = await tokens.issue({ ...push, scope });
    expect(claimsOf(pushed.token).access[0].actions).toEqual(['pull', 'push']);
    expect(pushed.expiresIn).toBe(900);
  });

  it('answers docker login with a token that grants nothing', async () => {
    const { tokens, credentials } = harness();
    const push = await credentials.issue(APP_A, 'push');
    expect(claimsOf((await tokens.issue({ ...push })).token).access).toEqual(
      [],
    );
  });

  it('refuses a wrong secret, a replaced credential and a deleted application alike', async () => {
    const { tokens, credentials, applications } = harness();
    const first = await credentials.issue(APP_A, 'pull');
    const second = await credentials.issue(APP_A, 'pull');

    await expect(
      tokens.issue({ username: second.username, password: 'nope' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(tokens.issue({ ...first })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(tokens.issue({})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    applications[0].deletedAt = new Date() as never;
    await expect(tokens.issue({ ...second })).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not exist on an instance that runs no registry', async () => {
    const { tokens } = harness({ mode: 'ghcr' });
    await expect(tokens.issue({})).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a token for another service', async () => {
    const { tokens, credentials } = harness();
    const pull = await credentials.issue(APP_A, 'pull');
    await expect(
      tokens.issue({ ...pull, service: 'registry.docker.io' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps one signing key, sealed, across tokens', async () => {
    const { tokens, credentials, keyRows } = harness();
    const pull = await credentials.issue(APP_A, 'pull');
    await tokens.issue({ ...pull });
    await tokens.issue({ ...pull });

    expect(keyRows.rows).toHaveLength(1);
    expect(String(keyRows.rows[0].privateKeyEncrypted)).not.toContain(
      'PRIVATE KEY',
    );
  });
});

describe('the space an application may take on the registry', () => {
  const MB = 1024 * 1024;
  const scope = `repository:${registryRepositoryFor(APP_A)}:pull,push`;

  it('refuses a push once the application’s images fill its share', async () => {
    const { tokens, credentials, sizes } = harness({ appQuotaMb: 100 });
    const push = await credentials.issue(APP_A, 'push');
    sizes.bytes = 100 * MB;
    await expect(tokens.issue({ ...push, scope })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('still lets the cluster pull an application that is over its share', async () => {
    const { tokens, credentials, sizes } = harness({ appQuotaMb: 100 });
    const pull = await credentials.issue(APP_A, 'pull');
    sizes.bytes = 500 * MB;
    await expect(tokens.issue({ ...pull, scope })).resolves.toBeDefined();
  });

  it('pushes freely under the share, and without one', async () => {
    const limited = harness({ appQuotaMb: 100 });
    limited.sizes.bytes = 10 * MB;
    const a = await limited.credentials.issue(APP_A, 'push');
    await expect(limited.tokens.issue({ ...a, scope })).resolves.toBeDefined();

    const open = harness();
    open.sizes.bytes = 10_000 * MB;
    const b = await open.credentials.issue(APP_A, 'push');
    await expect(open.tokens.issue({ ...b, scope })).resolves.toBeDefined();
  });
});
