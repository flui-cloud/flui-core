import { InternalServerErrorException } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Derives a Kubernetes namespace name from a user's email address.
 *
 * Uses the local part (before @) of the email, sanitized to comply with
 * K8s namespace naming rules: lowercase alphanumeric and hyphens, max 63 chars.
 *
 * Examples:
 *   "dawit@example.com"       → "user-dawit"
 *   "dawit.work@example.com"  → "user-dawit-work"
 *   "my_user+tag@example.com" → "user-my-user-tag"
 */
export function buildUserNamespace(email: string): string {
  const localPart = email.split('@')[0];
  const sanitized = localPart
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')
    .slice(0, 57)
    .replaceAll(/-$/g, '');

  // A local part made only of symbols ("_@x.com") sanitizes to nothing, which
  // would yield the invalid namespace "user-". The digest keeps the name both
  // valid and stable, since callers recompute it from the email every time.
  if (!sanitized) {
    return `user-${createHash('sha256').update(email).digest('hex').slice(0, 10)}`;
  }
  return `user-${sanitized}`;
}

export const NAMESPACE_OWNER_UNKNOWN_ERROR_CODE = 'NAMESPACE_OWNER_UNKNOWN';

/**
 * The namespace an application created by this caller must land in.
 *
 * There is no fallback on purpose. `default` is a namespace no tenancy owns,
 * and everything that makes a tenant a tenant hangs off the namespace of the
 * row: the `ResourceQuota` and `LimitRange` applied to it, the `NetworkPolicy`
 * that isolates it, the `noindex` middleware, the sandbox branch of
 * `EndpointHostGuardService` (which asks `sandboxTenants.exists({clusterId,
 * namespace})` before it constrains a hostname), and the expiry sweep, which
 * deletes by `k8sNamespace`. An application quietly placed in `default` keeps
 * running after the tenancy that asked for it is gone.
 *
 * Every authenticated principal carries an email — interactive users, OIDC
 * subjects (synthesised as `oidc-<sub>@flui.invalid`) and the declared service
 * identities alike — so an absent one is a caller that dropped it on the way
 * down, not a caller that never had one. That is a server defect and is
 * reported as one.
 */
export function ownerNamespaceFor(
  userEmail: string | undefined | null,
): string {
  if (!userEmail) {
    throw new InternalServerErrorException({
      statusCode: 500,
      code: NAMESPACE_OWNER_UNKNOWN_ERROR_CODE,
      message:
        'Cannot place an application: the caller carries no email, so the ' +
        'owning namespace cannot be derived. This is a wiring defect in the ' +
        'creating code path, not something the request can fix.',
    });
  }
  return buildUserNamespace(userEmail);
}
