import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ClusterDnsZoneService } from '../services/cluster-dns-zone.service';
import { AuthDomainSyncService } from '../services/auth-domain-sync.service';
import { AuthDomainSyncResultDto } from '../dto/auth-domain-sync-result.dto';
import { ApiDomainSyncService } from '../services/api-domain-sync.service';
import { SyncApiDomainDto } from '../dto/sync-api-domain.dto';
import { ApiDomainSyncResultDto } from '../dto/api-domain-sync-result.dto';
import { SyncAuthDomainDto } from '../dto/sync-auth-domain.dto';
import { WebDomainSyncService } from '../services/web-domain-sync.service';
import { SystemIngressService } from '../services/system-ingress.service';
import { SyncWebDomainDto } from '../dto/sync-web-domain.dto';
import { WebDomainSyncResultDto } from '../dto/web-domain-sync-result.dto';
import { AssignDnsZoneDto } from '../dto/assign-dns-zone.dto';
import { ClusterDnsZoneResponseDto } from '../dto/cluster-dns-zone-response.dto';
import { ClusterWildcardResponseDto } from '../dto/cluster-wildcard-response.dto';
import { ConfigureIssuerDto } from '../dto/configure-issuer.dto';
import { ConfigureSystemIngressDto } from '../dto/configure-system-ingress.dto';
import { SystemDnsStatusResponseDto } from '../dto/system-dns-status-response.dto';
import { CertDiagnosticsResponseDto } from '../dto/cert-diagnostics-response.dto';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';

@ApiTags('Cluster DNS Zone')
@ApiBearerAuth()
@Controller('clusters/:clusterId/dns-zone')
export class ClusterDnsZoneController {
  constructor(
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    private readonly authDomainSyncService: AuthDomainSyncService,
    private readonly apiDomainSyncService: ApiDomainSyncService,
    private readonly webDomainSyncService: WebDomainSyncService,
    private readonly systemIngressService: SystemIngressService,
  ) {}

