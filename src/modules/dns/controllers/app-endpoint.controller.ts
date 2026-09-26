import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Req,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { AppEndpointService } from '../services/app-endpoint.service';
import { AppEndpointReconciliationService } from '../services/app-endpoint-reconciliation.service';
import { ClusterDnsGateway } from '../gateway/cluster-dns.gateway';
import { CertificateStatusRefreshService } from '../services/certificate-status-refresh.service';
import { CreateAppEndpointDto } from '../dto/create-app-endpoint.dto';
import { UpdateAppEndpointDto } from '../dto/update-app-endpoint.dto';
import { AppEndpointResponseDto } from '../dto/app-endpoint-response.dto';
import { EndpointSyncResponseDto } from '../dto/endpoint-sync.dto';
import { CertificateStatus } from '../../providers/interfaces/certificate-provider.interface';

@ApiTags('App Endpoints')
@ApiBearerAuth()
@Controller()
export class AppEndpointController {
  private readonly logger = new Logger(AppEndpointController.name);

  constructor(
    private readonly appEndpointService: AppEndpointService,
    private readonly reconciliationService: AppEndpointReconciliationService,
    private readonly clusterDnsGateway: ClusterDnsGateway,
    private readonly appAccess: ApplicationAccessService,
    private readonly applications: ApplicationsRepository,
    private readonly certificateStatus: CertificateStatusRefreshService,
  ) {}

  private refreshCertStatusIfNeeded(endpointId: string): Promise<void> {
    return this.certificateStatus.refreshIfNeeded(endpointId);
  }

  @Get('endpoints/check-fqdn')
  @ApiOperation({
    summary: 'Check whether a fqdn is available for a new endpoint',
    description:
      'Returns { available: false } when the fqdn is already used by another endpoint. ' +
      'Does not reveal which endpoint owns the conflicting domain.',
  })
  @ApiResponse({
    status: 200,
    description: '{ fqdn, available }',
  })
  async checkFqdn(
    @Query('fqdn') fqdn: string,
  ): Promise<{ fqdn: string; available: boolean }> {
    if (!fqdn || typeof fqdn !== 'string' || fqdn.trim().length === 0) {
      throw new BadRequestException('Query parameter "fqdn" is required');
    }
    const normalized = this.appEndpointService.normalizeFqdn(fqdn);
    const available = await this.appEndpointService.isFqdnAvailable(normalized);
    return { fqdn: normalized, available };
  }

