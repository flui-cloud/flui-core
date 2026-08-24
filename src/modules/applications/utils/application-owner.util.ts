/**
 * The owner an application may record, out of the principal that created it.
 *
 * `applications.userId` names a row in `users` — that is what a foreign key
 * with `ON DELETE SET NULL` now says out loud. But not every authenticated
 * principal is a row: a service credential authenticates as a *declared*
 * identity (`cli-bootstrap`, `cli-service-account`, and the legacy
 * `service-account` sentinel before them), which by design has no `users` row
 * and never will. Writing that name into the column produced an owner that
 * resolves to nobody on every application the install credential created —
 * measured on the live instance, one of the two dangling owners was exactly
 * that, in namespace `user-cli`.
 *
 * So the rule is total and matches the column's domain: an id that could not be
 * a `users.id` is not an owner, and the honest record is *no owner* rather than
 * a name that points at nothing. `matchesSelector` already treats a missing
 * owner as "never matches", so the honest state and the safe state coincide.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ownerUserIdFor(
  principalUserId: string | null | undefined,
): string | null {
  if (!principalUserId) return null;
  return UUID.test(principalUserId) ? principalUserId : null;
}
