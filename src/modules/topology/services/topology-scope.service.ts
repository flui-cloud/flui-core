import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Observable, concatMap, filter } from 'rxjs';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { credentialCeiling } from '../../auth/utils/credential-ceiling.util';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { SECTION } from '../../iam/constants/iam-sections';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';
import { TopologyResponseDto } from '../dto/topology.dto';
import {
  TopologyAppStatus,
  TopologyAppKind,
  TopologyEndpointKind,
  TopologyEventType,
} from '../enums/topology.enums';
import { assembleResponse } from './topology.service';
import { worstStatus } from '../utils/topology-enrich.util';
import { TopologyChange } from './topology-events.service';

const SCOPE_TTL_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TopologyScope {
  everyCluster: boolean;
  clusterIds: ReadonlySet<string>;
  appIds: ReadonlySet<string>;
}

@Injectable()
export class TopologyScopeService {
  constructor(
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
    private readonly applicationAccess: ApplicationAccessService,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
  ) {}

  async scopeFor(
    user: AuthenticatedUser,
    topology: TopologyResponseDto,
    includeSystem = false,
  ): Promise<TopologyScope> {
    const ids = [...new Set(topology.apps.map((a) => a.id))].filter((id) =>
      UUID.test(id),
    );
    const entities = ids.length
      ? await this.applications.find({
          where: { id: In(ids) },
          withDeleted: true,
        })
      : [];
    const readable = await this.applicationAccess.filterReadable(
      user,
      entities,
    );
    const appIds = new Set(readable.map((a) => a.id));

    const everyCluster = await this.seesEveryCluster(user);
    platformApps(topology, appIds, includeSystem && everyCluster);
    const hosting = new Set(
      topology.apps.filter((a) => appIds.has(a.id)).map((a) => a.clusterId),
    );
    const clusterIds = new Set(
      topology.clusters
        .filter((c) => everyCluster || hosting.has(c.id))
        .map((c) => c.id),
    );
    return { everyCluster, clusterIds, appIds };
  }

  async scope(
    user: AuthenticatedUser,
    topology: TopologyResponseDto,
    includeSystem = false,
  ): Promise<TopologyResponseDto> {
    return applyScope(
      topology,
      await this.scopeFor(user, topology, includeSystem),
    );
  }

  /**
   * One subscriber's view of the shared change stream. The scope is recomputed
   * when the snapshot moves on or a minute has passed, so a revoked grant
   * closes the stream's view without a reconnect. Apps of the previous scope
   * stay known for one round: their removal arrives after the snapshot that
   * no longer lists them.
   */
  scopeStream(
    user: AuthenticatedUser,
    changes$: Observable<TopologyChange>,
    snapshot: () => Promise<TopologyResponseDto>,
    includeSystem = false,
  ): Observable<TopologyChange> {
    let scope: TopologyScope | undefined;
    let scopedOn: TopologyResponseDto | undefined;
    let scopedAt = 0;
    const seenApps = new Set<string>();
    const current = async (): Promise<TopologyScope> => {
      const topology = await snapshot();
      if (
        !scope ||
        topology !== scopedOn ||
        Date.now() - scopedAt > SCOPE_TTL_MS
      ) {
        const previous = scope?.appIds ?? new Set<string>();
        scope = await this.scopeFor(user, topology, includeSystem);
        scopedOn = topology;
        scopedAt = Date.now();
        seenApps.clear();
        for (const id of [...previous, ...scope.appIds]) seenApps.add(id);
      }
      return scope;
    };
    return changes$.pipe(
      concatMap(async (change) =>
        change.event === TopologyEventType.HEARTBEAT
          ? change
          : scopeChange(change, await current(), seenApps),
      ),
      filter((change): change is TopologyChange => change !== null),
    );
  }

  private async seesEveryCluster(user: AuthenticatedUser): Promise<boolean> {
    if (user.applicationIds?.length || user.projectIds?.length) return false;
    const ceiling = credentialCeiling(user);
    if (ceiling && !ceiling.has(IAM_PERMISSION.CLUSTER_READ)) return false;
    const access = await this.policy.resolveAccess(principalFromUser(user));
    return this.policy
      .sectionAccessFrom(access)
      .some((s) => s.key === SECTION.CLUSTERS);
  }
}

/**
 * Platform apps (the ones Flui itself runs) are shown only on request, and
 * then to whoever sees every cluster: the same people who see the servers they
 * load. Many have no application record, so app:read cannot decide for them.
 */
export function platformApps(
  topology: Pick<TopologyResponseDto, 'apps'>,
  appIds: Set<string>,
  show: boolean,
): void {
  for (const app of topology.apps) {
    if (app.kind !== TopologyAppKind.SYSTEM) continue;
    if (show) appIds.add(app.id);
    else appIds.delete(app.id);
  }
}

