import { envChanges, envHashOf, restartEnvOf } from './env-hash.util';

const v = (name: string, value: string, secret = false) =>
  ({ name, value, secret }) as never;

describe('env hash and changes', () => {
  it('does not depend on the order variables are stored in', () => {
    expect(envHashOf([v('A', '1'), v('B', '2')])).toBe(
      envHashOf([v('B', '2'), v('A', '1')]),
    );
  });

  it('changes when a value changes, and ignores a variable still awaiting its value', () => {
    expect(envHashOf([v('A', '1')])).not.toBe(envHashOf([v('A', '2')]));
    expect(envHashOf([v('A', '1')])).toBe(
      envHashOf([
        v('A', '1'),
        { name: 'W', value: '', pending: true } as never,
      ]),
    );
  });

  it('names what changed and never says a value', () => {
    expect(
      envChanges(
        [v('A', '1'), v('GONE', 'x')],
        [v('A', '2', true), v('NEW', 's3cr3t', true)],
      ),
    ).toEqual(['A changed', 'GONE removed', 'NEW added']);
  });
});

describe('the variables a restart would change', () => {
  const env = [
    { name: 'POSTGRES_USER', value: 'u' },
    { name: 'FLUI_CONNECTION_URL', value: 'pooled', secret: true },
    { name: 'FLUI_DIRECT_URL', value: 'direct', secret: true },
  ];

  it('leaves out the URLs a datastore publishes for its consumers', () => {
    const db = { env, labels: { 'flui.cloud/db-engine': 'postgres' } };
    expect(restartEnvOf(db).map((e) => e.name)).toEqual([]);
    expect(
      envHashOf(
        restartEnvOf({
          ...db,
          env: env.map((e) =>
            e.name === 'FLUI_CONNECTION_URL' ? { ...e, value: 'direct' } : e,
          ),
        }),
      ),
    ).toBe(envHashOf(restartEnvOf(db)));
  });

  it('leaves out what a PostgreSQL reads only on its first start', () => {
    const db = {
      env: [
        ...env,
        { name: 'POSTGRES_PASSWORD', value: 'p', secret: true },
        { name: 'FLUI_PG_STANDBY', value: '1' },
        { name: 'FLUI_PG_RESTORE_TARGET', value: 't' },
        { name: 'SHARED_BUFFERS', value: '128MB' },
      ],
      labels: { 'flui.cloud/db-engine': 'postgres' },
    };
    expect(restartEnvOf(db).map((e) => e.name)).toEqual(['SHARED_BUFFERS']);
    expect(
      restartEnvOf({ ...db, labels: { 'flui.cloud/db-engine': 'mysql' } }).map(
        (e) => e.name,
      ),
    ).toContain('POSTGRES_PASSWORD');
  });

  it('keeps them on an application that reads them', () => {
    expect(restartEnvOf({ env, labels: {} })).toHaveLength(3);
    expect(restartEnvOf({ env })).toHaveLength(3);
  });
});
