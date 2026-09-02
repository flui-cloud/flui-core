import { IdentityRole } from '../entities/user.entity';

export interface AuthenticatedUser {
  userId: string;
  email: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  displayName?: string | null;
  roles: Record<string, Record<string, string>>;
  role: IdentityRole;
  isAdmin?: boolean;
  /** OAuth-style granted scopes, when the credential carries them (API key / token claim). */
  scopes?: string[];
  /** Application ids this credential may act on. Undefined = every application the principal can already reach. */
  applicationIds?: string[];
  /** Project ids this credential may act on, alongside `applicationIds` rather than instead of it — the ceiling is their union. */
  projectIds?: string[];
  /**
   * The token's `iat` claim, when one was decoded. Paired with `userId` as
   * this app's proxy for "this login session": mask mode salts its fake
   * values with the pair, so a given login keeps the same fakes. A silent
   * token refresh changes `iat`, and with it the fakes.
   */
  iat?: number;
}
