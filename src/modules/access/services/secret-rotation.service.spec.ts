import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  KeyStorageService,
  RETIRED_DEFAULT_KEY_HEX,
} from './key-storage.service';
import { SecretRotationService } from './secret-rotation.service';
import { ApiTokenEntity } from '../entities/api-token.entity';
import { ProviderCredentialsEntity } from '../entities/credentials.entity';

const A_REAL_KEY =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const AN_UNRELATED_KEY =
  '112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00';

/** Just enough Repository to exercise find/update against an array. */
function fakeRepository<T extends { id: string }>(rows: T[]): Repository<T> {
  return {
    find: async () => rows,
    update: async (id: string, patch: Partial<T>) => {
      const row = rows.find((r) => r.id === id);
      Object.assign(row, patch);
      return { affected: 1 };
    },
  } as unknown as Repository<T>;
}

function keyStorage(key: string, keysPath: string): KeyStorageService {
  return new KeyStorageService({
    get: (name: string, fallback?: string) => {
      if (name === 'SSH_KEY_ENCRYPTION_KEY') return key;
      if (name === 'SSH_KEYS_PATH') return keysPath;
      return fallback;
    },
  } as unknown as ConfigService);
}

describe('SecretRotationService', () => {
  let keysDir: string;

  beforeEach(async () => {
    keysDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flui-rotation-'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await fs.rm(keysDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function build(
    activeKey: string,
    rows: {
      apiTokens?: Partial<ApiTokenEntity>[];
      credentials?: Partial<ProviderCredentialsEntity>[];
    } = {},
  ) {
    const storage = keyStorage(activeKey, keysDir);
    const apiTokens = (rows.apiTokens ?? []) as ApiTokenEntity[];
    const credentials = (rows.credentials ?? []) as ProviderCredentialsEntity[];
    const config = {
      get: (name: string, fallback?: string) =>
        name === 'SSH_KEYS_PATH' ? keysDir : fallback,
    } as unknown as ConfigService;

    const service = new SecretRotationService(
      storage,
      config,
      fakeRepository(apiTokens),
      fakeRepository(credentials),
    );
    return { service, storage, apiTokens, credentials };
  }

  it('rewrites provider credentials sealed with the retired default', async () => {
    const legacy = keyStorage(RETIRED_DEFAULT_KEY_HEX, keysDir);
    const { service, storage, apiTokens } = build(A_REAL_KEY, {
      apiTokens: [
        {
          id: 'token-1',
          encrypted_token: legacy.encryptKeyToString('hcloud-secret'),
          encrypted_access_key: legacy.encryptKeyToString('SCWACCESSKEY'),
        },
      ],
    });

    const report = await service.rotate();

    expect(report.apiTokens).toBe(1);
    expect(report.failures).toBe(0);
    // The plaintext survived...
    expect(storage.decryptKeyFromString(apiTokens[0].encrypted_token)).toBe(
      'hcloud-secret',
    );
    expect(
      storage.decryptKeyFromString(apiTokens[0].encrypted_access_key),
    ).toBe('SCWACCESSKEY');
    // ...and the published key can no longer read it.
    expect(() =>
      legacy.decryptKeyFromString(apiTokens[0].encrypted_token),
    ).toThrow();
  });

  it('rewrites bearer credentials field by field', async () => {
    const legacy = keyStorage(RETIRED_DEFAULT_KEY_HEX, keysDir);
    const { service, storage, credentials } = build(A_REAL_KEY, {
      credentials: [
        {
          id: 'cred-1',
          password: legacy.encryptKeyToString('pw'),
          client_id: legacy.encryptKeyToString('cid'),
          client_secret: legacy.encryptKeyToString('csecret'),
        },
      ],
    });

    const report = await service.rotate();

    expect(report.providerCredentials).toBe(1);
    expect(storage.decryptKeyFromString(credentials[0].password)).toBe('pw');
    expect(storage.decryptKeyFromString(credentials[0].client_id)).toBe('cid');
    expect(storage.decryptKeyFromString(credentials[0].client_secret)).toBe(
      'csecret',
    );
  });

  it('rewrites SSH private key files on disk', async () => {
    const legacy = keyStorage(RETIRED_DEFAULT_KEY_HEX, keysDir);
    const keyFile = path.join(keysDir, 'user-1', 'key-1', 'private.key');
    await fs.mkdir(path.dirname(keyFile), { recursive: true });
    await fs.writeFile(keyFile, legacy.encryptKey('PRIVATE KEY BODY'));

    const { service, storage } = build(A_REAL_KEY);
    const report = await service.rotate();

    expect(report.keyFiles).toBe(1);
    expect(await storage.retrievePrivateKey(keyFile)).toBe('PRIVATE KEY BODY');
    // No temporary file survived the rename.
    expect(await fs.readdir(path.dirname(keyFile))).toEqual(['private.key']);
  });

  it('is idempotent — a second pass rewrites nothing', async () => {
    const legacy = keyStorage(RETIRED_DEFAULT_KEY_HEX, keysDir);
    const keyFile = path.join(keysDir, 'user-1', 'key-1', 'private.key');
    await fs.mkdir(path.dirname(keyFile), { recursive: true });
    await fs.writeFile(keyFile, legacy.encryptKey('body'));

    const { service } = build(A_REAL_KEY, {
      apiTokens: [
        { id: 't', encrypted_token: legacy.encryptKeyToString('secret') },
      ],
    });

    expect(await service.rotate()).toMatchObject({ apiTokens: 1, keyFiles: 1 });
    expect(await service.rotate()).toMatchObject({
      apiTokens: 0,
      keyFiles: 0,
      failures: 0,
    });
  });

  it('does nothing at all while the installation still has no real key', async () => {
    const legacy = keyStorage(RETIRED_DEFAULT_KEY_HEX, keysDir);
    const sealed = legacy.encryptKeyToString('secret');
    const { service, apiTokens } = build(RETIRED_DEFAULT_KEY_HEX, {
      apiTokens: [{ id: 't', encrypted_token: sealed }],
    });

    expect(await service.rotate()).toMatchObject({ skipped: true });
    expect(apiTokens[0].encrypted_token).toBe(sealed);
  });

  it('leaves a record it cannot open untouched, and counts it', async () => {
    // Restoring a database into an installation with a different key: the only
    // copy of this secret is the ciphertext, so overwriting it would destroy it.
    const stranger = keyStorage(AN_UNRELATED_KEY, keysDir);
    const sealed = stranger.encryptKeyToString('unreachable');
    const { service, apiTokens } = build(A_REAL_KEY, {
      apiTokens: [{ id: 't', encrypted_token: sealed }],
    });

    const report = await service.rotate();

    expect(report.failures).toBe(1);
    expect(report.apiTokens).toBe(0);
    expect(apiTokens[0].encrypted_token).toBe(sealed);
  });

  it('survives a missing key directory', async () => {
    const { service } = build(A_REAL_KEY);
    await fs.rm(keysDir, { recursive: true, force: true });
    await expect(service.rotate()).resolves.toMatchObject({ keyFiles: 0 });
  });

  it('does not let a failure escape into boot', async () => {
    const { service } = build(A_REAL_KEY);
    jest
      .spyOn(service, 'rotate')
      .mockRejectedValue(new Error('database is down'));
    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });
});
