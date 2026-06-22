import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { IamRoleBindingEntity } from '../entities/iam-role-binding.entity';
import { IamGroupEntity } from '../entities/iam-group.entity';
import { BUILTIN_ROLES, IamRoleDef } from '../constants/iam-roles';
import { CreateGrantDto } from '../dto/create-grant.dto';
import { CreateGroupDto } from '../dto/create-group.dto';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { UserEntity } from '../../auth/entities/user.entity';
import { IamPrincipalType } from '../interfaces/iam.types';

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
}

/** A choosable grantee for the "Who" picker. */
export interface IamPrincipalOption {
  type: IamPrincipalType;
  ref: string;
  displayName: string;
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

  listGrants(): Promise<IamRoleBindingEntity[]> {
    return this.bindings.find({ order: { createdAt: 'DESC' } });
  }

  createGrant(dto: CreateGrantDto): Promise<IamRoleBindingEntity> {
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

  async deleteGrant(id: string): Promise<void> {
    const res = await this.bindings.delete(id);
    if (!res.affected) throw new NotFoundException(`Grant ${id} not found`);
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
