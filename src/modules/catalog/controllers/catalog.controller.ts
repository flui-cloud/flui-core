import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { Public } from '../../auth/decorators/public.decorator';
import { CatalogService } from '../services/catalog.service';
import { CatalogInstallerService } from '../services/catalog-installer.service';
import { CatalogDependencyResolverService } from '../services/catalog-dependency-resolver.service';
import { CatalogSchemaValidatorService } from '../services/catalog-schema-validator.service';
import { CatalogInstallRepository } from '../repositories/catalog-install.repository';
import { CatalogResponseDto } from '../dto/catalog-response.dto';
import { CatalogClientResponseDto } from '../dto/catalog-client-response.dto';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { CatalogDetailResponseDto } from '../dto/catalog-detail-response.dto';
import { CatalogYamlResponseDto } from '../dto/catalog-yaml-response.dto';
import { CatalogInstallResponseDto } from '../dto/catalog-install-response.dto';
import { CatalogClusterCapabilitiesDto } from '../dto/catalog-cluster-capabilities.dto';
import { CatalogReusableInstanceDto } from '../dto/catalog-reusable-instance.dto';
import {
  CatalogValidateRequestDto,
  CatalogValidateResponseDto,
} from '../dto/catalog-validate.dto';
import { InstallCatalogAppDto } from '../dto/install-catalog-app.dto';
import { InstallFromYamlDto } from '../dto/install-from-yaml.dto';
import { CatalogCapacityPreviewDto } from '../dto/catalog-capacity-preview.dto';
import { ResourceAvailabilityResponseDto } from '../../infrastructure/clusters/dto/resource-availability.dto';
import { ConnectClientDto } from '../dto/connect-client.dto';
import { CatalogInstallEntity } from '../entities/catalog-install.entity';

