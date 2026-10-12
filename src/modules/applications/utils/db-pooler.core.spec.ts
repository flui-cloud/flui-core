import { createHash, createHmac } from 'node:crypto';
import {
  DEFAULT_PGBOUNCER_IMAGE,
  ensurePoolerRoleScript,
  pgbouncerImage,
  poolerHostOf,
  poolerManifestsToApply,
  postgresIdentity,
  renderPgbouncerIni,
  renderUserlist,
  scramSha256Verifier,
} from './db-pooler.core';

describe('the pooler core', () => {
  it('takes the image from FLUI_PGBOUNCER_IMAGE and falls back to the pinned default', () => {
    expect(pgbouncerImage({})).toBe(DEFAULT_PGBOUNCER_IMAGE);
    expect(
      pgbouncerImage({ FLUI_PGBOUNCER_IMAGE: ' registry.local/pgb:1 ' }),
    ).toBe('registry.local/pgb:1');
  });

  it('names the pooled host after the database', () => {
    expect(poolerHostOf({ slug: 'pg-1', k8sNamespace: 'ns' })).toBe(
      'pg-1-pooler.ns.svc.cluster.local',
    );
  });

  it('declares only the database the install owns, no wildcard', () => {
    const ini = renderPgbouncerIni({
      database: 'appdb',
      upstreamHost: 'up.ns.svc.cluster.local',
      mode: 'transaction',
    });
    expect(ini.split('[pgbouncer]')[0].trim().split('\n')).toEqual([
      '[databases]',
      'appdb = host=up.ns.svc.cluster.local port=5432 dbname=appdb auth_dbname=appdb',
    ]);
    expect(ini).toContain('max_prepared_statements = 200');
    expect(ini).toContain('unix_socket_dir =\n');
  });

  it('keeps a deploy off the upstream Service and slice while the pooler forwards', () => {
    const list = [
      { name: 'pg-pooler' },
      { name: 'pg-pooler-upstream' },
      { name: 'pg-pooler-upstream-fwd' },
    ];
    expect(
      poolerManifestsToApply(
        {
          slug: 'pg',
          pooler: {
            upstream: {
              mode: 'forward',
              address: '10.250.0.2',
              port: 15432,
              linkId: 'l',
            },
          },
        },
        list,
      ),
    ).toEqual([{ name: 'pg-pooler' }]);
    expect(
      poolerManifestsToApply(
        { slug: 'pg', pooler: { upstream: { mode: 'local' } } },
        list,
      ),
    ).toEqual(list);
  });

  it('holds both waits a pause raises, so RELOAD puts both back', () => {
    const ini = renderPgbouncerIni({
      database: 'appdb',
      upstreamHost: 'up',
      mode: 'transaction',
    });
    expect(ini).toContain('query_wait_timeout = 120\n');
    expect(ini).toContain('client_login_timeout = 60\n');
  });

  it('refuses a database name that would break the configuration', () => {
    expect(() =>
      renderPgbouncerIni({
        database: 'x host=evil',
        upstreamHost: 'up',
        mode: 'session',
      }),
    ).toThrow(/cannot be written/);
  });

  it('refuses a password the user list cannot carry', () => {
    expect(() => renderUserlist({ auth: 'a"b', admin: 'ok' })).toThrow();
  });

  it('sets the role password from a psql variable and never on a standby', () => {
    const script = ensurePoolerRoleScript('abc123');
    expect(script.split('\n')[0]).toMatch(
      /^\\set pw 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'$/,
    );
    expect(script).toContain("PASSWORD :'pw'");
    expect(script).toContain('CONNECTION LIMIT 20');
    expect(script).toContain('IF pg_is_in_recovery() THEN');
    expect(script).toContain(
      "CASE WHEN pg_is_in_recovery() THEN (SELECT k.timeline_id FROM pg_control_checkpoint() k) ELSE ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::int END, inet_server_addr()",
    );
    // The image's bootstrap superuser carries REPLICATION too, so excluding
    // every replication role would lock the app's own user out.
    expect(script).toContain('(rolsuper OR NOT rolreplication)');
    expect(script).toContain("rolname <> 'flui_pooler'");
    expect(script).toContain(
      'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA flui_pooler FROM PUBLIC',
    );
    expect(() => ensurePoolerRoleScript("x'; DROP")).toThrow();
  });

  it('never puts the plain password in the script', () => {
    const password = 'f3a9c1d27b4e8a6050c2d9e1b7a4f3c8';
    const script = ensurePoolerRoleScript(password);
    expect(script).not.toContain(password);
    const salt = /SCRAM-SHA-256\$4096:([^$]+)\$/.exec(script)![1];
    expect(script.split('\n')[0]).toBe(
      `\\set pw '${scramSha256Verifier(password, Buffer.from(salt, 'base64'))}'`,
    );
  });
});

describe('scramSha256Verifier', () => {
  // RFC 7677 section 3: user "user", password "pencil".
  const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
  const nonce = 'rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
  const authMessage = [
    'n=user,r=rOprNGfwEbeRWgbNEkqO',
    `r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096`,
    `c=biws,r=${nonce}`,
  ].join(',');
  const hmac = (key: Buffer, msg: string) =>
    createHmac('sha256', key).update(msg).digest();

  it('writes the form PostgreSQL stores', () => {
    expect(scramSha256Verifier('pencil', salt)).toMatch(
      /^SCRAM-SHA-256\$4096:W22ZaJ0SNY7soEsUEjb6gQ==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/,
    );
  });

  it('accepts the RFC client proof and answers with the RFC server signature', () => {
    const [, storedB64, serverB64] = /\$([^$:]+):([^$:]+)$/.exec(
      scramSha256Verifier('pencil', salt),
    )!;
    const storedKey = Buffer.from(storedB64, 'base64');
    const serverKey = Buffer.from(serverB64, 'base64');

    expect(hmac(serverKey, authMessage).toString('base64')).toBe(
      '6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=',
    );
    const proof = Buffer.from(
      'dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=',
      'base64',
    );
    const signature = hmac(storedKey, authMessage);
    const clientKey = Buffer.from(proof.map((b, i) => b ^ signature[i]));
    expect(createHash('sha256').update(clientKey).digest()).toEqual(storedKey);
  });

  it('salts every verifier anew', () => {
    expect(scramSha256Verifier('pencil')).not.toBe(
      scramSha256Verifier('pencil'),
    );
  });
});

describe('postgresIdentity', () => {
  const encryption = {
    decrypt: (v: string) => {
      if (!v.startsWith('enc:')) throw new Error('not encrypted');
      return v.slice(4);
    },
  };

  it('decrypts secret values and keeps a plaintext one marked secret as stored', () => {
    expect(
      postgresIdentity(
        [
          { name: 'POSTGRES_USER', value: 'enc:owner', secret: true },
          { name: 'POSTGRES_DB', value: 'appdb', secret: true },
        ],
        encryption,
      ),
    ).toEqual({ user: 'owner', database: 'appdb' });
  });

  it('falls back the way the image does and ignores pending values', () => {
    expect(postgresIdentity(undefined, encryption)).toEqual({
      user: 'postgres',
      database: 'postgres',
    });
    expect(
      postgresIdentity(
        [
          { name: 'POSTGRES_USER', value: 'owner' },
          { name: 'POSTGRES_DB', value: '', secret: true, pending: true },
        ],
        encryption,
      ),
    ).toEqual({ user: 'owner', database: 'owner' });
  });
});
