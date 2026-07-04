/**
 * MCP scope catalog and tier model. Scopes are the unit an agent token is
 * granted; tiers (read → plan → write → destructive) order them by blast radius.
 * Default-deny: a tool runs only if its scope is in the principal's granted set,
 * and destructive tools additionally require server-side enablement.
 */
export const MCP_SCOPE = {
  CATALOG_READ: 'mcp:catalog:read',
  APP_READ: 'mcp:app:read',
  OBS_READ: 'mcp:obs:read',
  BACKUP_READ: 'mcp:backup:read',
  MIGRATION_READ: 'mcp:migration:read',
  SPEC_VALIDATE: 'mcp:spec:validate',
  APP_WRITE: 'mcp:app:write',
  BACKUP_WRITE: 'mcp:backup:write',
  MIGRATION_WRITE: 'mcp:migration:write',
  APP_DESTRUCTIVE: 'mcp:app:destructive',
  MIGRATION_DESTRUCTIVE: 'mcp:migration:destructive',
} as const;

export type McpScope = (typeof MCP_SCOPE)[keyof typeof MCP_SCOPE];

export type McpTier = 'read' | 'plan' | 'write' | 'destructive';

/** The scopes that make up each tier (a tier grants every scope at or below it). */
export const TIER_SCOPES: Record<McpTier, McpScope[]> = {
  read: [
    MCP_SCOPE.CATALOG_READ,
    MCP_SCOPE.APP_READ,
    MCP_SCOPE.OBS_READ,
    MCP_SCOPE.BACKUP_READ,
    MCP_SCOPE.MIGRATION_READ,
  ],
  plan: [MCP_SCOPE.SPEC_VALIDATE],
  write: [
    MCP_SCOPE.APP_WRITE,
    MCP_SCOPE.BACKUP_WRITE,
    MCP_SCOPE.MIGRATION_WRITE,
  ],
  destructive: [MCP_SCOPE.APP_DESTRUCTIVE, MCP_SCOPE.MIGRATION_DESTRUCTIVE],
};

export const SCOPE_TIER: Record<McpScope, McpTier> = {
  [MCP_SCOPE.CATALOG_READ]: 'read',
  [MCP_SCOPE.APP_READ]: 'read',
  [MCP_SCOPE.OBS_READ]: 'read',
  [MCP_SCOPE.BACKUP_READ]: 'read',
  [MCP_SCOPE.MIGRATION_READ]: 'read',
  [MCP_SCOPE.SPEC_VALIDATE]: 'plan',
  [MCP_SCOPE.APP_WRITE]: 'write',
  [MCP_SCOPE.BACKUP_WRITE]: 'write',
  [MCP_SCOPE.MIGRATION_WRITE]: 'write',
  [MCP_SCOPE.APP_DESTRUCTIVE]: 'destructive',
  [MCP_SCOPE.MIGRATION_DESTRUCTIVE]: 'destructive',
};

/** Cumulative expansion: granting a tier implies every lower tier's scopes. */
const TIER_ORDER: McpTier[] = ['read', 'plan', 'write', 'destructive'];

export function expandTier(tier: McpTier): McpScope[] {
  const upTo = TIER_ORDER.slice(0, TIER_ORDER.indexOf(tier) + 1);
  return upTo.flatMap((t) => TIER_SCOPES[t]);
}

/** Safe default for an authenticated principal with no explicit grant: read + plan. */
export const DEFAULT_SCOPES: McpScope[] = expandTier('plan');
