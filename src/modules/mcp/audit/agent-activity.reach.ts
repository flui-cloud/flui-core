import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ceilingWithholds } from '../../auth/utils/credential-ceiling.util';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { principalFromUser } from '../../iam/interfaces/iam.types';
import { PolicyEngine } from '../../iam/interfaces/policy-engine.interface';

/**
 * How far into the register this caller can see: their own rows, or the
 * instance's.
 */
export type ActivityReach = 'own' | 'instance';

/**
 * The rule, and it is deliberately not a new one.
 *
 * Two questions in the order `PermissionsGuard` asks them, because they have
 * different answers and different repairs:
 *
 *  - **the ceiling first.** A Flui key is issued *as* its principal and carries
 *    that principal's `isAdmin`, so `resolveAccess` answers "yes to everything"
 *    for an agent key an administrator minted. Asking IAM first would therefore
 *    hand every scoped agent credential the whole instance's register — the
 *    exact escalation `credentialCeiling` exists to prevent, on the one table
 *    that records what agents did. `mcp:iam:read` carries `iam:read-access` and
 *    passes; every other scope stops at its own rows;
 *  - **then IAM**, for the permission that already governs reading who can
 *    reach what. `iam:read-access` is held by `maintainer` and `owner` and by
 *    nobody below, which is the same line the product already draws around the
 *    grant graph. The register is the other half of that answer — not who *may*
 *    act, but who *did* — and inventing a permission for it would be a second
 *    vocabulary for one boundary.
 *
 * There is no third answer and no refusal. A caller who is not an operator sees
 * their own rows, which is what the panel needs, and somebody else's are absent
 * rather than forbidden: a 403 on a register is itself a disclosure, since it
 * confirms the row is there.
 */
export async function activityReach(
  policy: PolicyEngine,
  user: AuthenticatedUser,
): Promise<ActivityReach> {
  if (ceilingWithholds(user, IAM_PERMISSION.IAM_READ_ACCESS)) return 'own';
  const access = await policy.resolveAccess(principalFromUser(user));
  return policy.can(access, IAM_PERMISSION.IAM_READ_ACCESS)
    ? 'instance'
    : 'own';
}
