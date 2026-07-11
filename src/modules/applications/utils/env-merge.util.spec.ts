import { mergeAppEnv } from './env-merge.util';
import { ApplicationEnvVar } from '../interfaces/source-config.interface';

const names = (env: ApplicationEnvVar[]) => env.map((e) => e.name).sort();
const byName = (env: ApplicationEnvVar[], n: string) =>
  env.find((e) => e.name === n);

describe('mergeAppEnv', () => {
  it('preserves a user var not declared by the manifest (the core requirement)', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'DATABASE_URL', value: 'postgres://…', source: 'user' },
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
    ];
    const manifest: ApplicationEnvVar[] = [
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
      { name: 'PWA_BASE_URL', value: 'https://x', source: 'manifest' },
    ];
    const out = mergeAppEnv(existing, manifest);
    expect(names(out)).toEqual(['DATABASE_URL', 'NODE_ENV', 'PWA_BASE_URL']);
    expect(byName(out, 'DATABASE_URL')?.value).toBe('postgres://…');
  });

  it('lets a manifest value update its own key but not a user key', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'NODE_ENV', value: 'staging', source: 'manifest' },
      { name: 'API_KEY', value: 'k', source: 'user' },
    ];
    const manifest: ApplicationEnvVar[] = [
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
      { name: 'API_KEY', value: 'from-manifest', source: 'manifest' },
    ];
    const out = mergeAppEnv(existing, manifest);
    expect(byName(out, 'NODE_ENV')?.value).toBe('production');
    expect(byName(out, 'API_KEY')?.value).toBe('k'); // user wins
  });

  it('preserves a legacy untagged link (externalSecretRef) even if the manifest names it', () => {
    const existing: ApplicationEnvVar[] = [
      {
        name: 'DB_PASSWORD',
        value: '',
        externalSecretRef: {
          secretName: 'pg-secret',
          key: 'POSTGRES_PASSWORD',
        },
      },
    ];
    const manifest: ApplicationEnvVar[] = [
      { name: 'DB_PASSWORD', value: 'oops-plain', source: 'manifest' },
    ];
    const out = mergeAppEnv(existing, manifest);
    expect(byName(out, 'DB_PASSWORD')?.externalSecretRef).toEqual({
      secretName: 'pg-secret',
      key: 'POSTGRES_PASSWORD',
    });
  });

  it('adopts a legacy untagged plain var into the manifest when the manifest declares it', () => {
    const existing: ApplicationEnvVar[] = [{ name: 'NODE_ENV', value: 'old' }];
    const manifest: ApplicationEnvVar[] = [
      { name: 'NODE_ENV', value: 'new', source: 'manifest' },
    ];
    const out = mergeAppEnv(existing, manifest);
    expect(byName(out, 'NODE_ENV')?.value).toBe('new');
  });

  it('overrides upsert as user and win every collision', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
    ];
    const manifest: ApplicationEnvVar[] = [
      { name: 'NODE_ENV', value: 'production', source: 'manifest' },
    ];
    const out = mergeAppEnv(existing, manifest, { NODE_ENV: 'debug' });
    const v = byName(out, 'NODE_ENV');
    expect(v?.value).toBe('debug');
    expect(v?.source).toBe('user');
  });
});
