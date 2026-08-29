import {
  applyPlainVars,
  applySensitiveVars,
  materializeDeclaredSecrets,
  pendingEnvKeys,
  plainEnvData,
  renderableEnv,
  requestSensitiveVars,
} from './env-write.util';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';

const byName = (env: ApplicationEnvVar[], n: string) =>
  env.find((e) => e.name === n);
const names = (env: ApplicationEnvVar[]) => env.map((e) => e.name);

describe('applyPlainVars', () => {
  // The vops-ops defect: the edit has to land in the DB, or the next deploy
  // regenerates the ConfigMap from the stale row and reinstates the old value.
  it('writes the edited value into the source of truth', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'API_URL', value: 'http://old.nip.io', source: 'user' },
    ];
    const { env } = applyPlainVars(existing, {
      API_URL: 'https://vops-api.flui.cloud',
    });
    expect(byName(env, 'API_URL')?.value).toBe('https://vops-api.flui.cloud');
    expect(byName(env, 'API_URL')?.source).toBe('user');
  });

  it('appends a new key and preserves the order of the existing ones', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'A', value: '1', source: 'manifest' },
      { name: 'B', value: '2', source: 'user' },
    ];
    const { env } = applyPlainVars(existing, { C: '3' });
    expect(names(env)).toEqual(['A', 'B', 'C']);
  });

  it('refuses to overwrite a building-block link with a plain value', () => {
    const existing: ApplicationEnvVar[] = [
      {
        name: 'DB_PASSWORD',
        value: '',
        source: 'link',
        externalSecretRef: {
          secretName: 'pg-secret',
          key: 'POSTGRES_PASSWORD',
        },
      },
    ];
    const { env, skipped } = applyPlainVars(existing, { DB_PASSWORD: 'oops' });
    expect(byName(env, 'DB_PASSWORD')?.externalSecretRef).toBeDefined();
    expect(byName(env, 'DB_PASSWORD')?.value).toBe('');
    expect(skipped).toHaveLength(1);
  });

  it('refuses a sensitive var arriving through the plain path', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'TOKEN', value: 'enc:abc', secret: true, source: 'user' },
    ];
    const { env, skipped } = applyPlainVars(existing, { TOKEN: 'leaked' });
    expect(byName(env, 'TOKEN')?.value).toBe('enc:abc');
    expect(skipped[0].name).toBe('TOKEN');
  });

  // The hazard the old full-replace had: a stale or partial read must not be
  // able to wipe the source of truth.
  it('does not delete a key merely absent from the payload', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'KEEP_ME', value: 'x', source: 'user' },
    ];
    const { env } = applyPlainVars(existing, { OTHER: 'y' });
    expect(byName(env, 'KEEP_ME')).toBeDefined();
  });

  it('deletes only what is explicitly listed', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'GONE', value: 'x', source: 'user' },
      { name: 'STAYS', value: 'y', source: 'user' },
    ];
    const { env } = applyPlainVars(existing, {}, ['GONE']);
    expect(names(env)).toEqual(['STAYS']);
  });

  it('a plain delete cannot remove a secret or a link', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'TOKEN', value: 'enc', secret: true, source: 'user' },
      {
        name: 'LINK',
        value: '',
        source: 'link',
        externalSecretRef: { secretName: 's', key: 'k' },
      },
    ];
    const { env } = applyPlainVars(existing, {}, ['TOKEN', 'LINK']);
    expect(names(env)).toEqual(['TOKEN', 'LINK']);
  });
});