  @Post('clusters/:clusterId/endpoints')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Create an app endpoint for a cluster',
    description:
      'Register an application endpoint with its FQDN, Kubernetes service details, and optional DNS zone. ' +
      'If fqdn is omitted, a default is generated as {serviceName}.{clusterName}.{zoneName}. ' +
      'If clusterDnsZoneId is omitted, DNS management is BYOD (user manages DNS externally).',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 201, type: AppEndpointResponseDto })
  @ApiResponse({ status: 404, description: 'Cluster or DNS zone not found' })
  async createEndpoint(
    @Param('clusterId') clusterId: string,
    @Body() dto: CreateAppEndpointDto,
    @Req() req: Request,
  ): Promise<AppEndpointResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenException('Unauthenticated');
    const app = await this.applications.findById(dto.applicationId);
    if (!app)
      throw new NotFoundException(`Application ${dto.applicationId} not found`);
    if (app.clusterId !== clusterId) {
      throw new BadRequestException(
        'The application does not run on this cluster.',
      );
    }
    await this.appAccess.assertCan(user, IAM_PERMISSION.APP_WRITE, app);
    const endpoint = await this.appEndpointService.createEndpoint(
      clusterId,
      dto,
    );
    const withRelations = await this.appEndpointService.getEndpoint(
      endpoint.id,
    );
    return this.appEndpointService.toResponseDto(withRelations);
  }

  @Get('clusters/:clusterId/endpoints')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({ summary: 'List all app endpoints for a cluster' })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: [AppEndpointResponseDto] })
  async listEndpoints(
    @Param('clusterId') clusterId: string,
    @Req() req: Request,
  ): Promise<AppEndpointResponseDto[]> {
    const endpoints = await this.appEndpointService.listEndpoints(clusterId);
    await Promise.all(
      endpoints
        .filter((e) => e.certificateStatus === CertificateStatus.ISSUING)
        .map((e) => this.refreshCertStatusIfNeeded(e.id)),
    );
    const refreshed = await this.appEndpointService.listEndpoints(clusterId);
    const readable = await this.readableApps(
      req.user as AuthenticatedUser | undefined,
      refreshed.map((e) => e.applicationId),
    );
    return refreshed
      .filter((e) => readable === null || readable.has(e.applicationId))
      .map((e) => this.appEndpointService.toResponseDto(e));
  }

  @Get('endpoints/:id')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({ summary: 'Get an app endpoint by ID' })
  @ApiParam({ name: 'id', description: 'Endpoint ID' })
  @ApiResponse({ status: 200, type: AppEndpointResponseDto })
  @ApiResponse({ status: 404, description: 'Endpoint not found' })
  async getEndpoint(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<AppEndpointResponseDto> {
    await this.assertMayOnEndpoint(
      id,
      req.user as AuthenticatedUser,
      IAM_PERMISSION.APP_READ,
    );
    await this.refreshCertStatusIfNeeded(id);
    const endpoint = await this.appEndpointService.getEndpoint(id);
    return this.appEndpointService.toResponseDto(endpoint);
  }

  @Put('endpoints/:id')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary: 'Update an app endpoint',
    description:
      'Update FQDN, Kubernetes service details, or DNS zone assignment.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint ID' })
  @ApiResponse({ status: 200, type: AppEndpointResponseDto })
  @ApiResponse({ status: 404, description: 'Endpoint not found' })
  async updateEndpoint(
    @Param('id') id: string,
    @Body() dto: UpdateAppEndpointDto,
    @Req() req: Request,
  ): Promise<AppEndpointResponseDto> {
    await this.assertMayChangeEndpoint(id, req.user as AuthenticatedUser);
    const before = await this.appEndpointService.getEndpoint(id);
    const renamed =
      dto.fqdn !== undefined &&
      this.appEndpointService.normalizeFqdn(dto.fqdn) !== before.fqdn;
    if (renamed) {
      const fqdn = this.appEndpointService.normalizeFqdn(dto.fqdn as string);
      if (!(await this.appEndpointService.isFqdnAvailable(fqdn))) {
        throw new ConflictException(
          `${fqdn} is already used by another endpoint.`,
        );
      }
      // The old name's record, certificate and route are this endpoint's to
      // remove before it takes the new one; left behind they keep answering.
      await this.reconciliationService.deleteEndpointResources(id);
      await this.appEndpointService.clearDnsRecord(id);
      dto = { ...dto, fqdn };
    }
    await this.appEndpointService.updateEndpoint(id, dto);
    if (renamed) await this.appEndpointService.markDrift(id);
    // Same path as Add: the change is published now, and the answer carries
    // each step's state and the error when one fails.
    await this.reconciliationService.reconcile(id);
    return this.appEndpointService.toResponseDto(
      await this.appEndpointService.getEndpoint(id),
    );
  }

  /**
   * Two gates for two questions, and neither was here before.
   *
   * `app:write` is what the ceiling reads — the endpoint is reached from the
   * application's own DNS tab, so a key minted to look at applications must not
   * take their address away. The ownership assertion is what decides *whose*
   * endpoint this is: the handler took an id and removed the row, so any
   * authenticated account could unpublish somebody else's application by
   * guessing a uuid, and the DNS record and Ingress went with it.
   */
  @Delete('endpoints/:id')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove an app endpoint',
    description:
      'Remove the endpoint and clean up its DNS record, TLS certificate, and Kubernetes Ingress.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint ID' })
  @ApiResponse({ status: 204, description: 'Endpoint removed' })
  async deleteEndpoint(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.assertMayChangeEndpoint(id, req.user as AuthenticatedUser);
    await this.reconciliationService.deleteEndpointResources(id);
    await this.appEndpointService.deleteEndpoint(id);
  }

  private assertMayChangeEndpoint(
    endpointId: string,
    user: AuthenticatedUser | undefined,
  ): Promise<void> {
    return this.assertMayOnEndpoint(endpointId, user, IAM_PERMISSION.APP_WRITE);
  }

  private async assertMayOnEndpoint(
    endpointId: string,
    user: AuthenticatedUser | undefined,
    action: string,
  ): Promise<void> {
    if (!user) throw new ForbiddenException('Unauthenticated');
    const endpoint = await this.appEndpointService.getEndpoint(endpointId);
    const app = await this.applications.findById(endpoint.applicationId);
    // An endpoint whose application is gone is nobody's to keep: the row is
    // orphaned, and refusing it would leave it unremovable.
    if (!app) return;
    await this.appAccess.assertCan(user, action, app);
  }

  /** The applications of these ids the caller may read; null for a caller who reads all. */
  private async readableApps(
    user: AuthenticatedUser | undefined,
    ids: string[],
  ): Promise<Set<string> | null> {
    if (!user) throw new ForbiddenException('Unauthenticated');
    const apps = await Promise.all(
      [...new Set(ids)].map((id) => this.applications.findById(id)),
    );
    const found = apps.filter((a): a is NonNullable<typeof a> => !!a);
    const readable = await this.appAccess.filterReadable(user, found);
    const allowed = new Set(readable.map((a) => a.id));
    // An endpoint whose application is gone belongs to nobody and stays listed,
    // so it can still be found and removed.
    for (const id of ids) if (!found.some((a) => a.id === id)) allowed.add(id);
    return allowed;
  }

  @Post('endpoints/:id/reconcile')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync an app endpoint',
    description:
      'Bring the address record, the route and the certificate in line; a per-host certificate that failed is ordered again. `sync` says what was found and done.',
  })
  @ApiParam({ name: 'id', description: 'Endpoint ID' })
  @ApiResponse({ status: 200, type: EndpointSyncResponseDto })
  async reconcile(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<EndpointSyncResponseDto> {
    await this.assertMayChangeEndpoint(id, req.user as AuthenticatedUser);
    const sync = await this.reconciliationService.syncEndpoint(id);
    const endpoint = await this.appEndpointService.getEndpoint(id);
    return { ...this.appEndpointService.toResponseDto(endpoint), sync };
  }

  @Get('endpoints/:id/status')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Get reconciliation and certificate status for an endpoint',
  })
  @ApiParam({ name: 'id', description: 'Endpoint ID' })
  @ApiResponse({ status: 200, type: AppEndpointResponseDto })
  async getStatus(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<AppEndpointResponseDto> {
    return this.getEndpoint(id, req);
  }
}
