import { resolveRestoreIdentities } from './db-restore-identities.util';

describe('who a restored database boots as', () => {
  const app = (env: Record<string, string>) =>
    ({
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    }) as any;

  it('takes what the artifact recorded, even with the source still there', () => {
    expect(
      resolveRestoreIdentities(
        app({ POSTGRES_USER: 'live' }),
        { identities: { user: 'u', database: 'd' } },
        'src',
      ),
    ).toEqual({ user: 'u', database: 'd' });
  });

  it('falls back to the older names, then to the source application', () => {
    expect(
      resolveRestoreIdentities(null, { pgUser: 'p', pgDb: 'q' }, 'src'),
    ).toEqual({
      user: 'p',
      database: 'q',
    });
    expect(
      resolveRestoreIdentities(
        app({ MARIADB_USER: 'm', MARIADB_DATABASE: 'db' }),
        {},
        'src',
      ),
    ).toEqual({ user: 'm', database: 'db' });
  });

  it('names the source when nothing else is known', () => {
    expect(resolveRestoreIdentities(null, {}, 'src')).toEqual({
      user: 'src',
      database: 'src',
    });
  });
});
