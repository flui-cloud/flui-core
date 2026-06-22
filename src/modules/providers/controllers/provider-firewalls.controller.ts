import {
  Controller,
  Get,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  NotFoundException,
  BadRequestException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AdminGuard } from '../../auth/guards/admin.guard';
import { Admin } from '../../auth/decorators/admin.decorator';
import { FirewallProviderFactory } from '../services/firewall-provider.factory';
import { ProviderFirewallResponseDto } from '../dto/provider-firewall-response.dto';
import { CloudProvider } from '../enums/cloud-provider.enum';
import { FirewallDetails } from '../interfaces/firewall-provider.interface';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Provider Firewalls')
@ApiBearerAuth()
@Controller('providers/:provider/firewalls')
@RequireSection('firewall')
export class ProviderFirewallsController {
  private readonly logger = new Logger(ProviderFirewallsController.name);

  constructor(
    private readonly firewallProviderFactory: FirewallProviderFactory,
  ) {}

  /**
   * List all firewalls from the cloud provider
   * By default, filters for Flui-managed firewalls (managed-by=flui-cloud)
   */
  @Get()
  @ApiOperation({
    summary: 'List firewalls from cloud provider',
    description:
      'Retrieves all firewalls from the specified cloud provider. By default, filters for Flui-managed firewalls using the "managed-by=flui-cloud" label selector. Returns firewall details including applied servers.',
  })
  @ApiParam({
    name: 'provider',
    enum: CloudProvider,
    description: 'Cloud provider (HETZNER or CONTABO)',
    example: 'HETZNER',
  })
  @ApiQuery({
    name: 'labelSelector',
    required: false,
    description:
      'Label selector for filtering firewalls. Default: "managed-by=flui-cloud". Use comma-separated key=value pairs for multiple labels.',
    example: 'managed-by=flui-cloud,flui-cluster-id=abc-123',
  })
  @ApiQuery({
    name: 'name',
    required: false,
    description: 'Filter firewalls by name (exact match)',
    example: 'flui-my-cluster-system-webapp',
  })
  @ApiQuery({
    name: 'clusterId',
    required: false,
    description:
      'Filter firewalls by cluster ID (shorthand for labelSelector=flui-cluster-id=<clusterId>)',
    example: 'abc-123-def-456',
  })
  @ApiQuery({
    name: 'includeNonFlui',
    required: false,
    type: Boolean,
    description:
      'Include non-Flui-managed firewalls. When true, disables default "managed-by=flui-cloud" filter.',
    example: false,
  })
  @ApiResponse({
    status: 200,
    description: 'List of firewalls from the provider',
    type: [ProviderFirewallResponseDto],
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid provider specified',
  })
  async listFirewalls(
    @Param('provider') provider: string,
    @Query('labelSelector') labelSelector?: string,
    @Query('name') name?: string,
    @Query('clusterId') clusterId?: string,
    @Query('includeNonFlui') includeNonFlui?: boolean,
  ): Promise<ProviderFirewallResponseDto[]> {
    // Validate provider
    const providerEnum = this.validateProvider(provider);

    // Get firewall provider service (throws if provider doesn't support firewalls)
    const firewallService =
      this.firewallProviderFactory.getFirewallProviderOrFail(providerEnum);

    // Build filters
    const filters: any = {};

    if (clusterId) {
      filters.clusterId = clusterId;
    }

    if (name) {
      filters.name = name;
    }

    // Apply default label selector if not explicitly disabled
    if (labelSelector) {
      filters.labelSelector = labelSelector;
    } else if (!includeNonFlui && !clusterId) {
      // Default: filter for Flui-managed firewalls
      filters.labelSelector = 'managed-by=flui-cloud';
    }

    this.logger.log(
      `Listing firewalls from provider ${provider} with filters: ${JSON.stringify(filters)}`,
    );

    // Get firewalls from provider
    const firewalls = await firewallService.listFirewalls(filters);

    // Map to response DTOs
    return firewalls.map((firewall) => this.mapToResponseDto(firewall));
  }

