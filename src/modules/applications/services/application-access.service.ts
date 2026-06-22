import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  IamPrincipal,
  ResourceAttributes,
} from '../../iam/interfaces/iam.types';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationEntity } from '../entities/application.entity';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';

/**
 * Resource-aware authorization for applications. Maps an ApplicationEntity to the
 * {@link ResourceAttributes} the PolicyEngine reasons over (the project is matched
 * by its slug, not its id), then either filters a list down to what the caller may
 * read or asserts a single-app action. Admins short-circuit to allow-all.
 */
@Injectable()
export class ApplicationAccessService {
  constructor(
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
    @InjectRepository(ProjectEntity)
    private readonly projects: Repository<ProjectEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  principalFrom(user: AuthenticatedUser): IamPrincipal {
    return {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: !!user.isAdmin,
      scopes: user.scopes,
    };
  }

  /** Keep only the apps the caller may read. One access resolution, in-memory filter. */
  async filterReadable(
    user: AuthenticatedUser,
    apps: ApplicationEntity[],
  ): Promise<ApplicationEntity[]> {
    if (apps.length === 0) return apps;
    const access = await this.policy.resolveAccess(this.principalFrom(user));
    if (access.isAdmin) return apps;
    const { projectSlugById, clusterById } = await this.lookups(apps);
    return apps.filter((a) =>
      this.policy.can(
        access,
        IAM_PERMISSION.APP_READ,
        this.toResource(
          a,
          a.projectId ? projectSlugById.get(a.projectId) : undefined,
          clusterById.get(a.clusterId),
        ),
      ),
    );
  }

  /** True if the caller may perform `action` on this app. */
  async can(
    user: AuthenticatedUser,
    action: string,
    app: ApplicationEntity,
  ): Promise<boolean> {
    const access = await this.policy.resolveAccess(this.principalFrom(user));
    if (access.isAdmin) return true;
    return this.policy.can(access, action, await this.resourceFor(app));
  }

  /** Throw 403 unless the caller may perform `action` on this app. */
  async assertCan(
    user: AuthenticatedUser,
    action: string,
    app: ApplicationEntity,
  ): Promise<void> {
    if (!(await this.can(user, action, app))) {
      throw new ForbiddenException(
        `Not allowed to ${action} on application '${app.slug}'`,
      );
    }
  }

  // Create-time authority: a scoped grant only authorises creation its selector
  // reaches, so a project-scoped grant can't make a project-less app. Admins pass.
  async assertCanCreate(
    user: AuthenticatedUser | undefined,
    target: {
      clusterId?: string;
      category?: string;
      kind?: string;
      slug?: string;
      projectSlug?: string;
      tags?: string[];
    },
  ): Promise<void> {
    if (!user) throw new ForbiddenException('Unauthenticated');
    const access = await this.policy.resolveAccess(this.principalFrom(user));
    if (access.isAdmin) return;
    const cluster = target.clusterId
      ? await this.clusters.findOne({ where: { id: target.clusterId } })
      : undefined;
    const resource: ResourceAttributes = {
      slug: target.slug ?? '',
      type: (target.category as 'system' | 'user') ?? 'user',
      kind: target.kind,
      clusterId: target.clusterId,
      clusterName: cluster?.name,
      provider: cluster?.provider,
      project: target.projectSlug,
      tags: target.tags ?? [],
    };
    if (!this.policy.can(access, IAM_PERMISSION.APP_CREATE, resource)) {
      throw new ForbiddenException(
        'Not allowed to create applications in this scope',
      );
    }
  }

  private async resourceFor(
    app: ApplicationEntity,
  ): Promise<ResourceAttributes> {
    const projectSlug =
      app.project?.slug ??
      (app.projectId
        ? (await this.projects.findOne({ where: { id: app.projectId } }))?.slug
        : undefined);
    const cluster =
      app.cluster ??
      (app.clusterId
        ? await this.clusters.findOne({ where: { id: app.clusterId } })
        : undefined);
    return this.toResource(app, projectSlug ?? undefined, cluster ?? undefined);
  }

  private toResource(
    app: ApplicationEntity,
    projectSlug?: string,
    cluster?: ClusterEntity | null,
  ): ResourceAttributes {
    return {
      slug: app.slug,
      type: app.category as 'system' | 'user',
      kind: app.kind,
      clusterId: app.clusterId,
      clusterName: cluster?.name,
      provider: cluster?.provider,
      project: projectSlug,
      tags: app.tags ?? [],
    };
  }

  private async lookups(apps: ApplicationEntity[]): Promise<{
    projectSlugById: Map<string, string>;
    clusterById: Map<string, ClusterEntity>;
  }> {
    const projectIds = [
      ...new Set(apps.map((a) => a.projectId).filter((x): x is string => !!x)),
    ];
    const clusterIds = [
      ...new Set(apps.map((a) => a.clusterId).filter((x): x is string => !!x)),
    ];
    const projects = projectIds.length
      ? await this.projects.findBy({ id: In(projectIds) })
      : [];
    const clusters = clusterIds.length
      ? await this.clusters.findBy({ id: In(clusterIds) })
      : [];
    return {
      projectSlugById: new Map(projects.map((p) => [p.id, p.slug])),
      clusterById: new Map(clusters.map((c) => [c.id, c])),
    };
  }
}
