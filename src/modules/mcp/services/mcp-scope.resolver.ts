import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { DEFAULT_SCOPES, expandTier } from '../constants/mcp-scopes';

/**
 * Resolves a principal's effective MCP scopes, issuer-agnostically. Scopes can
 * arrive from any credential the auth layer already populates:
 *   - an API key's `scopes` column or a token `scope` claim → `user.scopes`,
 *   - Zitadel project roles named `mcp:*`                   → `user.roles` keys.
 *
 * Precedence:
 *   1. Explicit `mcp:*` grants on the credential win — a scoped API key stays
 *      least-privilege even for an admin.
 *   2. Otherwise a platform admin (the interactive dashboard owner) gets the full
 *      tier; write still pauses for confirmation and destructive is still gated by
 *      MCP_ALLOW_DESTRUCTIVE, so this is capability, not a bypass.
 *   3. Everyone else gets the safe default (read + plan only).
 */
@Injectable()
export class McpScopeResolver {
  /**
   * A sandbox guest gets nothing at all, deliberately.
   *
   * The tools do not call the API — they call the services directly, in process,
   * so neither the sandbox route fence nor the per-application guards are in the
   * path. Handing a guest even the read tier would therefore hand it the whole
   * platform, which is precisely the lock-pick the sandbox fence exists to
   * prevent. Turning this on is a piece of work per tool (each app-scoped tool
   * asserting ownership), not a scope to widen here.
   */
  resolve(user: AuthenticatedUser, isSandbox = false): Set<string> {
    if (isSandbox) return new Set<string>();

    const explicit = new Set<string>();
    for (const scope of user.scopes ?? []) {
      if (scope.startsWith('mcp:')) explicit.add(scope);
    }
    for (const roleKey of Object.keys(user.roles ?? {})) {
      if (roleKey.startsWith('mcp:')) explicit.add(roleKey);
    }
    if (explicit.size > 0) return explicit;
    if (user.isAdmin) return new Set<string>(expandTier('destructive'));
    return new Set<string>(DEFAULT_SCOPES);
  }
}
