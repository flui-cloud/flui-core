import {
  applyPlainVars,
  applySensitiveVars,
  plainEnvData,
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