  /**
   * Get details of a specific firewall from the cloud provider
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get firewall details from cloud provider',
    description:
      'Retrieves detailed information about a specific firewall from the cloud provider, including rules, labels, and applied servers.',
  })
  @ApiParam({
    name: 'provider',
    enum: CloudProvider,
    description: 'Cloud provider (HETZNER or CONTABO)',
    example: 'HETZNER',
  })
  @ApiParam({
    name: 'id',
    description: 'Provider firewall ID',
    example: '12345678',
  })
  @ApiResponse({
    status: 200,
    description: 'Firewall details',
    type: ProviderFirewallResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Firewall not found',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid provider specified',
  })
  async getFirewall(
    @Param('provider') provider: string,
    @Param('id') firewallId: string,
  ): Promise<ProviderFirewallResponseDto> {
    // Validate provider
    const providerEnum = this.validateProvider(provider);

    // Get firewall provider service (throws if provider doesn't support firewalls)
    const firewallService =
      this.firewallProviderFactory.getFirewallProviderOrFail(providerEnum);

    this.logger.log(`Getting firewall ${firewallId} from provider ${provider}`);

    // Get firewall from provider
    const firewall = await firewallService.getFirewall(firewallId);

    if (!firewall) {
      throw new NotFoundException(
        `Firewall with ID ${firewallId} not found on provider ${provider}`,
      );
    }

    // Map to response DTO
    return this.mapToResponseDto(firewall);
  }

  /**
   * Delete firewall from cloud provider (direct provider deletion, no database interaction)
   */
  @Delete(':id')
  @UseGuards(AdminGuard)
  @Admin()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete firewall from cloud provider',
    description:
      'Deletes a firewall directly from the cloud provider without any database interaction. ' +
      'Use with caution - this is a direct provider operation. Requires confirm=true query parameter.',
  })
  @ApiParam({
    name: 'provider',
    enum: CloudProvider,
    description: 'Cloud provider (HETZNER or CONTABO)',
    example: 'HETZNER',
  })
  @ApiParam({
    name: 'id',
    description: 'Provider firewall ID',
    example: '12345678',
  })
  @ApiQuery({
    name: 'confirm',
    required: true,
    type: Boolean,
    description:
      'Confirmation required to delete firewall (must be true). Safety mechanism to prevent accidental deletion.',
    example: true,
  })
  @ApiResponse({
    status: 204,
    description: 'Firewall deleted successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid provider or confirmation not provided',
  })
  @ApiResponse({
    status: 404,
    description: 'Firewall not found on provider',
  })
  async deleteFirewall(
    @Param('provider') provider: string,
    @Param('id') firewallId: string,
    @Query('confirm') confirm?: boolean,
  ): Promise<void> {
    // Safety check - require explicit confirmation
    if (confirm !== true) {
      throw new BadRequestException(
        'Must provide confirm=true query parameter to delete firewall from provider',
      );
    }

    // Validate provider
    const providerEnum = this.validateProvider(provider);

    // Get firewall provider service (throws if provider doesn't support firewalls)
    const firewallService =
      this.firewallProviderFactory.getFirewallProviderOrFail(providerEnum);

    this.logger.log(
      `Deleting firewall ${firewallId} from provider ${provider}`,
    );

    try {
      // Delete from provider (no database interaction)
      await firewallService.deleteFirewall(firewallId);

      this.logger.log(
        `Firewall ${firewallId} deleted successfully from provider ${provider}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to delete firewall ${firewallId} from provider ${provider}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Validate provider parameter and convert to enum
   */
  private validateProvider(provider: string): CloudProvider {
    const lowerProvider = provider.toLowerCase();

    if (
      !Object.values(CloudProvider).includes(lowerProvider as CloudProvider)
    ) {
      throw new BadRequestException(
        `Invalid provider: ${provider}. Must be one of: ${Object.values(CloudProvider).join(', ')}`,
      );
    }

    return lowerProvider as CloudProvider;
  }

  /**
   * Map FirewallDetails to ProviderFirewallResponseDto
   */
  private mapToResponseDto(
    firewall: FirewallDetails,
  ): ProviderFirewallResponseDto {
    return {
      id: firewall.id,
      name: firewall.name,
      rules: firewall.rules.map((rule) => ({
        description: rule.description,
        direction: rule.direction,
        protocol: rule.protocol,
        port: rule.port,
        sourceIps: rule.sourceIps,
        destinationIps: rule.destinationIps,
      })),
      labels: firewall.labels,
      appliedServers: firewall.appliedTo.map((server) => ({
        serverId: server.serverId,
        serverName: server.serverName,
      })),
    };
  }
}
