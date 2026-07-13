import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { ApplicationEntity } from '../entities/application.entity';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { GatewayMiddlewareCompilerService } from '../../dns/services/gateway-middleware-compiler.service';
import { ClusterDnsZoneService } from '../../dns/services/cluster-dns-zone.service';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity';
import { EndpointGatewayConfig } from '../../dns/interfaces/endpoint-gateway-config.interface';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';
import {
  AddGatewayRouteDto,
  ClusterGatewayRouteDto,
  CompiledGatewayRouteDto,
  GatewayRouteDto,
  GatewayStatusDto,
  SetGatewayPolicyDto,
} from '../dto/gateway-route.dto';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}

/**
 * App-scoped gateway control plane. Routes ARE the app's endpoints: an app
 * with no gateway config keeps exactly today's default behavior (one route
 * per endpoint, auto TLS, no policies). Policies are stored on the endpoint
 * and compiled to Traefik CRDs by the endpoint reconciler.
 */
@Injectable()
export class GatewayService {
  private readonly logger = new Logger(GatewayService.name);

  constructor(
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appEndpointService: AppEndpointService,
    private readonly reconciliationService: AppEndpointReconciliationService,
    private readonly gatewayCompiler: GatewayMiddlewareCompilerService,
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
  ) {}

  async listRoutes(appId: string): Promise<GatewayRouteDto[]> {
    await this.getApp(appId);
    const endpoints = await this.appEndpointService.listByApplicationId(appId);
    return endpoints
      .map((e) => this.toRouteDto(e))
      .sort((a, b) => a.host.localeCompare(b.host));
  }

  async addRoute(
    appId: string,
    dto: AddGatewayRouteDto,
  ): Promise<GatewayRouteDto> {
    const app = await this.getApp(appId);

    const clusterDnsZoneId =
      dto.clusterDnsZoneId ??
      (await this.matchZoneForHost(app.clusterId, dto.host));

    const endpoint = await this.appEndpointService.createEndpoint(
      app.clusterId,
      {
        applicationId: app.id,
        fqdn: dto.host,
        clusterDnsZoneId: clusterDnsZoneId ?? undefined,
        certificateRequired: dto.certificateRequired ?? true,
      },
    );

    const config = this.buildConfig(dto);
    const withConfig = config
      ? await this.appEndpointService.updateGatewayConfig(endpoint.id, config)
      : endpoint;

    this.reconcileInBackground(withConfig.id);
    return this.toRouteDto(withConfig);
  }

  async setPolicy(
    appId: string,
    endpointId: string,
    dto: SetGatewayPolicyDto,
  ): Promise<GatewayRouteDto> {
    const endpoint = await this.getOwnedEndpoint(appId, endpointId);

    const current: EndpointGatewayConfig = { ...endpoint.gatewayConfig };
    if (dto.path !== undefined) current.path = dto.path ?? undefined;
    if (dto.auth !== undefined) current.auth = dto.auth ?? undefined;
    if (dto.rateLimit !== undefined)
      current.rateLimit = dto.rateLimit ?? undefined;
    if (dto.allowIps !== undefined)
      current.allowIps = dto.allowIps?.length ? dto.allowIps : undefined;

    const next = this.isEmptyConfig(current) ? null : current;
    const updated = await this.appEndpointService.updateGatewayConfig(
      endpointId,
      next,
    );

    this.reconcileInBackground(endpointId);
    return this.toRouteDto(updated);
  }

  async removeRoute(appId: string, endpointId: string): Promise<void> {
    await this.getOwnedEndpoint(appId, endpointId);
    await this.reconciliationService.deleteEndpointResources(endpointId);
    await this.appEndpointService.deleteEndpoint(endpointId);
  }

