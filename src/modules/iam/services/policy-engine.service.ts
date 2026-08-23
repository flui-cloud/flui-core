import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IamGroupEntity } from '../entities/iam-group.entity';
import { PolicyEngine } from '../interfaces/policy-engine.interface';
import {
  IamBinding,
  IamPrincipal,
  IamSelector,
  PrincipalAccess,
  ResourceAttributes,
  ScopedGrant,
} from '../interfaces/iam.types';
import { ALL_PERMISSIONS } from '../constants/iam-permissions';
import { IAM_ROLE, permissionsForRole } from '../constants/iam-roles';
import {
  ALL_SECTION_KEYS,
  SECTIONS,
  SectionAccess,
  SectionDef,
} from '../constants/iam-sections';

/**
 * SQL-backed PolicyEngine.
 *
 * `resolveAccess` reads the principal's bindings once and splits them into a
 * resource-independent set (`globalPermissions` = any GLOBAL-scope bindings) and
 * `scopedGrants` (cluster/section/selector-scoped). `can` then evaluates that
 * against a resource purely in memory — so a list query resolves access once and
 * filters N rows with no extra IO.
 *
 * DENY-BY-DEFAULT: a non-admin has NO implicit access. Everything comes from
 * explicit bindings (own / group / global). The IdP coarse role no longer acts
 * as a floor — a user with no grants sees nothing, so an admin always knows
 * exactly what access they handed out. Admin/root → allow-all.
 */
@Injectable()
export class PolicyEngineService implements PolicyEngine {
  constructor(
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindings: Repository<IamRoleBindingEntity>,
    @InjectRepository(IamGroupEntity)
    private readonly groups: Repository<IamGroupEntity>,
  ) {}

  async resolveAccess(principal: IamPrincipal): Promise<PrincipalAccess> {
    if (principal.isAdmin) return this.accessFrom([], true);
    return this.accessFrom(await this.bindingsFor(principal));
  }

  /**
   * Every binding that reaches this principal — their own, their
   * service-account's, and the ones addressed to the groups they belong to.
   *
   * Public so that a caller can ask the *hypothetical* question — what would
   * this principal reach if this binding were gone, or if that one existed —
   * by mutating the list and folding it again through {@link accessFrom}.
   */
  async bindingsFor(principal: IamPrincipal): Promise<IamBinding[]> {
    const groupNames = await this.resolveGroups(principal.email);
    return this.findBindingsFor(principal, groupNames);
  }

  /**
   * The fold: bindings in, resolved access out. No IO, so it answers for a set
   * of bindings that is not (or not yet) what the database holds.
   *
   * DENY-BY-DEFAULT lives here: an empty binding list is an empty access, never
   * a floor derived from the IdP role.
   */
  accessFrom(bindings: IamBinding[], isAdmin = false): PrincipalAccess {
    if (isAdmin) {
      return {
        isAdmin: true,
        globalPermissions: new Set(ALL_PERMISSIONS),
        scopedGrants: [],
        isSandbox: false,
      };
    }
    const globalPermissions = new Set<string>();
    const scopedGrants: ScopedGrant[] = [];
    let isSandbox = false;
    for (const b of bindings) {
      if (b.role === IAM_ROLE.SANDBOX) isSandbox = true;
      const permissions = new Set<string>(permissionsForRole(b.role));
      if (b.scopeType === 'global') {
        for (const p of permissions) globalPermissions.add(p);
      } else {
        scopedGrants.push({
          permissions,
          scopeType: b.scopeType,
          scopeRef: b.scopeRef,
          selector: b.selector,
        });
      }
    }
    return { isAdmin: false, globalPermissions, scopedGrants, isSandbox };
  }

  can(
    access: PrincipalAccess,
    action: string,
    resource?: ResourceAttributes,
  ): boolean {
    if (access.isAdmin) return true;
    if (access.globalPermissions.has(action)) return true;
    return access.scopedGrants.some(
      (g) => g.permissions.has(action) && this.scopeApplies(g, resource),
    );
  }

  /**
   * Everything this principal may do to *one* resource. `can` answers one
   * question at a time; a caller describing a resource to the user — which tabs
   * open, whether it is read-only — needs the whole set, and asking `can` once
   * per permission would re-walk the grants each time.
   */
  permissionsOn(
    access: PrincipalAccess,
    resource: ResourceAttributes,
  ): Set<string> {
    if (access.isAdmin) return new Set<string>(ALL_PERMISSIONS);
    const perms = new Set<string>(access.globalPermissions);
    for (const g of access.scopedGrants) {
      if (!this.scopeApplies(g, resource)) continue;
      for (const p of g.permissions) perms.add(p);
    }
    return perms;
  }

  async check(
    principal: IamPrincipal,
    action: string,
    resource?: ResourceAttributes,
  ): Promise<boolean> {
    const access = await this.resolveAccess(principal);
    return this.can(access, action, resource);
  }

