import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { PolicyEngine } from '../../iam/interfaces/policy-engine.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';

/**
 * Platform-level authority: held at GLOBAL scope, not merely held.
 *
 * A grant narrowed by a selector or to one cluster says what somebody may do
 * *there*; the platform's own components are not there, they are underneath.
 * `globalPermissions` is exactly the set IAM already separates for that reason.
 *
 * It lives here rather than inside {@link AppOwnershipGuard} because two gates
 * now ask it — that guard, for a row the platform declares, and
 * {@link PlatformAuthorityGuard}, for the foundations themselves — and the one
 * thing worse than a coarse rule is two copies of it drifting apart.
 *
 * The verb is `app:write` even on a GET, for the reason the ownership guard
 * gives: these gates are verb-blind, and what is behind them is credentials.
 * When each route names its own action this becomes that action at global
 * scope and the coarseness goes away on its own.
 */
export async function holdsPlatformAuthority(
  policy: PolicyEngine,
  user: AuthenticatedUser | undefined,
): Promise<boolean> {
  if (!user) return false;
  const access = await policy.resolveAccess(principalFromUser(user));
  return (
    access.isAdmin || access.globalPermissions.has(IAM_PERMISSION.APP_WRITE)
  );
}