@ApiTags('Catalog')
@Controller('catalog')
export class CatalogController {
  constructor(
    private readonly catalogService: CatalogService,
    private readonly installer: CatalogInstallerService,
    private readonly dependencyResolver: CatalogDependencyResolverService,
    private readonly installRepo: CatalogInstallRepository,
    private readonly schemaValidator: CatalogSchemaValidatorService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List published catalog apps (public)' })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'appKind', enum: ApplicationKind, required: false })
  @ApiQuery({ name: 'tags', required: false, isArray: true })
  @ApiQuery({ name: 'search', required: false })
  @ApiResponse({ status: 200, type: [CatalogResponseDto] })
  async list(
    @Query('category') category?: string,
    @Query('appKind') appKind?: ApplicationKind,
    @Query('tags') tags?: string | string[],
    @Query('search') search?: string,
  ): Promise<CatalogResponseDto[]> {
    let normalizedTags: string[] | undefined;
    if (Array.isArray(tags)) normalizedTags = tags;
    else if (tags) normalizedTags = [tags];
    return this.catalogService.listPublic({
      category,
      appKind,
      tags: normalizedTags,
      search,
    });
  }

  @ApiBearerAuth()
  @Get('building-blocks')
  @ApiOperation({
    summary: 'List catalog building blocks (authed)',
    description:
      'Returns active building-block catalog apps (databases, caches, queues). These are NOT exposed on GET /catalog because they are not meant to be installed standalone — they are dependencies of composed or dependency-aware standalone apps. The install wizard uses this endpoint to populate the dependency picker for Iter 3.',
  })
  @ApiResponse({ status: 200, type: [CatalogResponseDto] })
  async listBuildingBlocks(): Promise<CatalogResponseDto[]> {
    return this.catalogService.listBuildingBlocks();
  }

  @ApiBearerAuth()
  @Get('building-blocks/:slug/reusable-instances')
  @ApiOperation({
    summary:
      'List running instances of a building block reusable as a dependency',
    description:
      'Returns applications on the given cluster that were installed as the specified building block (e.g. "postgresql") and are currently RUNNING or DEGRADED. The install wizard offers these as "reuse existing" options when a manifest declares a dependency with reuseExisting=true.',
  })
  @ApiParam({
    name: 'slug',
    description: 'Building-block catalog slug (e.g. "postgresql")',
  })
  @ApiQuery({ name: 'clusterId', required: true })
  @ApiResponse({ status: 200, type: [CatalogReusableInstanceDto] })
  async listReusableInstances(
    @Param('slug') slug: string,
    @Query('clusterId') clusterId: string,
  ): Promise<CatalogReusableInstanceDto[]> {
    return this.dependencyResolver.findReusableInstances(slug, clusterId);
  }

  @Public()
  @Get('schema/flui-v1.json')
  @ApiOperation({
    summary: 'Get the JSON Schema for flui/v1 catalog manifests (public)',
    description:
      'Returns the JSON Schema used by the backend (ajv) to validate catalog manifests. Frontend YAML editors (Monaco, CodeMirror) can register this schema to provide autocomplete, hover docs, and inline validation. Same schema enforced server-side, so what the editor accepts the API will accept.',
  })
  @ApiResponse({ status: 200 })
  getManifestSchema(): unknown {
    return this.schemaValidator.getSchema();
  }

  @Public()
  @Get(':slug')
  @ApiOperation({ summary: 'Get catalog app detail by slug (public)' })
  @ApiParam({ name: 'slug' })
  @ApiQuery({
    name: 'clusterId',
    required: false,
    description:
      'Optional. When provided, the response includes `installable` + `notInstallableReason` computed against the target cluster (e.g. an `exposure: internal` app on a cluster without internal hosting becomes `installable: false`). Without it, `installable` is always true.',
  })
  @ApiResponse({ status: 200, type: CatalogDetailResponseDto })
  async getDetail(
    @Param('slug') slug: string,
    @Query('clusterId') clusterId?: string,
  ): Promise<CatalogDetailResponseDto> {
    return this.catalogService.getDetailBySlug(slug, clusterId);
  }

  @Public()
  @Get(':slug/yaml')
  @ApiOperation({
    summary: 'Get the raw flui.yaml manifest of a catalog app (public)',
    description:
      'Returns the raw YAML manifest as authored, plus version and checksum. Intended for an "Advanced / Show YAML" panel in the dashboard so power users can inspect the manifest behind a catalog app.',
  })
  @ApiParam({ name: 'slug' })
  @ApiResponse({ status: 200, type: CatalogYamlResponseDto })
  async getYaml(@Param('slug') slug: string): Promise<CatalogYamlResponseDto> {
    return this.catalogService.getRawYamlBySlug(slug);
  }

  @Public()
  @Get(':slug/clients')
  @ApiOperation({
    summary:
      'List catalog apps that are clients/UIs for a given building block',
    description:
      'Returns catalog apps whose manifest declares :slug in metadata.clientFor (e.g. pgweb for postgresql, dbgate for mariadb/postgresql/valkey). Each entry carries an `isDefault` flag derived from metadata.clientDefaultFor, so the FE can pre-select the recommended client. Results are ordered with defaults first, then alphabetically.',
  })
  @ApiParam({ name: 'slug' })
  @ApiResponse({ status: 200, type: [CatalogClientResponseDto] })
  async listClients(
    @Param('slug') slug: string,
  ): Promise<CatalogClientResponseDto[]> {
    return this.catalogService.listClientsOf(slug);
  }

  @ApiBearerAuth()
  @Post('validate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate a raw flui.yaml manifest',
    description:
      'Parses, JSON-Schema-validates (ajv, flui/v1), and runs cycle detection on a catalog manifest provided as raw YAML. Returns the canonical manifest + checksum + preview on success, or a list of errors on failure. Does not persist anything.',
  })
  @ApiResponse({ status: 200, type: CatalogValidateResponseDto })
  async validate(
    @Body() dto: CatalogValidateRequestDto,
  ): Promise<CatalogValidateResponseDto> {
    return this.catalogService.validateManifest(dto.yaml);
  }

