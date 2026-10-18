import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationServiceEntity } from '../../attached-services/entities/application-service.entity';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { ApplicationTrafficService } from '../../observability/services/application-traffic.service';
import {
  TopologyAppDto,
  TopologyClusterDto,
  TopologyClusterLinkDto,
  TopologyLinkDto,
  TopologyStackDto,
} from '../dto/topology.dto';
import { TopologyLinkSource } from '../enums/topology.enums';
import {
  LinkCandidate,
  assembleLinks,
  internalReferences,
  WorkloadRefs,
  workloadRefLinks,
} from '../utils/topology-links.util';

const TRAFFIC_WINDOW = '5m';

type AppRow = Pick<
  ApplicationEntity,
  'id' | 'slug' | 'k8sNamespace' | 'port' | 'portProtocol' | 'env'
>;

/**
 * Who talks to whom, from what Flui already knows: the gateway routes into an
 * app, the services attached to it, the installs a catalog install depends on,
 * and the internal hosts its variables name. Only gateway routes carry
 * measured traffic; nothing measures traffic between apps yet.
 */
@Injectable()
export class TopologyLinksService {
  private readonly logger = new Logger(TopologyLinksService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ApplicationServiceEntity)
    private readonly attachedRepo: Repository<ApplicationServiceEntity>,
    @InjectRepository(CatalogInstallEntity)
    private readonly installRepo: Repository<CatalogInstallEntity>,
    @InjectRepository(AppEndpointEntity)
    private readonly endpointRepo: Repository<AppEndpointEntity>,
    private readonly traffic: ApplicationTrafficService,
  ) {}

  async build(
    apps: TopologyAppDto[],
    stacks: TopologyStackDto[],
    clusters: TopologyClusterDto[],
    workloadRefs: WorkloadRefs[] = [],
  ): Promise<{
    links: TopologyLinkDto[];
    clusterLinks: TopologyClusterLinkDto[];
  }> {
    const fromConfig = workloadRefLinks(apps, workloadRefs);
    // Platform workloads carry `namespace/name` ids and have no application record.
    const ids = apps.map((a) => a.id).filter((id) => !id.includes('/'));
    if (!ids.length) return assembleLinks(fromConfig, apps, clusters);
    const [rows, attached, endpoints] = await Promise.all([
      this.appRepo.find({
        where: { id: In(ids) },
        select: ['id', 'slug', 'k8sNamespace', 'port', 'portProtocol', 'env'],
      }) as Promise<AppRow[]>,
      this.attachedRepo.find({
        where: { applicationId: In(ids), deletedAt: IsNull() },
      }),
      this.endpointRepo.find({ where: { applicationId: In(ids) } }),
    ]);
    const row = new Map(rows.map((r) => [r.id, r]));
    const bySlot = new Map(
      rows.map((r) => [`${r.k8sNamespace}/${r.slug}`, r.id]),
    );
    const primaryOfInstall = new Map(
      stacks
        .filter((s) => s.type === 'composed')
        .map((s) => [s.id, s.primaryAppId]),
    );

    const candidates: LinkCandidate[] = [
      ...fromConfig,
      ...(await this.gatewayRoutes(endpoints, row)),
      ...attached.flatMap<LinkCandidate>((a) => {
        const to =
          a.bbApplicationId ??
          (a.catalogInstallId
            ? primaryOfInstall.get(a.catalogInstallId)
            : undefined);
        return to
          ? [
              {
                from: a.applicationId,
                to,
                source: TopologyLinkSource.ATTACHED_SERVICE,
                port: row.get(to)?.port ?? null,
              },
            ]
          : [];
      }),
      ...(await this.catalogDependencies(primaryOfInstall, row)),
      ...rows.flatMap((r) =>
        (r.env ?? [])
          .filter((v) => !v.secret && typeof v.value === 'string')
          .flatMap((v) => internalReferences(v.value))
          .flatMap<LinkCandidate>((ref) => {
            const to = bySlot.get(`${ref.namespace}/${ref.slug}`);
            return to
              ? [
                  {
                    from: r.id,
                    to,
                    source: TopologyLinkSource.ENV_REFERENCE,
                    port: ref.port ?? row.get(to)?.port ?? null,
                  },
                ]
              : [];
          }),
      ),
    ];
    return assembleLinks(candidates, apps, clusters);
  }

  private async gatewayRoutes(
    endpoints: AppEndpointEntity[],
    row: Map<string, AppRow>,
  ): Promise<LinkCandidate[]> {
    const byService = await this.traffic
      .getClusterTrafficByService(TRAFFIC_WINDOW)
      .catch((err: Error) => {
        this.logger.warn(`Gateway traffic unavailable: ${err.message}`);
        return null;
      });
    return endpoints.flatMap<LinkCandidate>((e) => {
      const app = row.get(e.applicationId);
      if (!app) return [];
      const summary = byService
        ? this.traffic.summaryFor(
            {
              slug: app.slug,
              namespace: app.k8sNamespace,
              port: app.port,
              portProtocol: app.portProtocol,
            },
            byService,
          )
        : null;
      return [
        {
          from: null,
          to: app.id,
          source: TopologyLinkSource.GATEWAY_ROUTE,
          routeHost: e.fqdn,
          routePath: e.routePath ?? null,
          port: e.k8sServicePort ?? app.port ?? null,
          traffic: summary
            ? { rps: summary.rps, errorPct: summary.serverErrorPercent }
            : null,
        },
      ];
    });
  }

  private async catalogDependencies(
    primaryOfInstall: Map<string, string>,
    row: Map<string, AppRow>,
  ): Promise<LinkCandidate[]> {
    const installIds = [...primaryOfInstall.keys()];
    if (!installIds.length) return [];
    const installs = await this.installRepo.find({
      where: { id: In(installIds), deletedAt: IsNull() },
      select: ['id', 'dependencyInstallIds'],
    });
    return installs.flatMap((install) =>
      (install.dependencyInstallIds ?? []).flatMap<LinkCandidate>((dep) => {
        const from = primaryOfInstall.get(install.id);
        const to = primaryOfInstall.get(dep);
        return from && to
          ? [
              {
                from,
                to,
                source: TopologyLinkSource.CATALOG_DEPENDENCY,
                port: row.get(to)?.port ?? null,
              },
            ]
          : [];
      }),
    );
  }
}
