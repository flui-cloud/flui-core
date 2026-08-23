import { SectionAccess } from '../constants/iam-sections';
import {
  IamBinding,
  IamPrincipal,
  PrincipalAccess,
  ResourceAttributes,
} from './iam.types';

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
 * - `bindingsFor` + `accessFrom` — the resolution taken apart, so the same
 *   engine answers the hypothetical question ("what would they reach if this
 *   binding were gone?") without a second derivation living beside it.
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
  /** Every binding that reaches this principal, own + service-account + group. */
  bindingsFor(principal: IamPrincipal): Promise<IamBinding[]>;
  /** The pure fold: a binding set in, a resolved access out. No IO. */
  accessFrom(bindings: IamBinding[], isAdmin?: boolean): PrincipalAccess;
  /** Sections derived from an access already resolved. */
  sectionAccessFrom(access: PrincipalAccess): SectionAccess[];
  /** Every permission an access carries somewhere, resource-blind. */
  effectivePermissionsFrom(access: PrincipalAccess): string[];
}
