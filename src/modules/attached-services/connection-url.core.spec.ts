import {
  CONNECTION_URL_KEY,
  composeConnectionUrl,
  engineHasConnectionUrl,
} from './connection-url.core';

describe('composeConnectionUrl', () => {
  const host = 'flui-postgres-a1b2-svc.user-x.svc.cluster.local';

  it('builds a postgres URL from the engine profile', () => {
    expect(
      composeConnectionUrl({
        engine: 'postgres',
        host,
        port: 5432,
        env: {
          POSTGRES_USER: 'flui',
          POSTGRES_PASSWORD: 'sw0rdfish',
          POSTGRES_DB: 'appdb',
        },
      }),
    ).toBe(`postgresql://flui:sw0rdfish@${host}:5432/appdb`);
  });

  it('accepts the MYSQL_* aliases MariaDB seeds actually use', () => {
    expect(
      composeConnectionUrl({
        engine: 'mariadb',
        host,
        port: 3306,
        env: {
          MYSQL_USER: 'nextcloud',
          MYSQL_PASSWORD: 'p',
          MYSQL_DATABASE: 'nc',
        },
      }),
    ).toBe(`mysql://nextcloud:p@${host}:3306/nc`);
  });

  it('leaves the user empty for a key-value engine, which has none', () => {
    expect(
      composeConnectionUrl({
        engine: 'redis',
        host,
        port: 6379,
        env: { REDIS_PASSWORD: 'hunter2' },
      }),
    ).toBe(`redis://:hunter2@${host}:6379`);
  });

  it('escapes a password that would otherwise break the URL', () => {
    expect(
      composeConnectionUrl({
        engine: 'postgres',
        host,
        port: 5432,
        env: { POSTGRES_USER: 'flui', POSTGRES_PASSWORD: 'p@ss:word/1' },
      }),
    ).toBe(`postgresql://flui:p%40ss%3Aword%2F1@${host}:5432`);
  });

  it('falls back to the profile port when the block declares none', () => {
    expect(
      composeConnectionUrl({
        engine: 'postgres',
        host,
        port: null,
        env: { POSTGRES_PASSWORD: 'x' },
      }),
    ).toContain(':5432');
  });

  it('returns null — never a half-formed URL — for a block with no engine', () => {
    expect(
      composeConnectionUrl({ engine: null, host, port: 9000, env: {} }),
    ).toBeNull();
    expect(
      composeConnectionUrl({ engine: 'kafka', host, port: 9092, env: {} }),
    ).toBeNull();
  });
});

describe('engineHasConnectionUrl', () => {
  it('is true only for engines with a profile', () => {
    expect(engineHasConnectionUrl('postgres')).toBe(true);
    expect(engineHasConnectionUrl('valkey')).toBe(true);
    expect(engineHasConnectionUrl('minio')).toBe(false);
    expect(engineHasConnectionUrl(undefined)).toBe(false);
  });
});

describe('CONNECTION_URL_KEY', () => {
  it('is a valid Kubernetes Secret key and an env name', () => {
    expect(CONNECTION_URL_KEY).toMatch(/^[A-Z_][A-Z0-9_]*$/);
  });
});
