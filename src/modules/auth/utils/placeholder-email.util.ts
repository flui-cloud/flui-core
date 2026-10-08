/**
 * The address a person carries in Flui until the identity provider has
 * proven theirs. Never a mailbox.
 */
export const PLACEHOLDER_EMAIL_RE = /^oidc-.*@flui\.invalid$/;

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && PLACEHOLDER_EMAIL_RE.test(email);
}
