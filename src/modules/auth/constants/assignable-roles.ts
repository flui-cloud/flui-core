import { IdentityRole } from '../entities/user.entity';

/**
 * The roles `PATCH /auth/users/:id/role` may confer.
 *
 * `admin` is absent on purpose. That route runs on `iam:assign-role`, a
 * permission the built-in `manager` role holds — so any input type that still
 * contained `admin` would let a manager promote anyone, itself included, to
 * platform administrator. In OIDC mode the promotion is durable: the strategy
 * re-derives `isAdmin` from the claim on every request.
 *
 * The closure is the absence rather than a check, because a check reads as
 * redundant to whoever meets it next. Widening this list means changing a type
 * that both the DTO and `UserManagementService.setRole` are written against.
 *
 * Conferring platform admin still exists — `POST /auth/users` with
 * `role: admin`, behind `AdminGuard`.
 */
export const ASSIGNABLE_IDENTITY_ROLES = [
  IdentityRole.USER,
  IdentityRole.READONLY,
] as const;

export type AssignableIdentityRole = (typeof ASSIGNABLE_IDENTITY_ROLES)[number];
