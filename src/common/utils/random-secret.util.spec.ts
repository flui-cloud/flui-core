import { generateRandomSecret } from './random-secret.util';

describe('generateRandomSecret', () => {
  it('rejects a length below 8 or above 256', () => {
    expect(() => generateRandomSecret(7)).toThrow(/Invalid secret length/);
    expect(() => generateRandomSecret(257)).toThrow(/Invalid secret length/);
  });

  it('draws from [A-Za-z0-9] when format is omitted', () => {
    const value = generateRandomSecret(64);
    expect(value).toHaveLength(64);
    expect(value).toMatch(/^[A-Za-z0-9]+$/);
  });

  it('draws hex characters for format: hex', () => {
    const value = generateRandomSecret(32, 'hex');
    expect(value).toHaveLength(32);
    expect(value).toMatch(/^[a-f0-9]+$/);
  });

  it('draws base64url characters for format: base64url', () => {
    const value = generateRandomSecret(48, 'base64url');
    expect(value).toHaveLength(48);
    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is not deterministic', () => {
    expect(generateRandomSecret(32)).not.toBe(generateRandomSecret(32));
  });
});
