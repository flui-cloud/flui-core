import { SectionAccess } from '../constants/iam-sections';
import { IamPrincipal, PrincipalAccess, ResourceAttributes } from './iam.types';

export const POLICY_ENGINE = 'POLICY_ENGINE';

/**
 * Authorization contract. SQL-backed today; swappable behind this token later
 * (mirrors the IIdentityDirectory pattern).
 *
 * - `check(principal, action, resource?)` — point check. Without `resource` it
 *   is a coarse "has this action anywhere" gate (back-compat for un-resolved
 *   @RequirePermission routes); with `resource` it honours scoped grants.
 * - `resolveAccess` + `can` — resolve once (one DB read), then evaluate many
 *   resources in memory for list filtering.
 * - `resolveSections` — which portal sections the principal may enter (derived,
 *   scope-aware; management sections need the governing permission at GLOBAL
 *   scope). Drives `@RequireSection` gating and the dashboard sidebar.
 * - `resolveSectionAccess` — the same, with the level: a section reached
 *   through its read-only entry key is enterable but refuses every unsafe verb.
 */
export interface PolicyEngine {
  getEffectivePermissions(principal: IamPrincipal): Promise<string[]>;
  resolveSections(principal: IamPrincipal): Promise<string[]>;
  resolveSectionAccess(principal: IamPrincipal): Promise<SectionAccess[]>;
  check(
    principal: IamPrincipal,
    action: string,
    resource?: ResourceAttributes,
  ): Promise<boolean>;
  resolveAccess(principal: IamPrincipal): Promise<PrincipalAccess>;
  can(
    access: PrincipalAccess,
    action: string,
    resource?: ResourceAttributes,
  ): boolean;
  permissionsOn(
    access: PrincipalAccess,
    resource: ResourceAttributes,
  ): Set<string>;
}
