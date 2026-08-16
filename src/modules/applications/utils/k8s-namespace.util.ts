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
