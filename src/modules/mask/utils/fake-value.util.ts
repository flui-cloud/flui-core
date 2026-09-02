import { createHmac } from 'node:crypto';
import { Sensitivity } from '../constants/sensitivity';

export interface MaskSessionContext {
  /** `AuthenticatedUser.userId`, this app's stand-in for the JWT `sub` claim. */
  sub: string;
  /**
   * `AuthenticatedUser.iat`. Undefined for a request authenticated without a
   * decoded token — treated as one fixed session bucket rather than a
   * per-request-random one, so fakes stay internally consistent within it.
   */
  iat?: number;
}

/**
 * Never realistic, on purpose: a realistic-looking fake credential implies
 * validity and invites someone to try it. Identical for every credential
 * field, session and real value, so there is nothing to correlate.
 */
export const CREDENTIAL_PLACEHOLDER = '•••• hidden — mask mode is on ••••';

type SubstitutableSensitivity =
  | Sensitivity.NETWORK_IDENTIFIER
  | Sensitivity.TENANT_IDENTITY;

function sessionDigest(
  saltSecret: string,
  session: MaskSessionContext,
  realValue: string,
): Buffer {
  const material = `${session.sub}:${session.iat ?? 0}:${realValue}`;
  return createHmac('sha256', saltSecret).update(material).digest();
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4}){2,7}$/;

const isIpv4 = (value: string): boolean => IPV4_RE.test(value.trim());
const isIpv6 = (value: string): boolean =>
  value.includes(':') && IPV6_RE.test(value.trim());

/**
 * A same-family fake: RFC 5737 `203.0.113.0/24` for IPv4, RFC 3849
 * `2001:db8::/32` for IPv6 — both reserved for documentation and never
 * routable, so a fake can never land on a real host. A value of neither shape
 * (an internal hostname) falls back to the `.invalid` TLD (RFC 2606) rather
 * than passing through unmasked.
 */
function fakeNetworkIdentifier(
  saltSecret: string,
  session: MaskSessionContext,
  realValue: string,
): string {
  const hash = sessionDigest(saltSecret, session, realValue);

  if (isIpv4(realValue)) {
    return `203.0.113.${hash[0] % 256}`;
  }

  if (isIpv6(realValue)) {
    const groups: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      groups.push(
        hash
          .readUInt16BE(i * 2)
          .toString(16)
          .padStart(4, '0'),
      );
    }
    return `2001:db8:${groups.join(':')}`;
  }

  return `host-${hash.toString('hex').slice(0, 12)}.mask.invalid`;
}

/**
 * A plausible fake identity, deterministic per session and per real value.
 * `@`-shape is the only signal available at this layer: an email gets an
 * email-shaped fake under RFC 2606's `example.com`, anything else a label.
 */
function fakeTenantIdentity(
  saltSecret: string,
  session: MaskSessionContext,
  realValue: string,
): string {
  const hex = sessionDigest(saltSecret, session, realValue)
    .toString('hex')
    .slice(0, 8);
  return realValue.includes('@') ? `user-${hex}@example.com` : `tenant-${hex}`;
}

/**
 * The one entry point `MaskResponseInterceptor` calls for a
 * `network-identifier` or `tenant-identity` field. `credential` uses
 * {@link CREDENTIAL_PLACEHOLDER} directly; `public` and `arbitrary-text` are
 * never substituted — raw log/stdout text has no field boundary to classify,
 * so mask mode makes no promise about it.
 */
export function fakeValueFor(
  sensitivity: SubstitutableSensitivity,
  realValue: string,
  session: MaskSessionContext,
  saltSecret: string,
): string {
  switch (sensitivity) {
    case Sensitivity.NETWORK_IDENTIFIER:
      return fakeNetworkIdentifier(saltSecret, session, realValue);
    case Sensitivity.TENANT_IDENTITY:
      return fakeTenantIdentity(saltSecret, session, realValue);
  }
}
