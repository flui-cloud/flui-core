import {
  buildUserNamespace,
  ownerNamespaceFor,
  NAMESPACE_OWNER_UNKNOWN_ERROR_CODE,
} from './k8s-namespace.util';
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

/**
 * `ownerNamespaceFor` exists so that "no owner" cannot resolve to a namespace.
 * The value it must never produce is `default`: nothing owns it, so an
 * application placed there is outside its tenancy's `ResourceQuota`,
 * `LimitRange` and `NetworkPolicy`, outside the `noindex` middleware, outside
 * the sandbox branch of the hostname guard — and, worst, outside the expiry
 * sweep, which deletes by `k8sNamespace`. The row outlives the tenancy.
 */
describe('ownerNamespaceFor', () => {
  it('derives the same namespace as buildUserNamespace when there is an owner', () => {
    expect(ownerNamespaceFor('dawit@example.com')).toBe('user-dawit');
    expect(ownerNamespaceFor('guest-1f23@try.flui.cloud')).toBe(
      buildUserNamespace('guest-1f23@try.flui.cloud'),
    );
  });

  it.each([[undefined], [null], ['']])(
    'refuses %p instead of falling back to a namespace',
    (email) => {
      expect(() => ownerNamespaceFor(email)).toThrow();
    },
  );

  it.each([[undefined], [null], ['']])(
    'reports %p as a server defect, with a code a caller can key on',
    (email) => {
      let thrown: unknown;
      try {
        ownerNamespaceFor(email);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toMatchObject({
        status: 500,
        response: { code: NAMESPACE_OWNER_UNKNOWN_ERROR_CODE },
      });
    },
  );

  /**
   * The sentinel proper. If someone reinstates `userEmail ? … : 'default'`
   * anywhere on this path, the two tests above still pass for `null` only if
   * they were also edited — but this one names the forbidden value directly, so
   * a silent fallback of any spelling ('default', 'flui-apps', anything) shows
   * up as a returned string where a throw was required.
   */
  it.each([[undefined], [null], ['']])(
    'never returns a value for %p — least of all "default"',
    (email) => {
      let returned: string | undefined;
      try {
        returned = ownerNamespaceFor(email);
      } catch {
        returned = undefined;
      }
      expect(returned).toBeUndefined();
      expect(returned).not.toBe('default');
    },
  );
});
