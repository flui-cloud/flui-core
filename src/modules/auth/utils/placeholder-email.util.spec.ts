import { isPlaceholderEmail } from './placeholder-email.util';

describe('isPlaceholderEmail', () => {
  it('knows the address of a person the provider has not proven yet', () => {
    expect(isPlaceholderEmail('oidc-123@flui.invalid')).toBe(true);
  });

  it('knows the address of a demo visitor', () => {
    expect(isPlaceholderEmail('visitor-1a2b3c4d@visitors.invalid')).toBe(true);
  });

  it('takes a real address for a mailbox', () => {
    expect(isPlaceholderEmail('mario@example.com')).toBe(false);
    expect(isPlaceholderEmail('visitor@visitors.invalid.example.com')).toBe(
      false,
    );
    expect(isPlaceholderEmail(null)).toBe(false);
  });
});
