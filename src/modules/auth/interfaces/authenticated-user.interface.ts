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
}
