import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ProviderCredentialsEntity } from '../entities/credentials.entity';
import { KeyStorageService } from '../services/key-storage.service';
import {
  ProviderCredentialsRepository,
  SEALED_PROVIDER_CREDENTIAL_FIELDS,
} from './provider-credentials.repository';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function keyStorageWith(key?: string): KeyStorageService {
  return new KeyStorageService({
    get: (name: string, fallback?: string) =>
      name === 'SSH_KEY_ENCRYPTION_KEY' ? (key ?? '') : fallback,
  } as unknown as ConfigService);
}

function tableWith(rows: ProviderCredentialsEntity[]) {
  const table = {
    rows,
    create: jest.fn((value) => ({ ...value })),
    findOne: jest.fn(async () => null),
    findOneBy: jest.fn(async ({ id }) => rows.find((r) => r.id === id) ?? null),
    find: jest.fn(async (_options?: { select?: object }) => rows),
    save: jest.fn(async (value) => {
      const saved = { id: value.id ?? 'new-id', ...value };
      rows.push(saved);
      return saved;
    }),
  };
  return table;
}

const PLAINTEXT = {
  client_id: 'client-id',
  client_secret: 'client-secret',
  password: 'hunter2',
  access_token: 'eyJhbGciOiJSUzI1NiJ9.access.sig',
  refresh_token: 'eyJhbGciOiJSUzI1NiJ9.refresh.sig',
};

function repositoryOver(
  table: ReturnType<typeof tableWith>,
  keyStorage = keyStorageWith(KEY),
) {
  return new ProviderCredentialsRepository(
    table as unknown as Repository<ProviderCredentialsEntity>,
    keyStorage,
  );
}

async function save(repo: ProviderCredentialsRepository) {
  return repo.saveCredentials({
    provider: CloudProvider.CONTABO,
    username: 'operator',
    password: PLAINTEXT.password,
    client_id: PLAINTEXT.client_id,
    client_secret: PLAINTEXT.client_secret,
    accessToken: PLAINTEXT.access_token,
    refreshToken: PLAINTEXT.refresh_token,
    expiresIn: 300,
  });
}

describe('ProviderCredentialsRepository', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('stores every secret sealed with the installation key', async () => {
    const table = tableWith([]);
    const keyStorage = keyStorageWith(KEY);
    await save(repositoryOver(table, keyStorage));

    const stored = table.save.mock.calls[0][0];
    for (const field of SEALED_PROVIDER_CREDENTIAL_FIELDS) {
      expect(stored[field]).not.toBe(PLAINTEXT[field]);
      expect(JSON.stringify(stored)).not.toContain(PLAINTEXT[field]);
      expect(keyStorage.decryptKeyFromString(stored[field])).toBe(
        PLAINTEXT[field],
      );
    }
    expect(stored.username).toBe('operator');
  });

  it('hands the caller plaintext back, on save and on read', async () => {
    const table = tableWith([]);
    const repo = repositoryOver(table);

    expect(await save(repo)).toMatchObject(PLAINTEXT);
    const [read] = await repo.findByProvider(CloudProvider.CONTABO);
    expect(read).toMatchObject(PLAINTEXT);
    expect(await repo.findById(read.id)).toMatchObject(PLAINTEXT);
  });

  it('seals refreshed tokens', async () => {
    const table = tableWith([]);
    const keyStorage = keyStorageWith(KEY);
    const repo = repositoryOver(table, keyStorage);
    const { id } = await save(repo);

    const updated = await repo.updateTokens(id, 'new-access', 'new-refresh');

    const stored = table.save.mock.calls[1][0];
    expect(stored.access_token).not.toBe('new-access');
    expect(keyStorage.decryptKeyFromString(stored.access_token)).toBe(
      'new-access',
    );
    expect(keyStorage.decryptKeyFromString(stored.refresh_token)).toBe(
      'new-refresh',
    );
    expect(updated).toMatchObject({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
    });
  });

  it('refuses to store anything without a usable key', async () => {
    const table = tableWith([]);
    await expect(save(repositoryOver(table, keyStorageWith()))).rejects.toThrow(
      /Refusing to encrypt/,
    );
    expect(table.save).not.toHaveBeenCalled();
  });

  it('fails a read of a value it cannot open instead of returning it', async () => {
    const table = tableWith([
      {
        id: 'legacy',
        ...PLAINTEXT,
        access_token: 'still-plaintext',
      } as ProviderCredentialsEntity,
    ]);
    await expect(
      repositoryOver(table).findByProvider(CloudProvider.CONTABO),
    ).rejects.toThrow(/Could not decrypt/);
  });

  it('lists credentials without selecting a single secret column', async () => {
    const table = tableWith([]);
    await repositoryOver(table).findAll();

    const selected = Object.keys(table.find.mock.calls[0][0]?.select ?? {});
    for (const field of SEALED_PROVIDER_CREDENTIAL_FIELDS) {
      expect(selected).not.toContain(field);
    }
    expect(selected).toEqual(expect.arrayContaining(['id', 'provider']));
    expect(selected).not.toContain('username');
  });
});