  async reconcileRoute(
    appId: string,
    endpointId: string,
  ): Promise<GatewayRouteDto> {
    await this.getOwnedEndpoint(appId, endpointId);
    await this.reconciliationService.reconcile(endpointId);
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);
    return this.toRouteDto(endpoint);
  }

  async status(appId: string): Promise<GatewayStatusDto> {
    const routes = await this.listRoutes(appId);
    return {
      total: routes.length,
      synced: routes.filter(
        (r) => r.reconciliationStatus === ReconciliationStatus.IN_SYNC,
      ).length,
      routes,
    };
  }

  /** Read-only global view: every route on the cluster with its owning app. */
  async listClusterRoutes(
    clusterId: string,
  ): Promise<ClusterGatewayRouteDto[]> {
    const endpoints = await this.appEndpointService.listEndpoints(clusterId);
    const apps = await this.applicationsRepository.findByClusterId(clusterId);
    const appById = new Map(apps.map((a) => [a.id, a]));
    return endpoints
      .map((e) => {
        const app = e.applicationId ? appById.get(e.applicationId) : undefined;
        return {
          ...this.toRouteDto(e),
          applicationName: app?.name ?? null,
          applicationSlug: app?.slug ?? null,
        };
      })
      .sort((a, b) => a.host.localeCompare(b.host));
  }

  /**
   * Compiled-CRD preview of a route's policies — what the reconciler will
   * apply, without applying it.
   */
  async compiledRoute(
    appId: string,
    endpointId: string,
  ): Promise<CompiledGatewayRouteDto> {
    const endpoint = await this.getOwnedEndpoint(appId, endpointId);
    // Preview must not fail closed: show a placeholder when unresolved.
    const apiUrl = stripTrailingSlashes(process.env.PUBLIC_API_URL ?? '');
    const compiled = this.gatewayCompiler.compile(
      endpoint,
      endpoint.gatewayConfig,
      `${apiUrl || '<flui-api-public-url>'}/api/v1/authz/gateway`,
    );
    return {
      endpointId,
      path: compiled.path,
      middlewares: compiled.middlewares.map((m) => ({
        name: m.name,
        manifest: m.manifest,
      })),
      middlewareAnnotation: compiled.refs.join(','),
    };
  }

  // ── Internal helpers ───────────────────────────────────────────────────

  private async getApp(appId: string): Promise<ApplicationEntity> {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);
    return app;
  }

  private async getOwnedEndpoint(
    appId: string,
    endpointId: string,
  ): Promise<AppEndpointEntity> {
    await this.getApp(appId);
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);
    if (endpoint.applicationId !== appId) {
      throw new BadRequestException(
        `Route ${endpointId} does not belong to application ${appId}`,
      );
    }
    return endpoint;
  }

  private async matchZoneForHost(
    clusterId: string,
    host: string,
  ): Promise<string | null> {
    const zones =
      await this.clusterDnsZoneService.getZonesForCluster(clusterId);
    const lower = host.toLowerCase();
    const match = zones.find((z) =>
      z.dnsZone?.zoneName
        ? lower === z.dnsZone.zoneName.toLowerCase() ||
          lower.endsWith(`.${z.dnsZone.zoneName.toLowerCase()}`)
        : false,
    );
    return match?.id ?? null;
  }

  private buildConfig(dto: AddGatewayRouteDto): EndpointGatewayConfig | null {
    const config: EndpointGatewayConfig = {};
    if (dto.path) config.path = dto.path;
    if (dto.auth) config.auth = dto.auth;
    if (dto.rateLimit) config.rateLimit = dto.rateLimit;
    if (dto.allowIps?.length) config.allowIps = dto.allowIps;
    return this.isEmptyConfig(config) ? null : config;
  }

  private isEmptyConfig(config: EndpointGatewayConfig): boolean {
    return (
      (!config.path || config.path === '/') &&
      !config.auth &&
      !config.rateLimit &&
      !config.allowIps?.length
    );
  }

  /**
   * Reconciliation is fire-and-forget: it can legitimately take minutes (DNS
   * propagation gate before cert issuance), so mutations return immediately
   * and surfaces read per-route `reconciliationStatus` — synced / reconciling
   * / error — for the honest async story.
   */
  private reconcileInBackground(endpointId: string): void {
    this.reconciliationService.reconcile(endpointId).catch((err) => {
      this.logger.error(
        `Background reconcile failed for endpoint ${endpointId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private toRouteDto(endpoint: AppEndpointEntity): GatewayRouteDto {
    const config = endpoint.gatewayConfig;
    return {
      endpointId: endpoint.id,
      host: endpoint.fqdn,
      path: this.gatewayCompiler.normalizePath(config?.path),
      applicationId: endpoint.applicationId,
      service: `${endpoint.k8sServiceName}:${endpoint.k8sServicePort}`,
      endpointType: endpoint.endpointType,
      tlsEnabled:
        endpoint.certificateRequired &&
        endpoint.certificateStatus === CertificateStatus.VALID,
      certificateStatus: endpoint.certificateStatus ?? null,
      auth: config?.auth ?? null,
      rateLimit: config?.rateLimit ?? null,
      allowIps: config?.allowIps ?? null,
      reconciliationStatus: endpoint.reconciliationStatus,
      errorMessage: endpoint.errorMessage ?? null,
    };
  }
}
