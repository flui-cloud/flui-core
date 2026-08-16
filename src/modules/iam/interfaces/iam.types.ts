import { IdentityRole } from '../../auth/entities/user.entity';

export type IamPrincipalType = 'user' | 'group' | 'service_account';

export type IamScopeType = 'global' | 'section' | 'cluster' | 'selector';

/**
 * Closed attribute set (AND-ed). `kind` is an OPEN STRING (the app taxonomy is
 * evolving) — matched against live app kinds, never a frozen enum.
 */
export interface IamSelector {
  slugs?: string[];
  type?: 'system' | 'user';
  kind?: string;
  clusterId?: string;
  clusterName?: string;
  provider?: string;
  project?: string;
  tags?: string[];
  /**
   * The owning user's id. The only selector that follows the resource instead of
   * describing where it sits: an app created by this principal matches it the
   * moment it exists, with nothing to assign afterwards. Without it a tenant can
   * be given apps but cannot make one — its own creation lands outside every
   * grant it holds.
   */
  owner?: string;
}

/** The principal the PolicyEngine reasons over, derived from `req.user`. */
export interface IamPrincipal {
  userId: string;
  email: string;
  role: IdentityRole;
  isAdmin: boolean;
  scopes?: string[];
}

/**
 * The attributes of a concrete resource a scoped grant is evaluated against.
 * Mirrors {@link IamSelector}: `type` = ApplicationCategory (system|user),
 * `kind` = ApplicationKind, the rest map to app/cluster columns. All optional —
 * a missing attribute simply never matches a selector that constrains it.
 */
export interface ResourceAttributes {
  slug?: string;
  type?: 'system' | 'user';
  kind?: string;
  clusterId?: string;
  clusterName?: string;
  provider?: string;
  project?: string;
  tags?: string[];
  owner?: string | null;
}

/** One scoped grant's contribution: which permissions, at which scope. */
export interface ScopedGrant {
  permissions: ReadonlySet<string>;
  scopeType: IamScopeType;
  scopeRef: string | null;
  selector: IamSelector | null;
}

/**
 * A principal's resolved access, computed once (one DB read) and then evaluated
 * against many resources in memory. `globalPermissions` is the resource-independent
 * floor (IdP coarse role + any global RoleBindings); `scopedGrants` apply only
 * where their scope matches a resource.
 */
export interface PrincipalAccess {
  isAdmin: boolean;
  globalPermissions: ReadonlySet<string>;
  scopedGrants: ScopedGrant[];
  /** True when any binding carries the sandbox role — see SandboxFenceGuard. */
  isSandbox: boolean;
}
