import { OidcIdentityDirectory } from './oidc-identity-directory.service';

/**
 * The provider enforces one character per class. A uniform draw from the pooled
 * alphabet satisfied that only most of the time, so user creation failed
 * intermittently with "Password must contain symbol" — a coin flip the sandbox
 * cannot afford once it provisions guests unattended.
 */
describe('OidcIdentityDirectory password generation', () => {
  const generate = (): string =>
    (
      OidcIdentityDirectory.prototype as unknown as {
        generatePassword: () => string;
      }
    ).generatePassword.call(null);

  const samples = Array.from({ length: 500 }, generate);

  it('always satisfies every character class the provider requires', () => {
    for (const pw of samples) {
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*]/);
    }
  });

  it('keeps the 16-character length', () => {
    for (const pw of samples) expect(pw).toHaveLength(16);
  });

  it('does not park the guaranteed classes in fixed positions', () => {
    const firstChars = new Set(samples.map((pw) => pw[0]));
    expect(firstChars.size).toBeGreaterThan(4);
  });

  it('does not repeat itself', () => {
    expect(new Set(samples).size).toBe(samples.length);
  });
});
