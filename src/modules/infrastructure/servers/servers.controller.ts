import {
  Controller,
  Get,
  Post,
  Delete,
  Query,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
  ApiParam,
  ApiBody,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { AdminGuard } from '../../auth/guards/admin.guard';
import { Admin } from '../../auth/decorators/admin.decorator';
import { ServersService } from './services/servers.service';
import { ServerResponseDto } from './dto/server-response.dto';
import {
  CreateServerDto,
  CreateServerResponseDto,
} from './dto/create-server.dto';
import {
  DeleteServerDto,
  DeleteServerResponseDto,
} from './dto/delete-server.dto';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { RequireSection } from '../../iam/decorators/require-section.decorator';

@ApiTags('Infrastructure - Servers')
@ApiBearerAuth()
@Controller('infrastructure/servers')
@RequireSection('infrastructure')
export class ServersController {
  constructor(private readonly serversService: ServersService) {}

  @Get()
  @ApiOperation({
    summary: 'List servers from cloud providers',
    description:
      'Returns servers from configured cloud providers with optional filtering',
  })
  @ApiQuery({
    name: 'provider',
    enum: CloudProvider,
    required: false,
    description: 'Filter by specific provider',
  })
  @ApiQuery({
    name: 'clusterId',
    required: false,
    description: 'Filter servers by cluster ID',
    example: 'uuid-cluster-id',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns list of servers',
    type: [ServerResponseDto],
  })
  async listServers(
    @Query('provider') provider?: CloudProvider,
    @Query('clusterId') clusterId?: string,
  ): Promise<ServerResponseDto[]> {
    if (provider) {
      return await this.serversService.getServersByProvider(
        provider,
        clusterId,
      );
    }
    return await this.serversService.listServers(clusterId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get server details by ID',
    description: 'Returns detailed server information from cloud provider',
  })
  @ApiParam({
    name: 'id',
    description: 'Server ID from cloud provider',
    example: '12345678',
  })
  @ApiQuery({
    name: 'provider',
    enum: CloudProvider,
    description: 'Cloud provider to query',
    example: CloudProvider.HETZNER,
  })
  @ApiResponse({
    status: 200,
    description: 'Returns server details',
    type: ServerResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Server not found' })
  async getServerDetails(
    @Param('id') serverId: string,
    @Query('provider') provider: CloudProvider,
  ): Promise<ServerResponseDto> {
    return await this.serversService.getServerById(serverId, provider);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new server',
    description: 'Initiates server creation via queue (async operation)',
  })
  @ApiBody({ type: CreateServerDto })
  @ApiResponse({
    status: 202,
    description: 'Server creation initiated',
    type: CreateServerResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid request data' })
  async createServer(
    @Body() dto: CreateServerDto,
  ): Promise<CreateServerResponseDto> {
    const operation = await this.serversService.createServer(dto);
    return {
      operation_id: operation.id,
      status: this.mapStatus(operation.status),
      resource_type: 'server' as const,
      provider: dto.provider,
      estimated_duration: '2-5 minutes',
      created_at: operation.createdAt,
    };
  }

  @Delete(':id')
  @UseGuards(AdminGuard)
  @Admin()
  @ApiOperation({
    summary: 'Delete a server',
    description: 'Initiates server deletion via queue (async operation)',
  })
  @ApiParam({
    name: 'id',
    description: 'Server ID from cloud provider',
    example: '12345678',
  })
  @ApiQuery({
    name: 'provider',
    enum: CloudProvider,
    description: 'Cloud provider name',
    example: CloudProvider.HETZNER,
  })
  @ApiQuery({
    name: 'force',
    type: Boolean,
    required: false,
    description: 'Force deletion even if server is running',
    example: false,
  })
  @ApiResponse({
    status: 202,
    description: 'Server deletion initiated',
    type: DeleteServerResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Server not found' })
  async deleteServer(
    @Param('id') serverId: string,
    @Query('provider') provider: CloudProvider,
    @Query('force') force?: boolean,
  ): Promise<DeleteServerResponseDto> {
    const deleteDto: DeleteServerDto = {
      server_id: serverId,
      provider,
      force: force || false,
    };

    const operation = await this.serversService.deleteServer(deleteDto);
    return {
      operation_id: operation.id,
      status: this.mapStatus(operation.status),
      resource_type: 'server' as const,
      provider: deleteDto.provider,
      resource_id: deleteDto.server_id,
      estimated_duration: '1-3 minutes',
      created_at: operation.createdAt,
    };
  }

  @Get('health/providers')
  @ApiOperation({
    summary: 'Check cloud providers health',
    description: 'Tests connections to all configured cloud providers',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns provider health status',
  })
  async checkProvidersHealth(): Promise<{
    overall: string;
    providers: Array<{
      name: CloudProvider;
      status: string;
      responseTime?: number;
      error?: string;
    }>;
  }> {
    return await this.serversService.checkProvidersHealth();
  }

  private mapStatus(
    status: string,
  ): 'pending' | 'running' | 'completed' | 'failed' {
    switch (status) {
      case 'PENDING':
        return 'pending';
      case 'IN_PROGRESS':
        return 'running';
      case 'COMPLETED':
        return 'completed';
      case 'FAILED':
        return 'failed';
      default:
        return 'pending';
    }
  }
}