  private parseIssuerType(type: string): 'http' | 'dns' {
    if (type === 'http' || type === 'dns') {
      return type;
    }
    throw new BadRequestException(
      `Invalid issuer type "${type}". Supported values: http, dns`,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Assign a DNS zone to a cluster',
    description:
      'Assign a registered DNS zone to a cluster. A cluster may have ' +
      'multiple zones assigned — DNS records for an app endpoint are ' +
      'written to the zone whose name is the longest suffix of the ' +
      'endpoint FQDN.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 201, type: ClusterDnsZoneResponseDto })
  @ApiResponse({ status: 404, description: 'Cluster or zone not found' })
  @ApiResponse({
    status: 409,
    description: 'Zone is already assigned to this cluster',
  })
  async assignZone(
    @Param('clusterId') clusterId: string,
    @Body() dto: AssignDnsZoneDto,
  ): Promise<ClusterDnsZoneResponseDto> {
    const assignment = await this.clusterDnsZoneService.assignZoneToCluster(
      clusterId,
      dto,
    );
    const withRelations = await this.clusterDnsZoneService.getById(
      assignment.id,
    );
    return this.clusterDnsZoneService.toResponseDto(withRelations);
  }

  @Get()
  @ApiOperation({
    summary: 'Get the primary (first-assigned) DNS zone for a cluster',
    description:
      "Backward-compat endpoint returning the cluster's first DNS zone " +
      'assignment. Use GET /list to retrieve all assigned zones.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: ClusterDnsZoneResponseDto })
  @ApiResponse({ status: 404, description: 'No DNS zone assigned to cluster' })
  async getZoneAssignment(
    @Param('clusterId') clusterId: string,
  ): Promise<ClusterDnsZoneResponseDto> {
    const assignment =
      await this.clusterDnsZoneService.getZoneAssignment(clusterId);
    if (!assignment) {
      throw new NotFoundException(
        `No DNS zone assigned to cluster ${clusterId}`,
      );
    }
    return this.clusterDnsZoneService.toResponseDto(assignment);
  }

  @Get('list')
  @ApiOperation({
    summary: 'List all DNS zone assignments for a cluster',
    description:
      'Returns all DNS zone assignments for the cluster. ' +
      'Endpoint FQDNs are matched to the assignment with the longest ' +
      'matching zone suffix.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 200,
    type: ClusterDnsZoneResponseDto,
    isArray: true,
  })
  async listZoneAssignments(
    @Param('clusterId') clusterId: string,
  ): Promise<ClusterDnsZoneResponseDto[]> {
    const zones =
      await this.clusterDnsZoneService.getZonesForCluster(clusterId);
    return zones.map((z) => this.clusterDnsZoneService.toResponseDto(z));
  }

  @Put()
  @ApiOperation({
    summary:
      'Update certificate configuration for the primary DNS zone assignment',
    description:
      "Backward-compat endpoint updating the cluster's first DNS zone " +
      'assignment. Prefer PUT /:assignmentId for multi-zone clusters.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: ClusterDnsZoneResponseDto })
  @ApiResponse({ status: 404, description: 'No DNS zone assigned to cluster' })
  async updatePrimaryCertConfig(
    @Param('clusterId') clusterId: string,
    @Body() dto: Partial<AssignDnsZoneDto>,
  ): Promise<ClusterDnsZoneResponseDto> {
    const assignment = await this.clusterDnsZoneService.updateCertConfig(
      clusterId,
      dto,
    );
    const withRelations = await this.clusterDnsZoneService.getById(
      assignment.id,
    );
    return this.clusterDnsZoneService.toResponseDto(withRelations);
  }

  @Put(':assignmentId')
  @ApiOperation({
    summary: 'Update certificate configuration for one DNS zone assignment',
    description:
      'Update the certificate provider, ACME email, and wildcard certificate settings for the given assignment.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({ name: 'assignmentId', description: 'Assignment ID' })
  @ApiResponse({ status: 200, type: ClusterDnsZoneResponseDto })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  async updateCertConfig(
    @Param('assignmentId') assignmentId: string,
    @Body() dto: Partial<AssignDnsZoneDto>,
  ): Promise<ClusterDnsZoneResponseDto> {
    const assignment = await this.clusterDnsZoneService.updateCertConfigById(
      assignmentId,
      dto,
    );
    const withRelations = await this.clusterDnsZoneService.getById(
      assignment.id,
    );
    return this.clusterDnsZoneService.toResponseDto(withRelations);
  }

  @Post(':assignmentId/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reconcile one DNS zone assignment',
    description:
      'Re-applies the cluster state the zone needs (DNS-01 credential Secrets ' +
      'and the wildcard ClusterIssuer solvers covering every assigned zone), ' +
      'publishes the `*.<cluster>` record so applications resolve the moment ' +
      'they are created rather than a minute later, ' +
      'and recomputes the reconciliation status of the assignment. Returns ' +
      'immediately with the assignment in RECONCILING — the cluster work runs ' +
      'in the background. Poll this assignment until it leaves RECONCILING: ' +
      'a zone that cannot be reconciled lands in ERROR with the reason in ' +
      'errorMessage.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({ name: 'assignmentId', description: 'Assignment ID' })
  @ApiResponse({ status: 200, type: ClusterDnsZoneResponseDto })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  async reconcileAssignment(
    @Param('assignmentId') assignmentId: string,
  ): Promise<ClusterDnsZoneResponseDto> {
    const assignment =
      await this.clusterDnsZoneService.startReconcileAssignment(assignmentId);
    return this.clusterDnsZoneService.toResponseDto(assignment);
  }

  @Get(':assignmentId/wildcard')
  // The `app:*` pair on the two wildcard routes is not a claim that DNS is
  // application work — it is what the declared model already says: `mcp:app:read`
  // carries "the DNS status behind an application" and `mcp:app:write` carries
  // "publishing the wildcard DNS record" (see `api-key-groups.ts`). Naming a
  // cluster permission here would put the routes outside the ceiling of the very
  // scope that calls them, which is the drift decision 82 exists to catch.
  // Nobody loses either: the controller has no gate at all today, and every
  // built-in role but `viewer` and `showcase_viewer` holds `app:write`.
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Whether one record covers every application on this cluster',
    description:
      'Applications are published at `<slug>.<cluster>.<zone>` and all point at the same address, so a single `*.<cluster>` record covers every one of them — including the ones that do not exist yet. That is what makes a newly deployed application reachable immediately instead of waiting for a brand-new name to propagate. Read live from the DNS provider, so a record removed by hand shows as missing here.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({ name: 'assignmentId', description: 'Assignment ID' })
  @ApiResponse({ status: 200, type: ClusterWildcardResponseDto })
  async getWildcard(
    @Param('assignmentId') assignmentId: string,
  ): Promise<ClusterWildcardResponseDto> {
    return this.clusterDnsZoneService.getClusterWildcardStatus(assignmentId);
  }

  @Post(':assignmentId/wildcard')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish the record that covers every application on this cluster',
    description:
      'Creates `*.<cluster>` pointing at the cluster. Never overwrites: a wildcard already pointing somewhere else is left exactly as it is and comes back as `foreign` — those applications keep getting their own per-app records, which still work, only slower. A full zone reconcile does this as well; this is the narrow version, for when that one record is the only thing missing.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({ name: 'assignmentId', description: 'Assignment ID' })
  @ApiResponse({ status: 200, type: ClusterWildcardResponseDto })
  async publishWildcard(
    @Param('assignmentId') assignmentId: string,
  ): Promise<ClusterWildcardResponseDto> {
    return this.clusterDnsZoneService.publishClusterWildcard(assignmentId);
  }

  @Get('issuers')
  @ApiOperation({
    summary: 'Get cert-manager ClusterIssuers configured in the cluster',
    description:
      'Returns the status of letsencrypt-staging and letsencrypt-production ClusterIssuers. ' +
      'solverType indicates whether the issuer is configured for http01 (standard domains) ' +
      'or dns01 (required for wildcard certificates). ' +
      'If solverType is http01 but wildcardCertificate is enabled on the zone, ' +
      'call configure-issuer again to upgrade to dns01.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 200,
    description: 'List of ClusterIssuers with ready status and solver type',
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', example: 'letsencrypt-staging' },
          ready: { type: 'boolean' },
          email: { type: 'string', nullable: true },
          solverType: {
            type: 'string',
            enum: ['http01', 'dns01', 'combined'],
            nullable: true,
            description:
              'http01 = standard domains only. ' +
              'combined = dns01 for wildcard (*.zone) + http01 fallback for all other domains.',
          },
          message: {
            type: 'string',
            nullable: true,
            description:
              'Status message from cert-manager (useful when ready is false)',
          },
        },
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getIssuers(@Param('clusterId') clusterId: string): Promise<
    {
      name: string;
      ready: boolean;
      email: string | null;
      solverType: 'http01' | 'dns01' | 'combined' | null;
      message: string | null;
    }[]
  > {
    return this.clusterDnsZoneService.getIssuers(clusterId);
  }

  @Post('configure-issuer')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Create or update cert-manager ClusterIssuers in the cluster',
    description:
      'Applies letsencrypt-staging and letsencrypt-production ClusterIssuer resources ' +
      'to the cluster using the provided ACME email. Must be called after cert-manager is installed.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 204,
    description: 'ClusterIssuers applied successfully',
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async configureIssuer(
    @Param('clusterId') clusterId: string,
    @Body() dto: ConfigureIssuerDto,
  ): Promise<void> {
    await this.clusterDnsZoneService.configureIssuer(clusterId, dto);
  }

  @Post('configure-issuer/dns-secret')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Apply the DNS token Secret required for wildcard certificate issuers',
    description:
      'Step 1 of wildcard certificate setup. ' +
      'Applies the DNS token Secret (hetzner-secret) in the cert-manager namespace and waits until ' +
      'it is confirmed readable. Must be called before configure-issuer/dns-issuers. ' +
      'cert-manager validates the Secret at ClusterIssuer apply time — if it is not ' +
      'yet visible in the cluster the ClusterIssuer will fail with "secret not found".',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 204,
    description: 'DNS token Secret applied and confirmed ready',
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async configureDnsSecret(
    @Param('clusterId') clusterId: string,
  ): Promise<void> {
    await this.clusterDnsZoneService.applyDnsSecret(clusterId);
  }

  @Post('configure-issuer/dns-issuers')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Apply wildcard ClusterIssuers (dns01 solver)',
    description:
      'Step 2 of wildcard certificate setup. ' +
      'Applies letsencrypt-staging-wildcard and letsencrypt-production-wildcard ClusterIssuers ' +
      'using the DNS-01 solver. The DNS token Secret must exist before calling this endpoint ' +
      '(call configure-issuer/dns-secret first). ' +
      'Returns 400 if the Secret is not found.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 204,
    description: 'Wildcard ClusterIssuers applied successfully',
  })
  @ApiResponse({
    status: 400,
    description:
      'DNS token Secret not found — call configure-issuer/dns-secret first',
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async configureDnsIssuers(
    @Param('clusterId') clusterId: string,
    @Body() dto: ConfigureIssuerDto,
  ): Promise<void> {
    await this.clusterDnsZoneService.applyDnsIssuersOnly(clusterId, dto);
  }

  @Get('internal-hosting')
  @ApiOperation({
    summary: 'Read the internal hosting status of a cluster',
    description:
      'Returns whether `exposure=internal` apps can be created on this cluster, plus granular missing prerequisites and the host template. Internal hosting reuses the public endpoint pipeline (per-app DNS record + per-app cert via wildcard DNS01 issuer) — the prerequisites are therefore identical to public hosting: DNS zone assigned + wildcard issuer Ready. The only difference vs public is the FQDN pattern (`<slug>.internal.<zone>`) and the Traefik Middleware ForwardAuth applied in front of the Ingress.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 200,
    description:
      'Internal hosting status. `enabled: true` means DNS zone + wildcard issuer are ready and new internal apps can be created.',
  })
  async getInternalHostingStatus(
    @Param('clusterId') clusterId: string,
  ): Promise<{
    clusterId: string;
    enabled: boolean;
    missingRequirements: string[];
    zoneName?: string;
    internalHostTemplate?: string;
  }> {
    const status =
      await this.clusterDnsZoneService.getInternalHostingStatus(clusterId);
    return {
      clusterId,
      enabled: status.ready,
      missingRequirements: status.missing,
      zoneName: status.zoneName,
      internalHostTemplate: status.zoneName
        ? `{slug}.internal.${status.zoneName}`
        : undefined,
    };
  }

  @Post('configure-issuer/:type')
  @HttpCode(HttpStatus.NO_CONTENT)
  // Bound to the issuer type as well as to the cluster: conceding "always
  // rewrite the http issuers here" must not also concede the wildcard ones.
  @ActionCycle({
    action: 'POST /clusters/:clusterId/dns-zone/configure-issuer/:type',
    bind: ['clusterId', 'type'],
    sentence: 'rewrite the {type} certificate issuers of cluster {clusterId}',
    estimate: '/clusters/:clusterId/dns-zone/issuers',
  })
  @ApiOperation({
    summary: 'Create or update cert-manager ClusterIssuers by type',
    description:
      'Creates/updates both staging and production issuers for the selected type. ' +
      'type=http -> letsencrypt-staging + letsencrypt-production. ' +
      'type=dns -> letsencrypt-staging-wildcard + letsencrypt-production-wildcard.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({
    name: 'type',
    description: 'Issuer type',
    enum: ['http', 'dns'],
  })
  @ApiResponse({
    status: 204,
    description: 'ClusterIssuers applied successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid issuer type' })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async configureIssuerByType(
    @Param('clusterId') clusterId: string,
    @Param('type') type: string,
    @Body() dto: ConfigureIssuerDto,
  ): Promise<void> {
    const issuerType = this.parseIssuerType(type);
    await this.clusterDnsZoneService.configureIssuerByType(
      clusterId,
      dto,
      issuerType,
    );
  }

  @Delete('issuers')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete cert-manager ClusterIssuers from the cluster',
    description:
      'Removes letsencrypt-staging and letsencrypt-production ClusterIssuer resources from K8s. ' +
      'Emits cluster:issuer:deleted via WebSocket on success, ' +
      'cluster:issuer:deletion_failed on error. ' +
      'Idempotent: already-absent issuers are treated as successfully deleted.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 204, description: 'ClusterIssuers deleted' })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  @ApiResponse({
    status: 500,
    description: 'One or more issuers could not be deleted',
  })
  async deleteIssuers(@Param('clusterId') clusterId: string): Promise<void> {
    await this.clusterDnsZoneService.deleteIssuers(clusterId);
  }

  @Delete('issuers/:type')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete cert-manager ClusterIssuers by type',
    description:
      'Deletes both staging and production issuers for the selected type. ' +
      'type=http -> letsencrypt-staging + letsencrypt-production. ' +
      'type=dns -> letsencrypt-staging-wildcard + letsencrypt-production-wildcard.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({
    name: 'type',
    description: 'Issuer type',
    enum: ['http', 'dns'],
  })
  @ApiResponse({ status: 204, description: 'ClusterIssuers deleted' })
  @ApiResponse({ status: 400, description: 'Invalid issuer type' })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async deleteIssuersByType(
    @Param('clusterId') clusterId: string,
    @Param('type') type: string,
  ): Promise<void> {
    const issuerType = this.parseIssuerType(type);
    await this.clusterDnsZoneService.deleteIssuersByType(clusterId, issuerType);
  }

  @Get('system-status')
  @ApiOperation({
    summary:
      'Get DNS and TLS status for system apps (flui-api, flui-web, zitadel)',
    description:
      'Returns the ingress and certificate status for the three core platform apps. ' +
      'Use this to determine whether to show a setup alert in the frontend.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: SystemDnsStatusResponseDto })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getSystemDnsStatus(
    @Param('clusterId') clusterId: string,
  ): Promise<SystemDnsStatusResponseDto> {
    return this.clusterDnsZoneService.getSystemDnsStatus(clusterId);
  }

  @Post('configure-system-ingress')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Create or update system Ingress resources (flui-api, flui-web)',
    description:
      'Applies Ingress resources for flui-api and flui-web with TLS via cert-manager. ' +
      'Requires ClusterIssuers to be configured first.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 204,
    description: 'System Ingress applied successfully',
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async configureSystemIngress(
    @Param('clusterId') clusterId: string,
    @Body() dto: ConfigureSystemIngressDto,
  ): Promise<void> {
    await this.systemIngressService.configureSystemIngress(clusterId, dto);
  }

  @Get('cert-diagnostics')
  @ApiOperation({
    summary: 'Get full cert-manager diagnostic chain for a cluster',
    description:
      'Returns the Certificate → CertificateRequest → Order → Challenge resource chain ' +
      'from cert-manager. Useful for diagnosing failed or stale ACME authorizations, ' +
      'identifying rate limit situations, and understanding certificate issuance failures.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiQuery({
    name: 'namespace',
    required: false,
    description:
      'Kubernetes namespace to query. Omit to search all namespaces (recommended — ' +
      'Certificates live in the app namespace, not in cert-manager).',
  })
  @ApiResponse({ status: 200, type: CertDiagnosticsResponseDto })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async getCertDiagnostics(
    @Param('clusterId') clusterId: string,
    @Query('namespace') namespace?: string,
  ): Promise<CertDiagnosticsResponseDto> {
    return this.clusterDnsZoneService.getCertDiagnostics(clusterId, namespace);
  }

  @Post('sync-auth-domain')
  @ApiOperation({
    summary: 'Sync the auth provider domain to the configured FQDN',
    description:
      'Reads the auth application endpoint FQDN already configured in the database, ' +
      'then calls the auth provider admin API to add the new domain and set it as primary. ' +
      'Also updates the Kubernetes ConfigMap and triggers a rolling restart of the auth deployment. ' +
      'Requires ZITADEL_SERVICE_ACCOUNT_PAT secret to be configured.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 201,
    description: 'Domain sync result',
    type: AuthDomainSyncResultDto,
  })
  @ApiResponse({
    status: 400,
    description: 'FQDN not configured or PAT missing',
  })
  @ApiResponse({ status: 404, description: 'Cluster or auth app not found' })
  async syncAuthDomain(
    @Param('clusterId') clusterId: string,
    @Body() dto: SyncAuthDomainDto,
  ): Promise<AuthDomainSyncResultDto> {
    return this.authDomainSyncService.syncAuthDomain(clusterId, dto);
  }

  @Post('sync-api-domain')
  @ApiOperation({
    summary: 'Sync flui-api, flui-web and zitadel domains into flui-secrets',
    description:
      'Reads the FQDN already configured for the three system applications (flui-api, flui-web, zitadel) ' +
      'from their AppEndpoint records, then patches flui-secrets in the cluster with the corresponding ' +
      'environment variables (PUBLIC_API_URL, FRONTEND_URL, OIDC_ISSUER, etc.) ' +
      'and triggers a rolling restart of the flui-api deployment.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 201,
    description: 'Domain sync result',
    type: ApiDomainSyncResultDto,
  })
  @ApiResponse({
    status: 400,
    description: 'FQDN not configured for one or more applications',
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async syncApiDomain(
    @Param('clusterId') clusterId: string,
    @Body() dto: SyncApiDomainDto,
  ): Promise<ApiDomainSyncResultDto> {
    return this.apiDomainSyncService.syncApiDomain(clusterId, dto);
  }

  @Post('sync-web-domain')
  @ApiOperation({
    summary: 'Sync flui-web ConfigMap with the configured domains',
    description:
      'Reads the FQDN already configured for flui-api and zitadel from their AppEndpoint records, ' +
      'then updates the flui-web-config ConfigMap (config.json) with apiUrl and authUrl, ' +
      'and triggers a rolling restart of the flui-web deployment.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 201,
    description: 'Web domain sync result',
    type: WebDomainSyncResultDto,
  })
  @ApiResponse({
    status: 400,
    description: 'FQDN not configured for one or more applications',
  })
  @ApiResponse({ status: 404, description: 'Cluster not found' })
  async syncWebDomain(
    @Param('clusterId') clusterId: string,
    @Body() dto: SyncWebDomainDto,
  ): Promise<WebDomainSyncResultDto> {
    return this.webDomainSyncService.syncWebDomain(clusterId, dto);
  }

  @Delete()
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove all DNS zone assignments from a cluster',
    description:
      'Backward-compat endpoint removing every DNS zone assigned to the ' +
      'cluster. Prefer DELETE /:assignmentId for selective removal.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 204, description: 'All zone assignments removed' })
  @ApiResponse({ status: 404, description: 'No DNS zone assigned to cluster' })
  async removeZone(@Param('clusterId') clusterId: string): Promise<void> {
    await this.clusterDnsZoneService.removeZoneFromCluster(clusterId);
  }

  @Delete(':assignmentId')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a single DNS zone assignment from a cluster',
    description:
      'Remove one DNS zone assignment. Endpoints that were matching ' +
      'this zone will become BYOD (user manages DNS externally).',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({ name: 'assignmentId', description: 'Assignment ID' })
  @ApiResponse({ status: 204, description: 'Zone assignment removed' })
  @ApiResponse({ status: 404, description: 'Assignment not found' })
  async removeAssignment(
    @Param('assignmentId') assignmentId: string,
  ): Promise<void> {
    await this.clusterDnsZoneService.removeAssignment(assignmentId);
  }
}
