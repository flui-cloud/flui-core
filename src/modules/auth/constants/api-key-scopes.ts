import {
  IAM_PERMISSION,
  IamPermission,
} from '../../iam/constants/iam-permissions';
import { MCP_SCOPE, McpScope } from '../../mcp/constants/mcp-scopes';

/**
 * The ceiling on what an API key may be granted.
 *
 * A key is issued by somebody, and it must never be worth more than they are:
 * for every scope, the issuer has to hold the permission named here — checked
 * against the same policy engine that guards the equivalent screen. A request
 * for more is refused whole, never trimmed down to what happens to be allowed,
 * because a credential that quietly comes back smaller than asked for is a
 * credential nobody can reason about.
 *
 * Where a scope has no permission of its own, it is pinned to the permission
 * that governs the section the same data is shown in — mail and backups are
 * `cluster:manage` for that reason, not because they are cluster work.
 */
export const SCOPE_REQUIRES_PERMISSION: Record<McpScope, IamPermission> = {
  [MCP_SCOPE.CATALOG_READ]: IAM_PERMISSION.APP_READ,
  [MCP_SCOPE.APP_READ]: IAM_PERMISSION.APP_READ,
  [MCP_SCOPE.OBS_READ]: IAM_PERMISSION.APP_READ,
  [MCP_SCOPE.BACKUP_READ]: IAM_PERMISSION.CLUSTER_MANAGE,
  [MCP_SCOPE.MIGRATION_READ]: IAM_PERMISSION.MIGRATION_EXECUTE,
  [MCP_SCOPE.MAIL_READ]: IAM_PERMISSION.CLUSTER_MANAGE,
  [MCP_SCOPE.SPEC_VALIDATE]: IAM_PERMISSION.APP_READ,
  [MCP_SCOPE.APP_WRITE]: IAM_PERMISSION.APP_WRITE,
  [MCP_SCOPE.BACKUP_WRITE]: IAM_PERMISSION.CLUSTER_MANAGE,
  [MCP_SCOPE.MIGRATION_WRITE]: IAM_PERMISSION.MIGRATION_EXECUTE,
  [MCP_SCOPE.APP_DESTRUCTIVE]: IAM_PERMISSION.APP_DELETE,
  [MCP_SCOPE.MIGRATION_DESTRUCTIVE]: IAM_PERMISSION.MIGRATION_EXECUTE,
};

export const GRANTABLE_SCOPES: McpScope[] = Object.keys(
  SCOPE_REQUIRES_PERMISSION,
) as McpScope[];

export function isGrantableScope(scope: string): scope is McpScope {
  return scope in SCOPE_REQUIRES_PERMISSION;
}

/**
 * The canonical order above, applied to a set of scopes.
 *
 * A key asked for by group is assembled from several lists, so without this the
 * stored column would carry the order the request happened to arrive in — and
 * two identical grants would read as two different credentials.
 */
export function orderScopes(scopes: string[]): McpScope[] {
  return GRANTABLE_SCOPES.filter((s) => scopes.includes(s));
}
