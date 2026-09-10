import {
  BlockFacts,
  LinkedEnvError,
  resolveLinkedEnvEntries,
} from './attached-service-env.core';
import { CONNECTION_URL_KEY } from './connection-url.core';

const facts: BlockFacts = {
  ref: 'postgresql',
  host: 'flui-postgres-a1b2-svc.user-x.svc.cluster.local',
  port: 5432,
  secretName: 'flui-postgres-a1b2-secret',
  declaredEnv: [
    { name: 'POSTGRES_PASSWORD', secret: true },
    { name: 'POSTGRES_USER', secret: false },
  ],
  appEnv: { POSTGRES_USER: 'flui' },
  connectionUrlKey: CONNECTION_URL_KEY,
};

describe('resolveLinkedEnvEntries', () => {
  it('resolves host and port from the service', () => {
    expect(
      resolveLinkedEnvEntries(
        [
          { name: 'DB_HOST', fromService: 'host' },
          { name: 'DB_PORT', fromService: 'port' },
        ],
        facts,
      ),
    ).toEqual([
      { name: 'DB_HOST', value: facts.host, secret: false },
      { name: 'DB_PORT', value: '5432', secret: false },
    ]);
  });

  it('resolves url to a reference at the block secret, never to a value', () => {
    const [entry] = resolveLinkedEnvEntries(
      [{ name: 'DATABASE_URL', fromService: 'url' }],
      facts,
    );
    expect(entry).toEqual({
      name: 'DATABASE_URL',
      value: '',
      secret: true,
      externalSecretRef: {
        secretName: 'flui-postgres-a1b2-secret',
        key: CONNECTION_URL_KEY,
      },
    });
    expect(entry.value).toBe('');
  });

  it('refuses url on a block with no URL form, naming the block', () => {
    expect(() =>
      resolveLinkedEnvEntries([{ name: 'URL', fromService: 'url' }], {
        ...facts,
        ref: 'kafka',
        connectionUrlKey: null,
      }),
    ).toThrow(/kafka/);
    expect(() =>
      resolveLinkedEnvEntries([{ name: 'URL', fromService: 'url' }], {
        ...facts,
        connectionUrlKey: null,
      }),
    ).toThrow(LinkedEnvError);
  });

  it('injects a secret block env by reference and a plain one by value', () => {
    expect(
      resolveLinkedEnvEntries(
        [
          { name: 'PGPASSWORD', fromBBEnv: 'POSTGRES_PASSWORD' },
          { name: 'PGUSER', fromBBEnv: 'POSTGRES_USER' },
        ],
        facts,
      ),
    ).toEqual([
      {
        name: 'PGPASSWORD',
        value: '',
        secret: true,
        externalSecretRef: {
          secretName: 'flui-postgres-a1b2-secret',
          key: 'POSTGRES_PASSWORD',
        },
      },
      { name: 'PGUSER', value: 'flui', secret: false },
    ]);
  });

  it('refuses a fromBBEnv the block does not declare', () => {
    expect(() =>
      resolveLinkedEnvEntries([{ name: 'X', fromBBEnv: 'NOT_A_THING' }], facts),
    ).toThrow(LinkedEnvError);
  });

  it('passes a literal through', () => {
    expect(
      resolveLinkedEnvEntries([{ name: 'SSLMODE', value: 'disable' }], facts),
    ).toEqual([{ name: 'SSLMODE', value: 'disable', secret: false }]);
  });

  it('refuses an entry that says nothing', () => {
    expect(() => resolveLinkedEnvEntries([{ name: 'X' }], facts)).toThrow(
      LinkedEnvError,
    );
  });
});
