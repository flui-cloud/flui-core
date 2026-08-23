import { JWT_SECRET_PLACEHOLDER, resolveJwtSecret } from './jwt-secret.util';

const config = (values: Record<string, string | undefined>) => ({
  get: <T = string>(key: string) => values[key] as T | undefined,
});

describe('resolveJwtSecret — AUTH_MODE=local refuses to start without one', () => {
  it('refuses when the variable is absent', () => {
    expect(() => resolveJwtSecret(config({ AUTH_MODE: 'local' }))).toThrow(
      /JWT_SECRET is not set/,
    );
  });

  it('refuses the published placeholder just as hard as an absence', () => {
    expect(() =>
      resolveJwtSecret(
        config({ AUTH_MODE: 'local', JWT_SECRET: JWT_SECRET_PLACEHOLDER }),
      ),
    ).toThrow(/placeholder/);
  });

  it('refuses a value that is only whitespace', () => {
    expect(() =>
      resolveJwtSecret(config({ AUTH_MODE: 'local', JWT_SECRET: '   ' })),
    ).toThrow(/JWT_SECRET is not set/);
  });

  it('accepts a real secret', () => {
    expect(
      resolveJwtSecret(config({ AUTH_MODE: 'local', JWT_SECRET: 's3cret' })),
    ).toBe('s3cret');
  });

  it('is case-insensitive about the mode', () => {
    expect(() => resolveJwtSecret(config({ AUTH_MODE: 'LOCAL' }))).toThrow();
  });
});

describe('resolveJwtSecret — the other modes survive, but never on the published string', () => {
  it('never hands back the placeholder', () => {
    const resolved = resolveJwtSecret(
      config({ AUTH_MODE: 'oidc', JWT_SECRET: JWT_SECRET_PLACEHOLDER }),
    );
    expect(resolved).not.toBe(JWT_SECRET_PLACEHOLDER);
    expect(resolved.length).toBeGreaterThanOrEqual(32);
  });

  it('is stable within a process, so the four call sites agree', () => {
    const a = resolveJwtSecret(config({ AUTH_MODE: 'oidc' }));
    const b = resolveJwtSecret(config({ AUTH_MODE: '' }));
    expect(a).toBe(b);
  });

  it('still prefers a configured secret', () => {
    expect(
      resolveJwtSecret(
        config({ AUTH_MODE: 'oidc', JWT_SECRET: 'x'.repeat(64) }),
      ),
    ).toBe('x'.repeat(64));
  });
});