  /**
   * Which portal sections this principal may enter. Derived from the resolved
   * access: a management section requires its governing permission at GLOBAL
   * scope; a workload section accepts it at any scope. Admin → all sections.
   *
   * Keys only, at whatever level they were granted — the shape the sidebar and
   * the older callers ask for. `resolveSectionAccess` carries the level.
   */
  async resolveSections(principal: IamPrincipal): Promise<string[]> {
    const access = await this.resolveSectionAccess(principal);
    return access.map((s) => s.key);
  }

  /**
   * The same answer with the level attached: `full` where the governing
   * permission is held, `read-only` where only the entry key is. A section
   * absent from this list is not enterable at all.
   */
  async resolveSectionAccess(
    principal: IamPrincipal,
  ): Promise<SectionAccess[]> {
    return this.sectionAccessFrom(await this.resolveAccess(principal));
  }

  /**
   * The same derivation against an access already resolved — no IO, so it can
   * be asked of a hypothetical access as easily as of the real one.
   */
  sectionAccessFrom(access: PrincipalAccess): SectionAccess[] {
    if (access.isAdmin) {
      return ALL_SECTION_KEYS.map((key) => ({ key, level: 'full' as const }));
    }

    const hasGlobal = (perm: string) => access.globalPermissions.has(perm);
    const hasAny = (perm: string) =>
      access.globalPermissions.has(perm) ||
      access.scopedGrants.some((g) => g.permissions.has(perm));
    const opens = (gate: SectionDef['gate']): boolean => {
      switch (gate.kind) {
        case 'always':
          return true;
        case 'permission':
          return gate.scope === 'global'
            ? hasGlobal(gate.permission)
            : hasAny(gate.permission);
      }
    };

    const granted: SectionAccess[] = [];
    for (const section of SECTIONS) {
      if (opens(section.gate))
        granted.push({ key: section.key, level: 'full' });
      else if (section.view && opens(section.view)) {
        granted.push({ key: section.key, level: 'read-only' });
      }
    }
    return granted;
  }

  async getEffectivePermissions(principal: IamPrincipal): Promise<string[]> {
    return this.effectivePermissionsFrom(await this.resolveAccess(principal));
  }

  /** Every permission this access carries *somewhere*, resource-blind. */
  effectivePermissionsFrom(access: PrincipalAccess): string[] {
    if (access.isAdmin) return [...ALL_PERMISSIONS];
    const perms = new Set<string>(access.globalPermissions);
    for (const g of access.scopedGrants) {
      for (const p of g.permissions) perms.add(p);
    }
    return Array.from(perms);
  }

  /**
   * Does this scoped grant apply to the resource? Without a resource we answer
   * coarsely (true) — the grant carries the action *somewhere*, which is what a
   * resource-less @RequirePermission gate asks.
   */
  private scopeApplies(g: ScopedGrant, resource?: ResourceAttributes): boolean {
    if (!resource) return true;
    switch (g.scopeType) {
      case 'global':
        return true;
      case 'cluster':
        return !!g.scopeRef && resource.clusterId === g.scopeRef;
      case 'section':
        return false; // portal sections are not app resources
      case 'selector':
        return this.matchesSelector(resource, g.selector ?? {});
    }
  }

  /** Mirror of the dashboard predicate: equality AND-ed, slugs IN, tags ALL-of. */
  private matchesSelector(r: ResourceAttributes, s: IamSelector): boolean {
    // An owner selector must never match a resource that has no owner: unowned
    // apps (system apps, API-key installs) would otherwise fall to every tenant.
    if (s.owner && (!r.owner || r.owner !== s.owner)) return false;

    const equality: Array<[string | undefined, string | undefined]> = [
      [s.type, r.type],
      [s.kind, r.kind],
      [s.clusterId, r.clusterId],
      [s.clusterName, r.clusterName],
      [s.provider, r.provider],
      [s.project, r.project],
    ];
    if (equality.some(([sel, res]) => !!sel && sel !== res)) return false;
    if (s.slugs?.length && !(r.slug && s.slugs.includes(r.slug))) return false;
    if (s.tags?.length && !s.tags.every((t) => r.tags?.includes(t)))
      return false;
    return true;
  }

  private async resolveGroups(email: string): Promise<string[]> {
    const all = await this.groups.find();
    return all.filter((g) => g.members?.includes(email)).map((g) => g.name);
  }

  private findBindingsFor(
    principal: IamPrincipal,
    groupNames: string[],
  ): Promise<IamRoleBindingEntity[]> {
    const refs: Array<{ type: string; ref: string }> = [
      { type: 'user', ref: principal.email },
      { type: 'service_account', ref: principal.userId },
      ...groupNames.map((g) => ({ type: 'group', ref: g })),
    ];
    const qb = this.bindings.createQueryBuilder('b');
    refs.forEach((r, i) => {
      const cond = `(b.principalType = :pt${i} AND b.principalRef = :pr${i})`;
      const params = { [`pt${i}`]: r.type, [`pr${i}`]: r.ref };
      if (i === 0) qb.where(cond, params);
      else qb.orWhere(cond, params);
    });
    return qb.getMany();
  }
}