  @ApiBearerAuth()
  @Post(':slug/capacity-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview whether a cluster can fit a catalog install',
    description:
      'Computes the install footprint — the same options + override-aware sum the install capacity gate uses (CPU on requests, memory on limits, option-gated components included only when enabled) — and checks it against live cluster capacity. The deploy wizard calls this with the selected options/overrides and renders required/available/canDeploy, so the preview never drifts from the server-side gate. Returns the same shape as GET /clusters/:id/resource-availability.',
  })
  @ApiParam({ name: 'slug' })
  @ApiResponse({ status: 200, type: ResourceAvailabilityResponseDto })
  async capacityPreview(
    @Param('slug') slug: string,
    @Body() dto: CatalogCapacityPreviewDto,
  ): Promise<ResourceAvailabilityResponseDto> {
    const definition = await this.catalogService.findPublishedBySlug(slug);
    return this.installer.previewCapacity(definition, dto);
  }

  @ApiBearerAuth()
  @Get('clusters/:clusterId/capabilities')
  @ApiOperation({
    summary:
      'Check if a cluster can auto-assign domain + TLS for catalog installs',
    description:
      'Returns hasDnsZone, hasWildcardIssuer, and canAutoAssignDomain. Frontend uses this to decide whether to render "auto-assigned domain" UI or ask the user to configure DNS/TLS after install.',
  })
  @ApiParam({ name: 'clusterId' })
  @ApiResponse({ status: 200, type: CatalogClusterCapabilitiesDto })
  async getClusterCapabilities(
    @Param('clusterId') clusterId: string,
  ): Promise<CatalogClusterCapabilitiesDto> {
    return this.catalogService.getClusterCapabilities(clusterId);
  }

  @ApiBearerAuth()
  @Post('install-from-yaml')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Install a catalog app directly from a raw .flui.yaml',
    description:
      'Parses and validates the provided YAML, upserts the app definition in the catalog DB (same as the boot seeder), then queues an install job. Designed for CLI smoke-tests and agentic workflows where the app has not been pre-seeded. userInput fields not provided in userInputs are auto-filled with test-safe defaults.',
  })
  @ApiResponse({ status: 202, type: CatalogInstallResponseDto })
  async installFromYaml(
    @Body() dto: InstallFromYamlDto,
    @Req() req: Request,
  ): Promise<CatalogInstallResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    const definition = await this.catalogService.upsertFromYaml(dto.yaml);
    const installDto: InstallCatalogAppDto = {
      clusterId: dto.clusterId,
      displayName: dto.displayName ?? definition.name,
      domain: dto.domain,
      certChallenge: dto.certChallenge,
      certificateProvider: dto.certificateProvider,
      hostnameMode: dto.hostnameMode,
      tls: dto.tls,
      skipEndpoint: dto.skipEndpoint,
      userInputs: dto.userInputs,
      envOverrides: dto.envOverrides,
      resourceOverrides: dto.resourceOverrides,
      exposure: dto.exposure,
      authMode: dto.authMode,
      options: dto.options,
      force: dto.force,
      allowMasterPlacement: dto.allowMasterPlacement,
      dependencyChoices: dto.dependencyChoices,
    };
    const { install } = await this.installer.install(
      definition.slug,
      installDto,
      user?.userId,
      user?.email,
    );
    return this.toResponse(install);
  }

  @ApiBearerAuth()
  @Post(':slug/install')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Install a catalog app on a cluster' })
  @ApiParam({ name: 'slug' })
  @ApiResponse({ status: 202, type: CatalogInstallResponseDto })
  async install(
    @Param('slug') slug: string,
    @Body() dto: InstallCatalogAppDto,
    @Req() req: Request,
  ): Promise<CatalogInstallResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    // The requirements↔cluster gate (incl. internal-hosting) now lives in
    // installer.install(), so every caller (HTTP, install-from-yaml, MCP) shares it.
    const { install } = await this.installer.install(
      slug,
      dto,
      user?.userId,
      user?.email,
    );
    return this.toResponse(install);
  }

  @ApiBearerAuth()
  @Get('installs/:id')
  @ApiOperation({ summary: 'Get install status' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: CatalogInstallResponseDto })
  async getInstall(
    @Param('id') id: string,
  ): Promise<CatalogInstallResponseDto> {
    const install = await this.installRepo.findById(id);
    if (!install) {
      throw new NotFoundException(`Install ${id} not found`);
    }
    return this.toResponse(install);
  }

  @ApiBearerAuth()
  @Post('installs/:id/connect')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Connect (or switch) a catalog client to a running building-block install',
    description:
      'Idempotent: the first call on a parked client scales it to 1 replica and wires env vars from the target building block. Subsequent calls rewrite the env entries and rolling-restart the pod so it picks up the new secretKeyRef. Credentials never flow through this API — only the target install id; the backend resolves secrets via K8s secretKeyRef within the cluster.',
  })
  @ApiParam({ name: 'id', description: 'CatalogInstall id of the client' })
  @ApiResponse({ status: 202, type: CatalogInstallResponseDto })
  async connect(
    @Param('id') id: string,
    @Body() dto: ConnectClientDto,
    @Req() req: Request,
  ): Promise<CatalogInstallResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    const install = await this.installer.connect(
      id,
      dto.targetInstallId,
      user?.userId,
    );
    return this.toResponse(install);
  }

  @ApiBearerAuth()
  @Post('installs/:id/disconnect')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary:
      'Disconnect a catalog client from the building block it is currently connected to',
    description:
      'Removes the linked env entries from the application (the externalSecretRef that bound the client to a BB Secret) and triggers a redeploy so the pod restarts in "not connected" mode (pgweb opens its native empty state, pod stays 1/1 Ready). Idempotent: the "connected" state is derived from the application env; if no linked env is present, disconnect is a no-op. To stop the client entirely, use DELETE /installs/:id instead.',
  })
  @ApiParam({ name: 'id', description: 'CatalogInstall id of the client' })
  @ApiResponse({ status: 202, type: CatalogInstallResponseDto })
  async disconnect(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<CatalogInstallResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    const install = await this.installer.disconnect(id, user?.userId);
    return this.toResponse(install);
  }

  @ApiBearerAuth()
  @Delete('installs/:id')
  @ApiOperation({ summary: 'Uninstall a catalog install' })
  @ApiParam({ name: 'id' })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiResponse({ status: 202, type: CatalogInstallResponseDto })
  async uninstall(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<CatalogInstallResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    const { install } = await this.installer.uninstall(id, user?.userId);
    return this.toResponse(install);
  }

  private async toResponse(
    install: CatalogInstallEntity,
  ): Promise<CatalogInstallResponseDto> {
    // connectedInstallId / connectedSlug are derived on read from the client
    // application's env (never stored on the install row) — the externalSecretRef
    // names the BB's K8s Secret, from which we resolve the BB Application and its
    // CatalogInstall id + catalog slug in one pass. This guarantees both fields
    // reflect the actual running configuration, not a potentially-stale mirror.
    const target = await this.catalogService.resolveConnectedTarget(install);
    return {
      id: install.id,
      slug: install.slug,
      displayName: install.displayName,
      catalogAppDefinitionId: install.catalogAppDefinitionId,
      clusterId: install.clusterId,
      status: install.status,
      operationId: install.operationId,
      applicationIds: install.applicationIds,
      requestedDomain: install.requestedDomain,
      resolvedFqdn: install.resolvedFqdn,
      skipEndpoint: install.skipEndpoint,
      allowMasterPlacement: install.allowMasterPlacement,
      resourceOverrides: install.resourceOverrides,
      connectedInstallId: target?.installId ?? null,
      connectedSlug: target?.slug ?? null,
      errorMessage: install.errorMessage,
      createdAt: install.createdAt,
      updatedAt: install.updatedAt,
    };
  }
}
