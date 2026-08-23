import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { DEFAULT_SCOPES, McpScope, expandTier } from '../constants/mcp-scopes';
import { findPermissionGroup } from '../../auth/constants/api-key-groups';
import { mcpScopesOf } from '../../auth/utils/credential-ceiling.util';

/**
 * What a guest's agent is handed when its credential says nothing about scopes
 * — the dashboard session driving the assistant, and any key issued without
 * one. It is the `apps:change` group, by name and not by copy, because that is
 * the switch the person is shown when they connect an agent: deploy and operate
 * your own applications.
 *
 * Not the platform default (`read + plan`), which spans backups, migrations and
 * mail — areas a guest is shown an example of, and whose tools would come back
 * either refused or invented. The visibility filter would hide them anyway;
 * this keeps the two from disagreeing about why.
 */
const GUEST_DEFAULT_SCOPES: McpScope[] =
  findPermissionGroup('apps:change')?.scopes ?? [];

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
   * A sandbox guest used to get nothing at all, and the comment that stood here
   * said exactly why: the tools called the services in process, so neither the
   * route fence nor the per-application guards were anywhere in the path, and
   * any scope at all would have handed a guest the whole instance.
   *
   * That sentence is no longer true of a single tool. Every one of them now
   * reaches the product through `McpApiClient`, as the caller, so a guest's
   * request meets the fence and `AppAccessGuard` on the way in exactly as the
   * browser's does. The brake is the fence, not the scope — which is what makes
   * this safe to turn on, and why what is turned on is only a *default*: a
   * credential that names its own `mcp:*` scopes still wins, and it can only
   * name what the guest was allowed to confer in the first place
   * (`api-key-scopes.ts` refuses anything above the issuer's own permissions,
   * which for a guest is its own applications and nothing else).
   *
   * What the guest does NOT get is a wider toolbox than the fence can honour:
   * see `sandbox-tool-visibility.ts`, which is the other half of this change.
   */
  resolve(user: AuthenticatedUser, isSandbox = false): Set<string> {
    // One definition of "this credential declares a ceiling", shared with the
    // HTTP gate in `PermissionsGuard`: a second copy of the prefix rule here is
    // exactly how the toolbox and the API would come to disagree about what a
    // key is.
    const explicit = new Set<string>(mcpScopesOf(user));
    if (explicit.size > 0) return explicit;
    if (isSandbox) return new Set<string>(GUEST_DEFAULT_SCOPES);
    if (user.isAdmin) return new Set<string>(expandTier('destructive'));
    return new Set<string>(DEFAULT_SCOPES);
  }
}
