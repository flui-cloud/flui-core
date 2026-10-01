import { ConfigService } from '@nestjs/config';
import { QueryRunner } from 'typeorm';
import { KeyStorageService } from '../modules/access/services/key-storage.service';
import { ProviderCredentialTokensSealed1790000000012 } from './1790000000012-ProviderCredentialTokensSealed';

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Row = {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
};

function runnerOver(rows: Row[]) {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const runner = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT')) return rows;
      updates.push({ sql, params });
      return [];
    }),
  };
  return { runner: runner as unknown as QueryRunner, updates };
}

const keyStorage = () => new KeyStorageService(new ConfigService());

describe('ProviderCredentialTokensSealed1790000000012', () => {
  const original = process.env.SSH_KEY_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.SSH_KEY_ENCRYPTION_KEY = KEY;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    if (original === undefined) delete process.env.SSH_KEY_ENCRYPTION_KEY;
    else process.env.SSH_KEY_ENCRYPTION_KEY = original;
    jest.restoreAllMocks();
  });

  it('seals plaintext tokens in place', async () => {
    const { runner, updates } = runnerOver([
      { id: 'row-1', access_token: 'plain-access', refresh_token: null },
      { id: 'row-2', access_token: 'a2', refresh_token: 'r2' },
    ]);

    await new ProviderCredentialTokensSealed1790000000012().up(runner);

    expect(updates).toHaveLength(2);
    expect(updates[0].sql).toContain('"access_token" = $2');
    expect(updates[0].sql).not.toContain('refresh_token');
    expect(updates[0].params[0]).toBe('row-1');
    expect(
      keyStorage().decryptKeyFromString(updates[0].params[1] as string),
    ).toBe('plain-access');
    const [id, access, refresh] = updates[1].params as string[];
    expect(id).toBe('row-2');
    expect(keyStorage().decryptKeyFromString(access)).toBe('a2');
    expect(keyStorage().decryptKeyFromString(refresh)).toBe('r2');
  });

  it('leaves a row that is already sealed alone', async () => {
    const sealed = keyStorage().encryptKeyToString('already');
    const { runner, updates } = runnerOver([
      { id: 'row-1', access_token: sealed, refresh_token: sealed },
    ]);

    await new ProviderCredentialTokensSealed1790000000012().up(runner);

    expect(updates).toHaveLength(0);
  });

  it('seals only the column that still needs it', async () => {
    const sealed = keyStorage().encryptKeyToString('already');
    const { runner, updates } = runnerOver([
      { id: 'row-1', access_token: sealed, refresh_token: 'plain-refresh' },
    ]);

    await new ProviderCredentialTokensSealed1790000000012().up(runner);

    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toContain('"refresh_token" = $2');
    expect(updates[0].sql).not.toContain('access_token');
  });

  it('throws without a usable key rather than writing anything', async () => {
    delete process.env.SSH_KEY_ENCRYPTION_KEY;
    const { runner, updates } = runnerOver([
      { id: 'row-1', access_token: 'plain-access', refresh_token: null },
    ]);

    await expect(
      new ProviderCredentialTokensSealed1790000000012().up(runner),
    ).rejects.toThrow(/Refusing to encrypt/);
    expect(updates).toHaveLength(0);
  });

  it('needs no key when there is nothing to convert', async () => {
    delete process.env.SSH_KEY_ENCRYPTION_KEY;
    const { runner, updates } = runnerOver([]);

    await new ProviderCredentialTokensSealed1790000000012().up(runner);

    expect(updates).toHaveLength(0);
  });

  it('down opens the tokens back for an image that reads them verbatim', async () => {
    const sealed = keyStorage().encryptKeyToString('the-token');
    const { runner, updates } = runnerOver([
      { id: 'row-1', access_token: sealed, refresh_token: null },
    ]);

    await new ProviderCredentialTokensSealed1790000000012().down(runner);

    expect(updates[0].params).toEqual(['row-1', 'the-token']);
  });
});