describe('applySensitiveVars', () => {
  const encrypt = (v: string) => `enc(${v})`;

  it('stores the value encrypted and flagged as secret', () => {
    const { env } = applySensitiveVars([], { TOKEN: 's3cr3t' }, [], encrypt);
    expect(byName(env, 'TOKEN')).toEqual({
      name: 'TOKEN',
      value: 'enc(s3cr3t)',
      secret: true,
      source: 'user',
    });
  });

  it('drops a masked value instead of overwriting the real secret', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'TOKEN', value: 'enc(real)', secret: true, source: 'user' },
    ];
    const { env, skipped } = applySensitiveVars(
      existing,
      { TOKEN: '****' },
      [],
      encrypt,
    );
    expect(byName(env, 'TOKEN')?.value).toBe('enc(real)');
    expect(skipped[0].name).toBe('TOKEN');
  });

  it('refuses to overwrite a building-block link', () => {
    const existing: ApplicationEnvVar[] = [
      {
        name: 'DB_PASSWORD',
        value: '',
        source: 'link',
        externalSecretRef: { secretName: 'pg', key: 'P' },
      },
    ];
    const { env, skipped } = applySensitiveVars(
      existing,
      { DB_PASSWORD: 'oops' },
      [],
      encrypt,
    );
    expect(byName(env, 'DB_PASSWORD')?.externalSecretRef).toBeDefined();
    expect(skipped).toHaveLength(1);
  });

  it('a sensitive delete cannot remove a plain var', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'PLAIN', value: 'x', source: 'user' },
      { name: 'TOKEN', value: 'enc', secret: true, source: 'user' },
    ];
    const { env } = applySensitiveVars(
      existing,
      {},
      ['PLAIN', 'TOKEN'],
      encrypt,
    );
    expect(names(env)).toEqual(['PLAIN']);
  });
});

describe('plainEnvData', () => {
  it('projects only the ConfigMap-bound keys', () => {
    const env: ApplicationEnvVar[] = [
      { name: 'PLAIN', value: 'x', source: 'user' },
      { name: 'TOKEN', value: 'enc', secret: true, source: 'user' },
      {
        name: 'LINK',
        value: '',
        source: 'link',
        externalSecretRef: { secretName: 's', key: 'k' },
      },
    ];
    expect(plainEnvData(env)).toEqual({ PLAIN: 'x' });
  });
});

/**
 * "Missing a value" is a state, not an error — the whole hand-off rests on it.
 * These prove the state is durable, that declaring it can never destroy a value
 * that already exists, and that nothing pending reaches a container.
 */
describe('requestSensitiveVars — declaring a value that has not arrived', () => {
  it('records the key with no value at all', () => {
    const { env } = requestSensitiveVars([], ['STRIPE_SECRET_KEY']);
    expect(byName(env, 'STRIPE_SECRET_KEY')).toEqual({
      name: 'STRIPE_SECRET_KEY',
      value: '',
      secret: true,
      pending: true,
      source: 'user',
    });
  });

  // The dangerous case: an agent asking for "the API key" of an app that
  // already has one must not be able to wipe a working credential.
  it('leaves a configured key untouched and says why', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'TOKEN', value: 'encrypted', secret: true, source: 'user' },
    ];
    const { env, skipped } = requestSensitiveVars(existing, ['TOKEN']);
    expect(byName(env, 'TOKEN')?.value).toBe('encrypted');
    expect(byName(env, 'TOKEN')?.pending).toBeUndefined();
    expect(skipped).toEqual([{ name: 'TOKEN', reason: 'already configured' }]);
  });

  it('refuses a key linked to a building block, which has no value of ours to wait for', () => {
    const existing: ApplicationEnvVar[] = [
      {
        name: 'DB_PASSWORD',
        value: '',
        source: 'link',
        externalSecretRef: { secretName: 'pg-secret', key: 'password' },
      },
    ];
    const { env, skipped } = requestSensitiveVars(existing, ['DB_PASSWORD']);
    expect(byName(env, 'DB_PASSWORD')?.externalSecretRef).toBeDefined();
    expect(skipped[0].reason).toContain('building-block');
  });

  it('refuses to turn an existing plain variable into a pending secret', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'LOG_LEVEL', value: 'info', source: 'user' },
    ];
    const { env, skipped } = requestSensitiveVars(existing, ['LOG_LEVEL']);
    expect(byName(env, 'LOG_LEVEL')?.secret).toBeUndefined();
    expect(skipped[0].reason).toContain('plain');
  });

  it('re-declaring a key already awaiting a value changes nothing and refuses nothing', () => {
    const first = requestSensitiveVars([], ['TOKEN']).env;
    const { env, skipped } = requestSensitiveVars(first, ['TOKEN']);
    expect(names(env)).toEqual(['TOKEN']);
    expect(skipped).toEqual([]);
  });
});

