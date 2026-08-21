import { Inject, Injectable } from '@nestjs/common';
import { IamService } from './iam.service';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { CreateGrantDto } from '../dto/create-grant.dto';
import {
  AccessPolicyDoc,
  ApplyPolicyDto,
  ApplyPolicyResult,
  PolicyBindingDto,
} from '../dto/access-policy.dto';
import { IamPrincipal } from '../interfaces/iam.types';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../interfaces/policy-engine.interface';

const API_VERSION = 'flui.cloud/v1beta1';

// Config-as-Code: export RoleBindings as a kind:AccessPolicy doc and apply one
// back (idempotent; `prune` = full sync). Groups are managed separately.
@Injectable()
export class AccessPolicyService {
  constructor(
    private readonly iam: IamService,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async export(): Promise<AccessPolicyDoc> {
    const bindings = await this.iam.listGrants();
    return {
      apiVersion: API_VERSION,
      kind: 'AccessPolicy',
      metadata: { name: 'flui-access' },
      spec: { bindings: bindings.map((b) => this.toPolicyBinding(b)) },
    };
  }

  /**
   * Apply a policy document on behalf of a caller.
   *
   * The caller is not decoration: this is the third door onto a role binding —
   * the other two being create and delete — and a document is the one that
   * mutates in bulk. Every line is checked *before* anything is written, so a
   * policy that names a role the caller may not confer is refused whole rather
   * than applied halfway.
   */
  async apply(
    doc: ApplyPolicyDto,
    caller: IamPrincipal,
  ): Promise<ApplyPolicyResult> {
    const desired = doc.spec.bindings.map((b) => this.toCreateDto(b));
    const existing = await this.iam.listGrants();
    const existingByKey = new Map(
      existing.map((e) => [this.keyOf(this.entityToDto(e)), e]),
    );
    const desiredKeys = new Set(desired.map((d) => this.keyOf(d)));

    const toCreate = desired.filter((d) => !existingByKey.has(this.keyOf(d)));
    const toDelete = doc.prune
      ? [...existingByKey]
          .filter(([key]) => !desiredKeys.has(key))
          .map(([, entity]) => entity)
      : [];

    const access = await this.policy.resolveAccess(caller);
    for (const dto of toCreate) this.iam.assertConferrable(access, dto.role);
    for (const entity of toDelete) {
      this.iam.assertAdministrable(access, entity.role);
    }

    for (const dto of toCreate) await this.iam.createGrant(dto, caller);
    for (const entity of toDelete)
      await this.iam.deleteGrant(entity.id, caller);

    return {
      created: toCreate.length,
      unchanged: desired.length - toCreate.length,
      deleted: toDelete.length,
      desired: desired.length,
    };
  }

  private toPolicyBinding(b: IamRoleBindingEntity): PolicyBindingDto {
    const principal = { type: b.principalType, ref: b.principalRef };
    const role = b.role as PolicyBindingDto['role'];
    switch (b.scopeType) {
      case 'section':
        return {
          principal,
          role,
          scope: { type: 'section', section: b.scopeRef ?? undefined },
        };
      case 'cluster':
        return {
          principal,
          role,
          scope: { type: 'cluster', cluster: b.scopeRef ?? undefined },
        };
      case 'selector':
        return {
          principal,
          role,
          scope: { type: 'selector', selector: b.selector ?? undefined },
        };
      default:
        return { principal, role, scope: { type: 'global' } };
    }
  }

  private toCreateDto(b: PolicyBindingDto): CreateGrantDto {
    return {
      principalType: b.principal.type,
      principalRef: b.principal.ref,
      role: b.role,
      scopeType: b.scope.type,
      scopeRef: this.scopeRefOf(b.scope),
      selector: b.scope.type === 'selector' ? b.scope.selector : undefined,
    };
  }

  private scopeRefOf(scope: PolicyBindingDto['scope']): string | undefined {
    if (scope.type === 'section') return scope.section;
    if (scope.type === 'cluster') return scope.cluster;
    return undefined;
  }

  private entityToDto(e: IamRoleBindingEntity): CreateGrantDto {
    return {
      principalType: e.principalType,
      principalRef: e.principalRef,
      role: e.role,
      scopeType: e.scopeType,
      scopeRef: e.scopeRef ?? undefined,
      selector: e.selector ?? undefined,
    };
  }

  private keyOf(d: CreateGrantDto): string {
    return [
      d.principalType,
      d.principalRef,
      d.role,
      d.scopeType,
      d.scopeRef ?? '',
      this.canonical(d.selector),
    ].join('|');
  }

  private canonical(selector: CreateGrantDto['selector']): string {
    if (!selector) return '';
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(selector).sort((a, b) => a.localeCompare(b))) {
      const v = (selector as Record<string, unknown>)[k];
      if (v == null) continue;
      sorted[k] = Array.isArray(v)
        ? [...(v as string[])].sort((a, b) => a.localeCompare(b))
        : v;
    }
    return JSON.stringify(sorted);
  }
}
