import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  IamPrincipal,
  PrincipalAccess,
  ResourceAttributes,
  principalFromUser,
} from '../../iam/interfaces/iam.types';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AppTabKey, tabsForPermissions } from '../../iam/constants/iam-tabs';
import { isShowcase } from '../../iam/constants/iam-showcase';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationEntity } from '../entities/application.entity';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  SandboxTenantEntity,
  SandboxTenantState,
} from '../../sandbox/entities/sandbox-tenant.entity';

export const SANDBOX_CLUSTER_FORBIDDEN_CODE = 'SANDBOX_CLUSTER_NOT_OWNED';

/** What one caller may do with one application, as told to the interface. */
export interface AppAccessSummary {
  /** Tabs the permissions allow. The client intersects this with the app's shape. */
  tabs: AppTabKey[];
  readOnly: boolean;
  showcase: boolean;
}

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
    @InjectRepository(SandboxTenantEntity)
    private readonly sandboxTenants: Repository<SandboxTenantEntity>,
  ) {}

  principalFrom(user: AuthenticatedUser): IamPrincipal {
    return principalFromUser(user);
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

  /**
   * What the caller may do with each of these apps, keyed by app id.
   *
   * Computed alongside the list rather than asked for per app: the dashboard
   * needs it for every row it draws, and one resolution answers for all of them.
   * Nothing here authorises anything — the routes behind each tab are guarded
   * independently. This exists so the interface can stop offering doors that are
   * locked, which is a courtesy, not a control.
   */
  async summarise(
    user: AuthenticatedUser,
    apps: ApplicationEntity[],
  ): Promise<Map<string, AppAccessSummary>> {
    const summaries = new Map<string, AppAccessSummary>();
    if (apps.length === 0) return summaries;

    const access = await this.policy.resolveAccess(this.principalFrom(user));
    const { projectSlugById, clusterById } = await this.lookups(apps);

    for (const app of apps) {
      const resource = this.toResource(
        app,
        app.projectId ? projectSlugById.get(app.projectId) : undefined,
        clusterById.get(app.clusterId),
      );
      const permissions = this.policy.permissionsOn(access, resource);
      summaries.set(app.id, {
        tabs: tabsForPermissions(permissions),
        readOnly: !permissions.has(IAM_PERMISSION.APP_WRITE),
        showcase: isShowcase(app.tags),
      });
    }
    return summaries;
  }

  /**
   * May this caller decide who *sees* an application?
   *
   * Not a question about one application, which is why it takes no resource:
   * the `showcase` tag is what SHOWCASE_GRANT selects on, so setting it puts the
   * application in front of everyone on the instance. It is the same right the
   * two showcase routes ask for — asked here so that `PATCH :id { tags }` is not
   * their back door.
   */
  mayPublishShowcase(user: AuthenticatedUser | undefined): Promise<boolean> {
    if (!user) return Promise.resolve(false);
    return this.policy.check(
      this.principalFrom(user),
      IAM_PERMISSION.SHOWCASE_PUBLISH,
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

  /**
   * Create-time authority: a scoped grant only authorises creation its selector
   * reaches, so a project-scoped grant can't make a project-less app. Admins pass.
   * The app being created has no row yet, so its owner is the caller — which is
   * what makes an `owner` grant self-sufficient: it authorises the creation and
   * then covers the result.
   *
   * Returns the resolved access so the caller can apply sandbox-specific
   * handling (node-placement fields) without a second resolution.
   */
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
  ): Promise<PrincipalAccess> {
    if (!user) throw new ForbiddenException('Unauthenticated');
    const access = await this.policy.resolveAccess(this.principalFrom(user));
    if (access.isAdmin) return access;

    // A guest's owner-grant carries no cluster constraint, and the fence's
    // `:clusterId` pattern matches any id: without this pin a guest names any
    // cluster on the instance as its target.
    if (access.isSandbox) {
      await this.assertSandboxTenancyCluster(user.userId, target.clusterId);
    }

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
      owner: user.userId,
    };
    if (!this.policy.can(access, IAM_PERMISSION.APP_CREATE, resource)) {
      throw new ForbiddenException(
        'Not allowed to create applications in this scope',
      );
    }
    return access;
  }

  /**
   * A sandbox guest creates only on the cluster its tenancy was built on. The
   * tenancy row is the one source that binds guest → cluster; an expired or
   * missing tenancy refuses creation too, since the credential should not
   * outlive what it opens.
   */
  private async assertSandboxTenancyCluster(
    userId: string,
    clusterId: string | undefined,
  ): Promise<void> {
    const tenant = await this.sandboxTenants.findOne({
      where: { userId, state: SandboxTenantState.CLAIMED },
    });
    const boundTo = tenant?.clusterId;
    if (boundTo === undefined || boundTo !== clusterId) {
      throw new ForbiddenException({
        statusCode: 403,
        code: SANDBOX_CLUSTER_FORBIDDEN_CODE,
        message:
          'A sandbox guest can only create applications on the cluster of its own tenancy.',
        clusterId: clusterId ?? null,
      });
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
      owner: app.userId ?? null,
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
