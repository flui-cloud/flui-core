/**
 * MCP scope catalog and tier model. Scopes are the unit an agent token is
 * granted; tiers (read → plan → write → destructive) order them by blast radius.
 * Default-deny: a tool runs only if its scope is in the principal's granted set,
 * and destructive tools additionally require server-side enablement.
 *
 * ── What an `mcp:*` scope decides, and what it does not ────────────────────
 *
 * **It is a visibility filter, not an authorization.** Every tool in the
 * catalogue now reaches the product by calling the Flui API over HTTP as the
 * caller (`McpApiClient`), so what a call is allowed to touch is decided by the
 * route it lands on: `AppAccessGuard`, the section and permission gates, and the
 * sandbox route fence. An `mcp:*` scope decides only which tools are OFFERED to
 * a given credential — it can hide a tool, it can never grant one anything.
 *
 * That is why the two vocabularies are not merged. `mcp:app:write` and
 * `IAM_PERMISSION.APP_WRITE` are not two maps of one boundary any more: IAM
 * draws the boundary, and this catalogue decides how much of the toolbox a
 * particular agent credential is handed. A key scoped to reads stays a
 * read-only key even for an administrator, which is a real and separate
 * property — least privilege on the credential, on top of the authorization
 * that applies regardless.
 *
 * The consequence for anyone reading a refusal: the two are worded differently
 * on purpose. "missing required scope" means the tool was never handed to you
 * (a grant problem, fixed by re-issuing the credential); "Refused by Flui
 * access control" means you hold the tool but not this resource (a permission
 * problem, fixed by IAM). See `runGated` and `McpApiError.agentMessage`.
 *
 * Decided 2026-08-21: the catalogue is NOT split into finer
 * scopes, and `mcp:*` is not absorbed into IAM. Both were considered; the split
 * buys ergonomics, not safety, and a second hand-written map of the same
 * boundary is the thing this project has learned to avoid.
 */
export const MCP_SCOPE = {
  CATALOG_READ: 'mcp:catalog:read',
  APP_READ: 'mcp:app:read',
  OBS_READ: 'mcp:obs:read',
  BACKUP_READ: 'mcp:backup:read',
  MIGRATION_READ: 'mcp:migration:read',
  // Recipient addresses are personal data, so mail is its own scope rather than
  // part of obs:read — an agent granted logs does not thereby get everyone's email.
  MAIL_READ: 'mcp:mail:read',
  // Who can reach what, and what a change to it would take away. Read-only by
  // construction: its `allows` names `iam:read-access` and nothing that writes,
  // so a credential carrying it can describe the grant graph and never edit it.
  IAM_READ: 'mcp:iam:read',
  /**
   * Conferring and revoking a delegation — the one scope this catalogue holds
   * that changes who else can reach the instance.
   *
   * It is not in any tier list below, and that is the whole of decision 91's
   * condition: `expandTier` is what a principal gets when its credential
   * declares no ceiling of its own, so a scope named there arrives by
   * *omission* — an administrator's unscoped key, or the dashboard assistant,
   * would carry it without anybody having decided to hand it over. Switching it
   * on has to be a gesture, so the only ways to hold it are naming it outright
   * or switching on the one group that carries it (`access:change`).
   *
   * The guarantee that makes it safe is not written here and does not need to
   * be: `POST/DELETE /iam/grants` ask for `iam:assign-role`, and a key is never
   * worth more than whoever minted it, so an agent cannot confer a permission
   * its owner does not already hold.
   */
  IAM_WRITE: 'mcp:iam:write',
  SPEC_VALIDATE: 'mcp:spec:validate',
  APP_WRITE: 'mcp:app:write',
  BACKUP_WRITE: 'mcp:backup:write',
  MIGRATION_WRITE: 'mcp:migration:write',
  APP_DESTRUCTIVE: 'mcp:app:destructive',
  MIGRATION_DESTRUCTIVE: 'mcp:migration:destructive',
} as const;

export type McpScope = (typeof MCP_SCOPE)[keyof typeof MCP_SCOPE];

export type McpTier = 'read' | 'plan' | 'write' | 'destructive';

/**
 * The scopes that make up each tier (a tier grants every scope at or below it).
 *
 * Not every scope is in here, and the omission is load-bearing rather than an
 * oversight: a tier is what a credential gets when it declares nothing of its
 * own, so anything listed below is reachable by silence. `mcp:iam:write` is
 * deliberately absent from all four — see the note on it in `MCP_SCOPE` and
 * `iam-write-scope.spec.ts`, which pins the absence so it cannot be "fixed" by
 * somebody tidying the table.
 */
export const TIER_SCOPES: Record<McpTier, McpScope[]> = {
  read: [
    MCP_SCOPE.CATALOG_READ,
    MCP_SCOPE.APP_READ,
    MCP_SCOPE.OBS_READ,
    MCP_SCOPE.BACKUP_READ,
    MCP_SCOPE.MIGRATION_READ,
    MCP_SCOPE.MAIL_READ,
    MCP_SCOPE.IAM_READ,
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
  [MCP_SCOPE.MAIL_READ]: 'read',
  [MCP_SCOPE.IAM_READ]: 'read',
  // `write` and not `destructive`: the criterion is irreversibility, not the
  // HTTP verb (decision 86). A grant removed is a grant that can be made again,
  // and `MCP_ALLOW_DESTRUCTIVE` is a server-wide switch about tearing things
  // down — coupling access administration to it would answer two unrelated
  // questions with one flag. What `write` does buy is the in-product
  // assistant's approval step, which pauses before every write-tier tool.
  [MCP_SCOPE.IAM_WRITE]: 'write',
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
