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
  if (operation.userId && operation.userId === user.userId) return true;
  return readsEveryOperation(policy, user);
}

/**
 * The instance half of {@link mayReadOperation}, on its own so a whole page can
 * be judged with one resolution instead of one per row.
 *
 * A register page carries up to two hundred rows, each possibly naming an
 * operation, and asking the ownership question row by row would resolve the
 * caller's sections two hundred times for an answer that cannot change inside
 * one request. Split rather than copied: the two entry points fold into the
 * same lines, so the rule stays one rule.
 */
export async function readsEveryOperation(
  policy: PolicyEngine,
  user: AuthenticatedUser | undefined,
): Promise<boolean> {
  if (!user) return false;
  if (user.isAdmin) return true;
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
