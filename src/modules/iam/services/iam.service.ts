import {
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IamGroupEntity } from '../entities/iam-group.entity';
import {
  BUILTIN_ROLES,
  IamRoleDef,
  mayAdministerRole,
  mayConferRole,
} from '../constants/iam-roles';
import { CreateGrantDto } from '../dto/create-grant.dto';
import { CreateGroupDto } from '../dto/create-group.dto';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import {
  IamPrincipal,
  IamPrincipalType,
  PrincipalAccess,
} from '../interfaces/iam.types';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../interfaces/policy-engine.interface';

/** A selectable app, projected to the IAM selector axes (+ id/name for the UI). */
export interface IamResourceDto {
  id: string;
  slug: string;
  name: string;
  type: 'system' | 'user';
  kind: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  project?: string;
  tags: string[];
  /** The owning user's id, or null when the app belongs to nobody. */
  owner: string | null;
}

/** A choosable grantee for the "Who" picker. */
export interface IamPrincipalOption {
  type: IamPrincipalType;
  ref: string;
  displayName: string;
}

/**
 * A role as the caller may use it, not just as it is defined.
 *
 * `grantable` is answered by the API rather than worked out again in the
 * browser, because working it out again is how a screen ends up offering a
 * choice the API refuses: the conferral rule reads a permission at *global*
 * scope, and `/me/permissions` returns the union across every scope — a
 * cluster-scoped holder would look eligible there and be refused here.
 */
export interface IamRoleView extends IamRoleDef {
  grantable: boolean;
  /**
   * Whether this caller may *remove* a binding carrying the role.
   *
   * Not the same question as `grantable`, and the difference is load-bearing on
   * screen: nobody may create a sandbox grant, yet an access manager has always
   * been able to delete one. Collapsing the two would either hide a delete
   * button that works or offer one that answers 403.
   */
  revocable: boolean;
}

