import {
  LOGIN_CLIENT_TOKEN_LIFETIME_MS,
  VisitorLoginClientService,
} from './visitor-login-client.service';

const DAY = 24 * 3_600_000;
const NOW = new Date('2026-10-13T12:00:00Z');
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);

describe('VisitorLoginClientService', () => {
  const conn = { pat: 'service-pat', host: 'auth.example.test' };
  const build = (
    over: {
      row?: Record<string, unknown> | null;
      accepts?: boolean;
      existing?: unknown;
      tokenIds?: string[];
    } = {},
  ) => {
    const rows = {
      findOne: jest.fn(async () => over.row ?? null),
      save: jest.fn(async (r: unknown) => r),
      update: jest.fn(async () => undefined),
    };
    const admin = {
      findUserByUsername: jest.fn(async () => over.existing ?? null),
      createMachineUser: jest.fn(async () => ({ id: 'm-new' })),
    };
    const login = {
      acceptsToken: jest.fn(async () => over.accepts ?? true),
      addInstanceMember: jest.fn(async () => undefined),
      createPersonalAccessToken: jest.fn(async () => ({
        tokenId: 't-new',
        token: 'login-pat',
      })),
      listPersonalAccessTokenIds: jest.fn(async () => over.tokenIds ?? []),
      deletePersonalAccessToken: jest.fn(async () => undefined),
    };
    const locks: string[] = [];
    const runner = {
      connect: async () => undefined,
      query: async (q: string) => void locks.push(q),
      release: async () => undefined,
    };
    const service = new VisitorLoginClientService(
      admin as never,
      login as never,
      {
        encrypt: (v: string) => `enc(${v})`,
        decrypt: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
      } as never,
      rows as never,
      { createQueryRunner: () => runner } as never,
    );
    return { service, rows, admin, login, locks };
  };

  it('makes an account holding only the login-client role, and stores an expiring token encrypted, under a lock', async () => {
    const t = build();
    await t.service.ensure(conn, NOW);
    expect(t.locks[0]).toContain('pg_advisory_lock');
    expect(t.admin.createMachineUser).toHaveBeenCalledWith(
      'service-pat',
      'auth.example.test',
      expect.objectContaining({ userName: 'flui-visitor-login' }),
    );
    expect(t.login.addInstanceMember).toHaveBeenCalledWith(
      'service-pat',
      'auth.example.test',
      'm-new',
      ['IAM_LOGIN_CLIENT'],
    );
    const expiresAt = new Date(NOW.getTime() + LOGIN_CLIENT_TOKEN_LIFETIME_MS);
    expect(t.login.createPersonalAccessToken).toHaveBeenCalledWith(
      'service-pat',
      'auth.example.test',
      'm-new',
      expiresAt,
    );
    expect(t.rows.save).toHaveBeenCalledWith({
      id: 'default',
      idpUserId: 'm-new',
      patEncrypted: 'enc(login-pat)',
      tokenId: 't-new',
      expiresAt,
    });
    expect(t.login.deletePersonalAccessToken).not.toHaveBeenCalled();
    expect(await t.service.token()).toBe('login-pat');
  });

  it('keeps a stored token the provider still accepts and that is far from its expiry', async () => {
    const t = build({
      row: {
        idpUserId: 'm1',
        patEncrypted: 'enc(old)',
        tokenId: 't-old',
        expiresAt: inDays(60),
      },
    });
    await t.service.ensure(conn, NOW);
    expect(t.login.acceptsToken).toHaveBeenCalledWith(
      'old',
      'auth.example.test',
    );
    expect(t.login.createPersonalAccessToken).not.toHaveBeenCalled();
    expect(await t.service.token()).toBe('old');
  });

  it('mints a new token for the existing account when the stored one is refused, and deletes the old one', async () => {
    const t = build({
      row: {
        idpUserId: 'm1',
        patEncrypted: 'enc(old)',
        tokenId: 't-old',
        expiresAt: inDays(60),
      },
      accepts: false,
      existing: { id: 'm1', userName: 'flui-visitor-login' },
    });
    await t.service.ensure(conn, NOW);
    expect(t.admin.createMachineUser).not.toHaveBeenCalled();
    expect(t.login.createPersonalAccessToken).toHaveBeenCalledWith(
      'service-pat',
      'auth.example.test',
      'm1',
      expect.any(Date),
    );
    expect(t.login.deletePersonalAccessToken).toHaveBeenCalledWith(
      'service-pat',
      'auth.example.test',
      'm1',
      't-old',
    );
  });

  it('renews a token close to its expiry, and only then', async () => {
    const existing = { id: 'm1', userName: 'flui-visitor-login' };
    const fresh = build({
      row: { idpUserId: 'm1', patEncrypted: 'enc(a)', expiresAt: inDays(30) },
      existing,
    });
    expect(await fresh.service.renewIfDue(conn, NOW)).toBe(false);
    expect(fresh.login.createPersonalAccessToken).not.toHaveBeenCalled();

    const soon = build({
      row: {
        idpUserId: 'm1',
        patEncrypted: 'enc(a)',
        tokenId: 't-a',
        expiresAt: inDays(10),
      },
      existing,
    });
    expect(await soon.service.renewIfDue(conn, NOW)).toBe(true);
    expect(soon.login.acceptsToken).not.toHaveBeenCalled();
    expect(soon.login.createPersonalAccessToken).toHaveBeenCalled();
    expect(soon.login.deletePersonalAccessToken).toHaveBeenCalledWith(
      'service-pat',
      'auth.example.test',
      'm1',
      't-a',
    );
  });

  it('gives a token stored without an expiry one, deleting every other token of the account', async () => {
    const t = build({
      row: { idpUserId: 'm1', patEncrypted: 'enc(a)', expiresAt: null },
      existing: { id: 'm1', userName: 'flui-visitor-login' },
      tokenIds: ['t-legacy', 't-new'],
    });
    expect(await t.service.renewIfDue(conn, NOW)).toBe(true);
    expect(t.login.deletePersonalAccessToken).toHaveBeenCalledTimes(1);
    expect(t.login.deletePersonalAccessToken).toHaveBeenCalledWith(
      'service-pat',
      'auth.example.test',
      'm1',
      't-legacy',
    );
  });

  it('keeps the new token when the old one cannot be deleted', async () => {
    const t = build({
      row: {
        idpUserId: 'm1',
        patEncrypted: 'enc(a)',
        tokenId: 't-a',
        expiresAt: inDays(1),
      },
      existing: { id: 'm1', userName: 'flui-visitor-login' },
    });
    t.login.deletePersonalAccessToken.mockRejectedValueOnce(new Error('down'));
    await expect(t.service.ensure(conn, NOW)).resolves.toBeUndefined();
    expect(await t.service.token()).toBe('login-pat');
  });

  it('does not mistake an account that merely starts with the name', async () => {
    const t = build({
      existing: { id: 'x', userName: 'flui-visitor-login-old' },
    });
    await t.service.ensure(conn, NOW);
    expect(t.admin.createMachineUser).toHaveBeenCalled();
  });

  it('reads the stored token when this copy never ensured it, and forgets on request', async () => {
    const t = build({ row: { idpUserId: 'm1', patEncrypted: 'enc(stored)' } });
    expect(await t.service.token()).toBe('stored');
    t.service.forget();
    await t.service.token();
    expect(t.rows.findOne).toHaveBeenCalledTimes(2);
  });

  it('keeps the try applications’ client ids on the credential row', async () => {
    const t = build();
    await t.service.rememberTryClients('c-web', 'c-cli');
    expect(t.rows.update).toHaveBeenCalledWith(
      { id: 'default' },
      { webClientId: 'c-web', cliClientId: 'c-cli' },
    );
  });
});
