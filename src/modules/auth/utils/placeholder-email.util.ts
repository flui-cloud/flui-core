/**
 * The address a person carries in Flui until the identity provider has
 * proven theirs, and the one a demo visitor carries until it signs in. Never a
 * mailbox.
 */
export const PLACEHOLDER_EMAIL_RE =
  /^(?:oidc-.*@flui|visitor-[^@]+@visitors)\.invalid$/;

export const VISITOR_EMAIL_DOMAIN = 'visitors.invalid';

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && PLACEHOLDER_EMAIL_RE.test(email);
}