/** The example world needs no permissions: everything, platform apps only on request. */
export function exampleScope(
  topology: TopologyResponseDto,
  includeSystem: boolean,
): TopologyScope {
  const appIds = new Set(topology.apps.map((a) => a.id));
  platformApps(topology, appIds, includeSystem);
  return {
    everyCluster: true,
    clusterIds: new Set(topology.clusters.map((c) => c.id)),
    appIds,
  };
}

export function applyScope(
  topology: TopologyResponseDto,
  scope: TopologyScope,
): TopologyResponseDto {
  const apps = topology.apps.filter(
    (a) => scope.appIds.has(a.id) && scope.clusterIds.has(a.clusterId),
  );
  const visibleApps = new Set(apps.map((a) => a.id));
  const servers = topology.servers.filter((s) =>
    scope.clusterIds.has(s.clusterId),
  );
  const stacks = topology.stacks.flatMap((stack) => {
    const appIds = stack.appIds.filter((id) => visibleApps.has(id));
    if (!appIds.length) return [];
    const primaryAppId = appIds.includes(stack.primaryAppId)
      ? stack.primaryAppId
      : appIds[0];
    const status = worstStatus(
      apps.filter((a) => appIds.includes(a.id)).map((a) => a.status),
    );
    return [{ ...stack, appIds, primaryAppId, status }];
  });
  const clusters = topology.clusters
    .filter((c) => scope.clusterIds.has(c.id))
    .map((c) => {
      const own = apps.filter((a) => a.clusterId === c.id);
      return {
        ...c,
        counts: {
          apps: own.length,
          stacks: stacks.filter((s) => s.clusterId === c.id).length,
          servers: servers.filter((s) => s.clusterId === c.id).length,
          errors: own.filter((a) => a.status === TopologyAppStatus.ERROR)
            .length,
          warnings: own.filter((a) => a.status === TopologyAppStatus.WARNING)
            .length,
        },
      };
    });
  return {
    ...assembleResponse({
      clusters,
      servers,
      stacks,
      apps,
      // Only the projects of the apps left: a project name is not shown to someone who reads none of its apps.
      projects: (topology.projects ?? []).filter((p) =>
        apps.some((a) => a.projectId === p.id),
      ),
      droppedApps: topology.stats.droppedApps,
    }),
    generatedAt: topology.generatedAt,
    ...scopeLinks(topology, scope),
  };
}

export function scopeLinks(
  input: Pick<TopologyResponseDto, 'links' | 'clusterLinks'>,
  scope: TopologyScope,
): Pick<TopologyResponseDto, 'links' | 'clusterLinks'> {
  return {
    links: input.links.filter((l) =>
      [l.from, l.to].every(
        (end) =>
          end.kind !== TopologyEndpointKind.APP ||
          (!!end.appId && scope.appIds.has(end.appId)),
      ),
    ),
    clusterLinks: input.clusterLinks.filter(
      (l) =>
        scope.clusterIds.has(l.fromClusterId) &&
        scope.clusterIds.has(l.toClusterId),
    ),
  };
}

/** The part of one change this subscriber may see, or nothing. */
export function scopeChange(
  change: TopologyChange,
  scope: TopologyScope,
  seenApps: ReadonlySet<string> = scope.appIds,
): TopologyChange | null {
  const data = change.data ?? {};
  const inCluster = !!data.clusterId && scope.clusterIds.has(data.clusterId);
  switch (change.event) {
    case TopologyEventType.HEARTBEAT:
      return change;
    case TopologyEventType.APP_DEPLOYED:
      return data.app && scope.appIds.has(data.app.id) ? change : null;
    case TopologyEventType.APP_REMOVED:
      return data.appId && seenApps.has(data.appId) ? change : null;
    case TopologyEventType.APP_STATUS_CHANGED:
    case TopologyEventType.APP_SCALED:
      return data.appId && scope.appIds.has(data.appId) ? change : null;
    case TopologyEventType.SERVER_ADDED:
    case TopologyEventType.SERVER_REMOVED:
      return inCluster ? change : null;
    case TopologyEventType.SERVER_CAPACITY: {
      const capacities = (data.capacities ?? []).filter((c) =>
        scope.clusterIds.has(c.clusterId),
      );
      return capacities.length ? { ...change, data: { capacities } } : null;
    }
    case TopologyEventType.LINKS_CHANGED:
      return {
        ...change,
        data: scopeLinks(
          { links: data.links ?? [], clusterLinks: data.clusterLinks ?? [] },
          scope,
        ),
      };
    default:
      return null;
  }
}
