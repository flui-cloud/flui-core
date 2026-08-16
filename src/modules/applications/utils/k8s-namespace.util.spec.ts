import { buildUserNamespace } from './k8s-namespace.util';
import { isValidNamespaceName } from './reserved-namespace.util';

describe('buildUserNamespace', () => {
  it.each([
    ['dawit@example.com', 'user-dawit'],
    ['dawit.work@example.com', 'user-dawit-work'],
    ['my_user+tag@example.com', 'user-my-user-tag'],
  ])('derives %s → %s', (email, expected) => {
    expect(buildUserNamespace(email)).toBe(expected);
  });

  it('always produces a name Kubernetes accepts', () => {
    const emails = [
      'dawit@example.com',
      '_@example.com',
      '+++@example.com',
      '-lead-@example.com',
      `${'a'.repeat(80)}@example.com`,
      `${'a'.repeat(56)}-b@example.com`,
    ];
    for (const email of emails) {
      expect(isValidNamespaceName(buildUserNamespace(email))).toBe(true);
    }
  });

  it('is deterministic for a local part that sanitizes to nothing', () => {
    expect(buildUserNamespace('_@example.com')).toBe(
      buildUserNamespace('_@example.com'),
    );
    expect(buildUserNamespace('_@example.com')).not.toBe(
      buildUserNamespace('+@example.com'),
    );
  });
});
