import {
  Controller,
  Get,
  Put,
  Post,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { FirewallDesiredStateService } from '../services/firewall-desired-state.service';
import { FirewallReconciliationService } from '../services/firewall-reconciliation.service';
import {
  UpdateFirewallRulesDto,
  FirewallResponseDto,
  ListFirewallsQueryDto,
  ReconciliationStatusDto,
} from '../dto/cluster-firewall.dto';
import { ImportFirewallDto } from '../dto/import-firewall.dto';
import { HetznerFirewallService } from '../../../providers/services/hetzner-firewall.service';
import { RequireSection } from '../../../iam/decorators/require-section.decorator';

@ApiTags('Firewalls')
@ApiBearerAuth()
@Controller('firewalls')
@RequireSection('firewall')
export class ClusterFirewallsController {
  constructor(
    private readonly desiredStateService: FirewallDesiredStateService,
    private readonly reconciliationService: FirewallReconciliationService,
    private readonly hetznerFirewallService: HetznerFirewallService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List all firewalls',
    description: 'Retrieve all cluster firewalls with optional filtering',
  })
  @ApiQuery({
    name: 'clusterId',
    required: false,
    description: 'Filter by cluster ID',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    description: 'Filter by reconciliation status',
  })
  @ApiResponse({
    status: 200,
    description: 'List of firewalls',
    type: [FirewallResponseDto],
  })
  async listFirewalls(
    @Query() filters: ListFirewallsQueryDto,
  ): Promise<FirewallResponseDto[]> {
    const firewalls = await this.desiredStateService.listFirewalls(filters);
    return firewalls.map((f) => this.desiredStateService.toResponseDto(f));
  }

  @Post('import')
  @ApiOperation({
    summary: 'Import firewall from provider',
    description:
      'Import firewall rules from the cloud provider into the database. Used by CLI reconciliation to sync local JSON data with the API database. If a firewall already exists for the cluster, it will be skipped.',
  })
  @ApiResponse({
    status: 201,
    description: 'Firewall imported successfully',
    schema: {
      type: 'object',
      properties: {
        message: { type: 'string', example: 'Firewall imported successfully' },
        created: { type: 'boolean', example: true },
        firewallId: {
          type: 'string',
          example: '550e8400-e29b-41d4-a716-446655440000',
        },
      },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Firewall already exists for this cluster',
    schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          example: 'Firewall already exists for this cluster',
        },
        skipped: { type: 'boolean', example: true },
        firewallId: {
          type: 'string',
          example: '550e8400-e29b-41d4-a716-446655440000',
        },
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  async importFirewall(@Body() dto: ImportFirewallDto): Promise<{
    message: string;
    created?: boolean;
    skipped?: boolean;
    firewallId: string;
  }> {
    // Check if firewall already exists for this cluster
    try {
      const existing = await this.desiredStateService.getFirewallByClusterId(
        dto.clusterId,
      );

      if (existing) {
        return {
          message: 'Firewall already exists for this cluster',
          skipped: true,
          firewallId: existing.id,
        };
      }
    } catch {
      // Firewall doesn't exist, continue with import
    }

    // Fetch firewall rules from provider (source of truth)
    const providerFirewall = await this.hetznerFirewallService.getFirewall(
      dto.providerFirewallId,
    );

    if (!providerFirewall) {
      throw new Error(
        `Firewall ${dto.providerFirewallId} not found on provider`,
      );
    }

    // Create new firewall record with rules from provider
    const firewall = await this.desiredStateService.createFirewall(
      dto.clusterId,
      providerFirewall.rules,
    );

    // Mark as reconciled since rules are already on provider
    await this.desiredStateService.markReconciliationComplete(
      firewall.id,
      providerFirewall.rules,
      dto.providerFirewallId,
    );

    return {
      message: 'Firewall imported successfully',
      created: true,
      firewallId: firewall.id,
    };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get firewall by ID',
    description: 'Retrieve firewall details by firewall ID',
  })
  @ApiParam({ name: 'id', description: 'Firewall ID' })
  @ApiResponse({
    status: 200,
    description: 'Firewall details',
    type: FirewallResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Firewall not found' })
  async getFirewall(@Param('id') id: string): Promise<FirewallResponseDto> {
    const firewall = await this.desiredStateService.getFirewallById(id);
    return this.desiredStateService.toResponseDto(firewall);
  }

  @Get('cluster/:clusterId')
  @ApiOperation({
    summary: 'Get firewall by cluster ID',
    description: 'Retrieve firewall for a specific cluster',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 200,
    description: 'Firewall details',
    type: FirewallResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Firewall not found for cluster' })
  async getFirewallByCluster(
    @Param('clusterId') clusterId: string,
  ): Promise<FirewallResponseDto> {
    const firewall =
      await this.desiredStateService.getFirewallByClusterId(clusterId);
    return this.desiredStateService.toResponseDto(firewall);
  }

  @Post('cluster/:clusterId/enable')
  @ApiOperation({
    summary: 'Enable firewall for a cluster',
    description:
      'Idempotently ensure a firewall exists for the cluster, then apply it. Seeds the default rules for the cluster type when none exists (the primary way a host-firewall / nftables cluster gets a firewall generated and applied, since there is no managed-edge resource to import). Re-applies the desired state when one already exists.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({
    status: 201,
    description: 'Firewall enabled and applied',
    type: FirewallResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Cluster not found' })
  @ApiResponse({ status: 500, description: 'Failed to apply firewall' })
  async enableForCluster(
    @Param('clusterId') clusterId: string,
  ): Promise<FirewallResponseDto> {
    const firewall =
      await this.reconciliationService.ensureClusterFirewall(clusterId);
    return this.desiredStateService.toResponseDto(firewall);
  }

  @Put(':id/desired-rules')
  @ApiOperation({
    summary: 'Update and apply firewall rules',
    description:
      'Updates the desired firewall rules and immediately applies them to the cloud provider. Changes are atomic: if provider application fails, the database is not updated.',
  })
  @ApiParam({ name: 'id', description: 'Firewall ID' })
  @ApiResponse({
    status: 200,
    description: 'Firewall rules updated and applied successfully',
    type: FirewallResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Firewall not found' })
  @ApiResponse({
    status: 500,
    description: 'Failed to apply rules to provider. No changes were saved.',
  })
  async updateDesiredRules(
    @Param('id') id: string,
    @Body() dto: UpdateFirewallRulesDto,
  ): Promise<FirewallResponseDto> {
    // Apply to provider first, then save to DB (atomic operation)
    const firewall = await this.reconciliationService.updateAndApplyRules(
      id,
      dto.desiredRules,
    );
    return this.desiredStateService.toResponseDto(firewall);
  }

  @Post(':id/reconcile')
  @ApiOperation({
    summary: 'Manually reconcile firewall',
    description:
      'Re-applies the desired firewall rules to the cloud provider. Use this endpoint to restore the desired state if the firewall was modified externally on the provider, or to retry after a previous failure.',
  })
  @ApiParam({ name: 'id', description: 'Firewall ID' })
  @ApiResponse({
    status: 200,
    description: 'Reconciliation completed successfully',
    type: FirewallResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Firewall not found' })
  @ApiResponse({ status: 500, description: 'Reconciliation failed' })
  async reconcile(@Param('id') id: string): Promise<FirewallResponseDto> {
    const firewall = await this.reconciliationService.reconcile(id);
    return this.desiredStateService.toResponseDto(firewall);
  }

  @Get(':id/status')
  @ApiOperation({
    summary: 'Get firewall reconciliation status',
    description:
      'Get current reconciliation status and drift detection information',
  })
  @ApiParam({ name: 'id', description: 'Firewall ID' })
  @ApiResponse({
    status: 200,
    description: 'Reconciliation status',
    type: ReconciliationStatusDto,
  })
  @ApiResponse({ status: 404, description: 'Firewall not found' })
  async getReconciliationStatus(
    @Param('id') id: string,
  ): Promise<ReconciliationStatusDto> {
    return await this.desiredStateService.getReconciliationStatus(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete firewall',
    description:
      'Delete firewall and its provider firewall. This will leave the cluster unprotected.',
  })
  @ApiParam({ name: 'id', description: 'Firewall ID' })
  @ApiResponse({ status: 204, description: 'Firewall deleted successfully' })
  @ApiResponse({ status: 404, description: 'Firewall not found' })
  async deleteFirewall(@Param('id') id: string): Promise<void> {
    // Delete provider firewall first
    await this.reconciliationService.deleteProviderFirewall(id);

    // Delete firewall entity
    await this.desiredStateService.deleteFirewall(id);
  }
}
