import { passwordRequirements, unmetRequirements } from './password-rules';

const strict = {
  minLength: 10,
  requiresUppercase: true,
  requiresLowercase: true,
  requiresNumber: true,
  requiresSymbol: true,
};

describe('password rules', () => {
  it('lists only what the policy asks for', () => {
    expect(
      passwordRequirements({
        ...strict,
        requiresSymbol: false,
        requiresUppercase: false,
      }).map((r) => r.rule),
    ).toEqual(['min-length', 'lowercase', 'number']);
    expect(passwordRequirements(strict)[0].label).toBe(
      'At least 10 characters',
    );
  });

  it('names exactly the requirements a password misses', () => {
    expect(unmetRequirements('short', strict).map((r) => r.rule)).toEqual([
      'min-length',
      'uppercase',
      'number',
      'symbol',
    ]);
    expect(unmetRequirements('Längeres-Wort9', strict)).toEqual([]);
  });
});
