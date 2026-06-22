import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PlatformComponentsService } from '../services/platform-components.service';
import {
  PlatformComponentLogsQueryDto,
  PlatformComponentLogsResponseDto,
  PlatformComponentResponseDto,
  RedeployPlatformComponentResponseDto,
} from '../dto/platform-components.dto';
import { RequireSection } from '../../../iam/decorators/require-section.decorator';

@ApiTags('Infrastructure - Platform Components')
@ApiBearerAuth()
@Controller('infrastructure/clusters/:clusterId/platform-components')
@RequireSection('infrastructure')
export class PlatformComponentsController {
  constructor(
    private readonly platformComponentsService: PlatformComponentsService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List platform components',
    description:
      'Returns live status for core platform components directly from Kubernetes. ' +
      'No persistence is used; each request queries the cluster.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: [PlatformComponentResponseDto] })
  async listComponents(
    @Param('clusterId') clusterId: string,
  ): Promise<PlatformComponentResponseDto[]> {
    return this.platformComponentsService.listComponents(clusterId);
  }

  @Get(':componentKey')
  @ApiOperation({
    summary: 'Get platform component details',
    description:
      'Returns resource-level status, pod issues, and detailed error diagnostics for a single platform component.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({
    name: 'componentKey',
    description: 'Component key (example: cert-manager, traefik, coredns)',
  })
  @ApiResponse({ status: 200, type: PlatformComponentResponseDto })
  @ApiResponse({ status: 404, description: 'Cluster or component not found' })
  async getComponent(
    @Param('clusterId') clusterId: string,
    @Param('componentKey') componentKey: string,
  ): Promise<PlatformComponentResponseDto> {
    return this.platformComponentsService.getComponent(clusterId, componentKey);
  }

  @Get(':componentKey/pods/:podName/logs')
  @ApiOperation({
    summary: 'Get logs for a component pod',
    description:
      'Fetches logs directly from Kubernetes for a pod that belongs to the selected platform component.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({
    name: 'componentKey',
    description: 'Component key (example: cert-manager, traefik, coredns)',
  })
  @ApiParam({ name: 'podName', description: 'Pod name' })
  @ApiQuery({
    name: 'container',
    required: false,
    description: 'Container name (optional)',
  })
  @ApiQuery({
    name: 'tailLines',
    required: false,
    description: 'Number of log lines from the end of the stream',
    type: Number,
  })
  @ApiResponse({ status: 200, type: PlatformComponentLogsResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Cluster/component/pod not found',
  })
  async getPodLogs(
    @Param('clusterId') clusterId: string,
    @Param('componentKey') componentKey: string,
    @Param('podName') podName: string,
    @Query() query: PlatformComponentLogsQueryDto,
  ): Promise<PlatformComponentLogsResponseDto> {
    return this.platformComponentsService.getPodLogs(
      clusterId,
      componentKey,
      podName,
      query.container,
      query.tailLines ?? 200,
    );
  }

  @Post(':componentKey/actions/redeploy')
  @ApiOperation({
    summary: 'Redeploy/fix a platform component',
    description:
      'Triggers a Kubernetes rolling restart for workload resources (Deployment/StatefulSet/DaemonSet) of the selected component.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiParam({
    name: 'componentKey',
    description: 'Component key (example: cert-manager, traefik, coredns)',
  })
  @ApiResponse({ status: 201, type: RedeployPlatformComponentResponseDto })
  @ApiResponse({ status: 404, description: 'Cluster or component not found' })
  async redeployComponent(
    @Param('clusterId') clusterId: string,
    @Param('componentKey') componentKey: string,
  ): Promise<RedeployPlatformComponentResponseDto> {
    return this.platformComponentsService.redeployComponent(
      clusterId,
      componentKey,
    );
  }
}