describe('delivery clears the waiting state', () => {
  it('replaces the pending entry with the encrypted value and drops the flag', () => {
    const pending = requestSensitiveVars([], ['TOKEN']).env;
    const { env } = applySensitiveVars(
      pending,
      { TOKEN: 'the-real-thing' },
      [],
      (v) => `enc(${v})`,
    );
    expect(byName(env, 'TOKEN')).toEqual({
      name: 'TOKEN',
      value: 'enc(the-real-thing)',
      secret: true,
      source: 'user',
    });
    expect(pendingEnvKeys(env)).toEqual([]);
  });

  it('withdraws a declaration through the ordinary explicit deletion', () => {
    const pending = requestSensitiveVars([], ['TOKEN']).env;
    const { env } = applySensitiveVars(pending, {}, ['TOKEN']);
    expect(names(env)).toEqual([]);
  });

  // The editor sends the mask back for a secret it never held. Writing it would
  // replace the credential with the placeholder.
  it('still refuses the display mask as a value', () => {
    const pending = requestSensitiveVars([], ['TOKEN']).env;
    const { env, skipped } = applySensitiveVars(pending, { TOKEN: '****' });
    expect(byName(env, 'TOKEN')?.pending).toBe(true);
    expect(skipped[0].reason).toContain('mask');
  });
});

describe('nothing pending reaches a container', () => {
  const env: ApplicationEnvVar[] = [
    { name: 'PLAIN', value: 'x', source: 'user' },
    { name: 'SET', value: 'enc', secret: true, source: 'user' },
    { name: 'WAITING', value: '', secret: true, pending: true, source: 'user' },
  ];

  it('keeps a pending key out of the renderable set', () => {
    expect(names(renderableEnv(env))).toEqual(['PLAIN', 'SET']);
  });

  it('keeps it out of the ConfigMap projection too', () => {
    expect(plainEnvData(env)).toEqual({ PLAIN: 'x' });
  });

  it('reads the waiting keys back by name', () => {
    expect(pendingEnvKeys(env)).toEqual(['WAITING']);
  });
});

describe('materializeDeclaredSecrets', () => {
  it('gives a first-time secret declaration a pending entry to be listed by', () => {
    const env = materializeDeclaredSecrets(
      [],
      [{ name: 'API_KEY', secret: true }],
    );
    expect(env).toEqual([
      {
        name: 'API_KEY',
        value: '',
        secret: true,
        pending: true,
        source: 'manifest',
      },
    ]);
  });

  it('never touches a key already delivered — the whole point', () => {
    const delivered: ApplicationEnvVar[] = [
      { name: 'API_KEY', value: 'enc', secret: true, source: 'user' },
    ];
    const env = materializeDeclaredSecrets(delivered, [
      { name: 'API_KEY', secret: true },
    ]);
    expect(env).toBe(delivered);
  });

  it('never touches an already-pending key either — no double placeholder', () => {
    const pending: ApplicationEnvVar[] = [
      {
        name: 'API_KEY',
        value: '',
        secret: true,
        pending: true,
        source: 'manifest',
      },
    ];
    const env = materializeDeclaredSecrets(pending, [
      { name: 'API_KEY', secret: true },
    ]);
    expect(env).toBe(pending);
  });

  it('leaves a valueFrom.secretRef alone — that key resolves through mergeAppEnv already', () => {
    const env = materializeDeclaredSecrets(
      [],
      [
        {
          name: 'API_KEY',
          secret: true,
          valueFrom: { secretRef: 'other-secret/KEY' },
        },
      ],
    );
    expect(env).toEqual([]);
  });

  it('never manufactures a placeholder for a plain (non-secret) key', () => {
    const env = materializeDeclaredSecrets([], [{ name: 'MODE' }]);
    expect(env).toEqual([]);
  });
});
