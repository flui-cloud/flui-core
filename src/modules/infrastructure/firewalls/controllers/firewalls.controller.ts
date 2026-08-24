import {
  Controller,
  Get,
  Post,
  Patch,
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
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { FirewallsService } from '../services/firewalls.service';
import {
  ProviderUpdateFirewallRulesDto,
  ProviderFirewallDto,
} from '../../../providers/dto/firewall.dto';
import { FirewallEntity } from '../entities/firewall.entity';
import { RequireSection } from '../../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../../iam/constants/iam-permissions';

@ApiTags('Firewalls')
@ApiBearerAuth()
@Controller('infrastructure/firewalls')
@RequireSection('firewall')
export class FirewallsController {
  constructor(private readonly firewallsService: FirewallsService) {}

  /**
   * List all firewalls with optional filtering
   */
  @Get()
  @ApiOperation({
    summary: 'List firewalls',
    description:
      'Get all firewalls with optional filtering by provider or cluster',
  })
  @ApiQuery({
    name: 'provider',
    required: false,
    description: 'Filter by cloud provider',
  })
  @ApiQuery({
    name: 'clusterId',
    required: false,
    description: 'Filter by cluster ID',
  })
  @ApiResponse({
    status: 200,
    description: 'List of firewalls',
    type: [ProviderFirewallDto],
  })
  async listFirewalls(
    @Query('provider') provider?: string,
    @Query('clusterId') clusterId?: string,
  ): Promise<ProviderFirewallDto[]> {
    const firewalls = await this.firewallsService.listFirewalls({
      provider,
      clusterId,
    });

    return firewalls.map((firewall) => this.toResponseDto(firewall));
  }

  /**
   * Get firewall details by ID
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get firewall details',
    description: 'Retrieve detailed information about a specific firewall',
  })
  @ApiResponse({
    status: 200,
    description: 'Firewall details',
    type: ProviderFirewallDto,
  })
  @ApiResponse({
    status: 404,
    description: 'Firewall not found',
  })
  async getFirewall(@Param('id') id: string): Promise<ProviderFirewallDto> {
    const firewall = await this.firewallsService.getFirewallById(id);
    return this.toResponseDto(firewall);
  }

  /**
   * Update firewall rules
   */
  // No gate of its own beyond the class's @RequireSection('firewall'): the two
  // writes next door — POST :id/apply and POST :id/remove, which push rules onto
  // live servers — have always run on the section alone, so the boolean here
  // separated nothing the neighbour did not already grant.
  @Patch(':id/rules')
  @ApiOperation({
    summary: 'Update firewall rules',
    description:
      'Update the rules for an existing firewall. ' +
      'Rules must include at least SSH access (port 22) and outbound traffic to prevent lockout.',
  })
  @ApiResponse({
    status: 200,
    description: 'Firewall rules updated successfully',
    type: ProviderFirewallDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid firewall rules',
  })
  @ApiResponse({
    status: 404,
    description: 'Firewall not found',
  })
  async updateFirewallRules(
    @Param('id') id: string,
    @Body() dto: ProviderUpdateFirewallRulesDto,
  ): Promise<ProviderFirewallDto> {
    const firewall = await this.firewallsService.updateFirewallRules(
      id,
      dto.rules,
    );
    return this.toResponseDto(firewall);
  }

  /**
   * Delete firewall
   */
  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete firewall',
    description:
      'Delete a firewall. Only firewalls managed by Flui can be deleted unless force=true is used.',
  })
  @ApiQuery({
    name: 'force',
    required: false,
    type: Boolean,
    description: 'Force deletion even if not managed by Flui',
  })
  @ApiResponse({
    status: 204,
    description: 'Firewall deleted successfully',
  })
  @ApiResponse({
    status: 403,
    description: 'Cannot delete firewall not managed by Flui',
  })
  @ApiResponse({
    status: 404,
    description: 'Firewall not found',
  })
  async deleteFirewall(
    @Param('id') id: string,
    @Query('force') force?: boolean,
  ): Promise<void> {
    await this.firewallsService.deleteFirewall(id, force || false);
  }

  /**
   * Apply firewall to additional servers
   */
  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply firewall to servers',
    description: 'Apply this firewall to additional servers',
  })
  @ApiResponse({
    status: 200,
    description: 'Firewall applied to servers successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Firewall not found',
  })
  async applyToServers(
    @Param('id') id: string,
    @Body() body: { serverIds: string[] },
  ): Promise<{ message: string }> {
    await this.firewallsService.applyToServers(id, body.serverIds);
    return {
      message: `Firewall applied to ${body.serverIds.length} servers successfully`,
    };
  }

  /**
   * Remove firewall from servers
   */
  @Post(':id/remove')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove firewall from servers',
    description: 'Remove this firewall from specified servers',
  })
  @ApiResponse({
    status: 200,
    description: 'Firewall removed from servers successfully',
  })
  @ApiResponse({
    status: 404,
    description: 'Firewall not found',
  })
  async removeFromServers(
    @Param('id') id: string,
    @Body() body: { serverIds: string[] },
  ): Promise<{ message: string }> {
    await this.firewallsService.removeFromServers(id, body.serverIds);
    return {
      message: `Firewall removed from ${body.serverIds.length} servers successfully`,
    };
  }

  /**
   * Helper method to convert entity to response DTO
   */
  private toResponseDto(firewall: FirewallEntity): ProviderFirewallDto {
    return {
      id: firewall.id,
      name: firewall.name,
      provider: firewall.provider,
      rules: firewall.rules,
      appliedToServerCount: firewall.appliedToServerIds?.length || 0,
      labels: firewall.labels,
      createdAt: firewall.createdAt,
      updatedAt: firewall.updatedAt,
    };
  }
}
