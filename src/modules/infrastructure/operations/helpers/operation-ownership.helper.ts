import { AuthenticatedUser } from '../../../auth/interfaces/authenticated-user.interface';
import { SECTION } from '../../../iam/constants/iam-sections';
import { PolicyEngine } from '../../../iam/interfaces/policy-engine.interface';

/**
 * Whose operation is this?
 *
 * The one rule, written once, because it is asked from two doors: the HTTP
 * route and the WebSocket room that streams the same progress, completion and
 * failure events. Closing one and leaving the other open moves a hole rather
 * than filling it, and two copies of a rule drift.
 *
 * The section permission answers "may you enter this area", never "is this
 * yours" — and a sandbox guest enters it read-only, which is how an id alone
 * used to be enough to follow anybody's provisioning. Ownership is asked here
 * instead: the operation is yours, or you run the instance.
 *
 * An operation with no recorded owner belongs to nobody and is therefore
 * refused to everybody but an operator.
 */
export async function mayReadOperation(
  policy: PolicyEngine,
  operation: { userId?: string | null } | null | undefined,
  user: AuthenticatedUser | undefined,
): Promise<boolean> {
  if (!user || !operation) return false;
  if (user.isAdmin) return true;
  if (operation.userId && operation.userId === user.userId) return true;
  const sections = await policy.resolveSectionAccess({
    userId: user.userId,
    email: user.email,
    role: user.role,
    isAdmin: false,
    scopes: user.scopes,
  });
  return (
    sections.find((s) => s.key === SECTION.INFRASTRUCTURE)?.level === 'full'
  );
}