/** Management surface for grants (role bindings) and Flui-local groups. */
@Injectable()
export class IamService {
  constructor(
    @InjectRepository(IamRoleBindingEntity)
    private readonly bindings: Repository<IamRoleBindingEntity>,
    @InjectRepository(IamGroupEntity)
    private readonly groups: Repository<IamGroupEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly apps: Repository<ApplicationEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  /** Apps across all clusters, projected to selector axes — powers the grant-builder. */
  async listResources(): Promise<IamResourceDto[]> {
    const apps = await this.apps.find({
      where: { deletedAt: IsNull() },
      relations: ['cluster', 'project'],
      order: { name: 'ASC' },
    });
    return apps.map((a) => ({
      id: a.id,
      slug: a.slug,
      name: a.name,
      type: a.category as 'system' | 'user',
      kind: a.kind,
      clusterId: a.clusterId,
      clusterName: a.cluster?.name ?? '',
      provider: a.cluster?.provider ?? '',
      project: a.project?.slug ?? undefined,
      tags: a.tags ?? [],
      // Needed for the access screen to evaluate an owner-scoped grant. Without
      // it the client cannot tell which apps such a grant reaches and counts
      // them all, which overstates the reach of every tenancy grant there is.
      owner: a.userId ?? null,
    }));
  }

  /** Users + groups as grantee options for the "Who" picker. */
  async listPrincipals(): Promise<IamPrincipalOption[]> {
    const [users, groups] = await Promise.all([
      this.users.find({ order: { email: 'ASC' } }),
      this.groups.find({ order: { name: 'ASC' } }),
    ]);
    const userOpts: IamPrincipalOption[] = users.map((u) => ({
      type: 'user',
      ref: u.email,
      displayName: this.userDisplay(u),
    }));
    const groupOpts: IamPrincipalOption[] = groups.map((g) => ({
      type: 'group',
      ref: g.name,
      displayName: `Group: ${g.name}`,
    }));
    return [...userOpts, ...groupOpts];
  }

  private userDisplay(u: UserEntity): string {
    const label =
      u.displayName ||
      [u.firstName, u.lastName].filter(Boolean).join(' ') ||
      u.name;
    return label ? `${label} (${u.email})` : u.email;
  }

  listRoles(): IamRoleDef[] {
    return Object.values(BUILTIN_ROLES);
  }

  /** Every role, each carrying whether *this* caller may confer it. */
  /**
   * The role catalogue, as a person sees it: the four rungs of the ladder and
   * nothing else.
   *
   * `sandbox` and `showcase_viewer` are filtered out rather than shown greyed
   * out. They are tenancies the platform writes for itself, not tiers of access
   * anybody picks — nobody can grant them, and presenting them next to Viewer
   * and Owner taught whoever read the screen that this product has six roles
   * when it has four. The screens keep working without them: `isRevocable`
   * falls back to "yes" for a role the catalogue does not describe, so an
   * existing sandbox binding is still removable by hand.
   */
  async listRolesFor(caller: IamPrincipal): Promise<IamRoleView[]> {
    const access = await this.policy.resolveAccess(caller);
    return Object.values(BUILTIN_ROLES)
      .filter((role) => role.assignable)
      .map((role) => ({
        ...role,
        grantable: mayConferRole(access, role.key),
        revocable: mayAdministerRole(access, role.key),
      }));
  }

  listGrants(): Promise<IamRoleBindingEntity[]> {
    return this.bindings.find({ order: { createdAt: 'DESC' } });
  }

  /**
   * The single door through which a person creates a binding.
   *
   * The sandbox tenancy service writes its two grants straight to the
   * repository, which is why it is unaffected by the rule below — and why the
   * rule can be as strict as it needs to be without the platform tripping on it.
   */
  async createGrant(
    dto: CreateGrantDto,
    caller: IamPrincipal,
  ): Promise<IamRoleBindingEntity> {
    await this.assertMayConfer(caller, dto.role);
    const entity = this.bindings.create({
      principalType: dto.principalType,
      principalRef: dto.principalRef,
      role: dto.role,
      scopeType: dto.scopeType,
      scopeRef: dto.scopeRef ?? null,
      selector: dto.selector ?? null,
    });
    return this.bindings.save(entity);
  }

  /** One binding, or 404. Named so a caller can read it *before* deleting it. */
  async getGrant(id: string): Promise<IamRoleBindingEntity> {
    const existing = await this.bindings.findOne({ where: { id } });
    if (!existing) throw new NotFoundException(`Grant ${id} not found`);
    return existing;
  }

  async deleteGrant(id: string, caller: IamPrincipal): Promise<void> {
    const existing = await this.getGrant(id);
    await this.assertMayAdminister(caller, existing.role);
    await this.bindings.delete(id);
  }

  /** Throws unless the caller may hand this role out. */
  async assertMayConfer(caller: IamPrincipal, role: string): Promise<void> {
    this.assertConferrable(await this.policy.resolveAccess(caller), role);
  }

  /** Throws unless the caller may remove a binding carrying this role. */
  async assertMayAdminister(caller: IamPrincipal, role: string): Promise<void> {
    this.assertAdministrable(await this.policy.resolveAccess(caller), role);
  }

  /**
   * The same two rules against an access already resolved.
   *
   * Applying a policy asks the question once per binding; resolving the caller
   * each time would turn one document into one database read per line.
   */
  assertConferrable(access: PrincipalAccess, role: string): void {
    if (mayConferRole(access, role)) return;
    throw new ForbiddenException(this.refusal(role));
  }

  assertAdministrable(access: PrincipalAccess, role: string): void {
    if (mayAdministerRole(access, role)) return;
    throw new ForbiddenException(this.refusal(role));
  }

  /** Names the missing permission, so the refusal is actionable rather than mysterious. */
  private refusal(role: string): string {
    const def = BUILTIN_ROLES[role as keyof typeof BUILTIN_ROLES];
    if (def && !def.assignable) {
      return `Role ${role} is assigned by the platform and cannot be granted`;
    }
    const required = def?.conferredBy;
    return required
      ? `Granting or revoking ${role} requires ${required} at global scope`
      : `Role ${role} cannot be granted`;
  }

  listGroups(): Promise<IamGroupEntity[]> {
    return this.groups.find({ order: { name: 'ASC' } });
  }

  createGroup(dto: CreateGroupDto): Promise<IamGroupEntity> {
    const entity = this.groups.create({
      name: dto.name,
      description: dto.description ?? null,
      members: [],
    });
    return this.groups.save(entity);
  }

  async deleteGroup(name: string): Promise<void> {
    const res = await this.groups.delete({ name });
    if (!res.affected) throw new NotFoundException(`Group ${name} not found`);
  }

  async addGroupMember(name: string, email: string): Promise<IamGroupEntity> {
    const group = await this.requireGroup(name);
    if (!group.members.includes(email)) {
      group.members = [...group.members, email];
    }
    return this.groups.save(group);
  }

  async removeGroupMember(
    name: string,
    email: string,
  ): Promise<IamGroupEntity> {
    const group = await this.requireGroup(name);
    group.members = group.members.filter((m) => m !== email);
    return this.groups.save(group);
  }

  private async requireGroup(name: string): Promise<IamGroupEntity> {
    const group = await this.groups.findOne({ where: { name } });
    if (!group) throw new NotFoundException(`Group ${name} not found`);
    return group;
  }
}
