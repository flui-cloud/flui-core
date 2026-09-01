import { mergeAppEnv, collectEnvShadows } from './env-merge.util';
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

  it('reclaims a key it declares, overwriting a pinned user value (git is authoritative)', () => {
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
    expect(byName(out, 'API_KEY')?.value).toBe('from-manifest'); // manifest reclaims
    expect(byName(out, 'API_KEY')?.source).toBe('manifest');
  });

  it('surfaces the reclaim as a shadow (visibility, never silent)', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'API_URL', value: 'http://old.nip.io', source: 'user' },
    ];
    const manifest: ApplicationEnvVar[] = [
      { name: 'API_URL', value: 'https://api.flui.cloud', source: 'manifest' },
    ];
    const shadows = collectEnvShadows(existing, manifest);
    expect(shadows).toEqual([
      {
        name: 'API_URL',
        previous: 'http://old.nip.io',
        manifest: 'https://api.flui.cloud',
      },
    ]);
  });

  it('an explicit --env override re-asserts the user value and is not shadowed', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'API_URL', value: 'http://old.nip.io', source: 'user' },
    ];
    const manifest: ApplicationEnvVar[] = [
      { name: 'API_URL', value: 'https://api.flui.cloud', source: 'manifest' },
    ];
    const overrides = { API_URL: 'https://custom.example.com' };
    expect(collectEnvShadows(existing, manifest, overrides)).toEqual([]);
    const out = mergeAppEnv(existing, manifest, overrides);
    expect(byName(out, 'API_URL')?.value).toBe('https://custom.example.com');
    expect(byName(out, 'API_URL')?.source).toBe('user');
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

  // A declared key that resolves to nothing (userInput, unresolvable
  // valueFrom.service, malformed secretRef) is absent from the resolved list.
  // Without the declared-names set it read as "the manifest dropped this key".
  it('keeps a manifest-owned value the manifest declares without resolving (userInput)', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'API_URL', value: 'https://api.example.com', source: 'manifest' },
      { name: 'OIDC_ISSUER', value: 'https://auth.old', source: 'manifest' },
    ];
    // Only OIDC_ISSUER carries a literal; API_URL is valueFrom.userInput.
    const manifest: ApplicationEnvVar[] = [
      { name: 'OIDC_ISSUER', value: 'https://auth.new', source: 'manifest' },
    ];
    const out = mergeAppEnv(existing, manifest, undefined, [
      'API_URL',
      'OIDC_ISSUER',
    ]);
    expect(names(out)).toEqual(['API_URL', 'OIDC_ISSUER']);
    expect(byName(out, 'API_URL')?.value).toBe('https://api.example.com');
    expect(byName(out, 'OIDC_ISSUER')?.value).toBe('https://auth.new');
  });

  it('still removes a manifest-owned key the manifest stopped declaring', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'RETIRED', value: 'x', source: 'manifest' },
      { name: 'KEPT', value: 'y', source: 'manifest' },
    ];
    const manifest: ApplicationEnvVar[] = [
      { name: 'KEPT', value: 'y', source: 'manifest' },
    ];
    const out = mergeAppEnv(existing, manifest, undefined, ['KEPT']);
    expect(names(out)).toEqual(['KEPT']);
  });

  it('keeps a user pin on a declared-but-unresolved key (vops-ops today)', () => {
    const existing: ApplicationEnvVar[] = [
      { name: 'API_URL', value: 'http://nip.io', source: 'user' },
    ];
    const out = mergeAppEnv(existing, [], undefined, ['API_URL']);
    expect(byName(out, 'API_URL')?.value).toBe('http://nip.io');
  });

  it('marks an override named in secretNames as secret, `flui deploy --secret KEY`', () => {
    const out = mergeAppEnv(
      [],
      [],
      { DATABASE_URL: 'postgres://real', LOG_LEVEL: 'debug' },
      undefined,
      ['DATABASE_URL'],
    );
    expect(byName(out, 'DATABASE_URL')).toMatchObject({
      value: 'postgres://real',
      source: 'user',
      secret: true,
    });
    expect(byName(out, 'LOG_LEVEL')).toMatchObject({
      value: 'debug',
      source: 'user',
    });
    expect(byName(out, 'LOG_LEVEL')?.secret).toBeUndefined();
  });

  it('omitting secretNames stores every override as plain, unchanged default', () => {
    const out = mergeAppEnv([], [], { DATABASE_URL: 'postgres://real' });
    expect(byName(out, 'DATABASE_URL')?.secret).toBeUndefined();
  });
});
