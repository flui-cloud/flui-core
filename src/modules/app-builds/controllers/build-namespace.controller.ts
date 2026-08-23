import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  ParseUUIDPipe,
  HttpCode,
  Request,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { AppBuildService } from '../services/app-build.service';
import { BuildCacheService } from '../services/build-cache.service';
import {
  BuildNamespaceResourcesResponseDto,
  BuildNamespaceCleanupResultDto,
  CleanupBuildNamespaceDto,
  BuildCacheInfoResponseDto,
  ClearBuildCacheResponseDto,
} from '../dto/build-namespace.dto';
import {
  BuildCacheBreakdownResponseDto,
  RefreshCacheBreakdownResponseDto,
} from '../dto/build-cache-breakdown.dto';

/**
 * The build namespace of one cluster: what is running in `flui-build`, what the
 * cache holds, and the two ways to empty either. None of it is anybody's
 * application — it is the machinery every application on the cluster shares —
 * so it is asked for as the area it belongs to rather than per application.
 *
 * It carried no decorator at all. A sandbox guest was refused by the fence, and
 * everybody else could list another tenant's build Jobs by name and wipe the
 * cache the whole instance builds against.
 */
@ApiTags('Build Namespace')
@ApiBearerAuth()
@RequireSection('infrastructure')
@Controller('clusters/:clusterId/builds')
export class BuildNamespaceController {
  constructor(
    private readonly appBuildService: AppBuildService,
    private readonly buildCacheService: BuildCacheService,
  ) {}

  /**
   * List all Jobs and Pods in the flui-build namespace for a given cluster.
   * Use this to inspect what is consuming build resources.
   */
  @Get('namespace-resources')
  @ApiOperation({
    summary: 'List active Jobs and Pods in the flui-build namespace',
  })
  @ApiResponse({ status: 200, type: BuildNamespaceResourcesResponseDto })
  async getNamespaceResources(
    @Param('clusterId', ParseUUIDPipe) clusterId: string,
  ): Promise<BuildNamespaceResourcesResponseDto> {
    return this.appBuildService.getBuildNamespaceResources(clusterId);
  }

  /**
   * Clean up stale Jobs and orphaned Pods from the flui-build namespace.
   * Stale = terminal K8s state, or corresponding build is no longer active in DB.
   * Use dryRun: true to preview what would be deleted.
   */
  @Post('namespace-cleanup')
  @ApiOperation({
    summary: 'Clean up stale build Jobs and Pods from the flui-build namespace',
  })
  @ApiResponse({ status: 200, type: BuildNamespaceCleanupResultDto })
  async cleanupNamespace(
    @Param('clusterId', ParseUUIDPipe) clusterId: string,
    @Body() dto: CleanupBuildNamespaceDto,
  ): Promise<BuildNamespaceCleanupResultDto> {
    return this.appBuildService.cleanupBuildNamespace(clusterId, dto);
  }

  /**
   * Get info about the flui-buildkit-cache PVC (phase, capacity, storage class).
   */
  @Get('cache')
  @ApiOperation({ summary: 'Get BuildKit cache PVC info for this cluster' })
  @ApiResponse({ status: 200, type: BuildCacheInfoResponseDto })
  async getCacheInfo(
    @Param('clusterId', ParseUUIDPipe) clusterId: string,
  ): Promise<BuildCacheInfoResponseDto> {
    return this.buildCacheService.getCacheInfo(clusterId);
  }

  /**
   * Clear the BuildKit cache by deleting and recreating the PVC.
   * Returns immediately with an operationId.
   * Subscribe to WebSocket /infrastructure room operation:{operationId} for progress.
   */
  /**
   * Return the per-framework cache breakdown from DB (instant, no K8s call).
   * scanStatus "pending" means no scan has run yet.
   * scanStatus "in_progress" means a scan is running — poll until it changes.
   */
  @Get('cache/breakdown')
  @ApiOperation({
    summary: 'Get per-framework BuildKit cache breakdown (from DB, instant)',
  })
  @ApiResponse({ status: 200, type: BuildCacheBreakdownResponseDto })
  async getCacheBreakdown(
    @Param('clusterId', ParseUUIDPipe) clusterId: string,
  ): Promise<BuildCacheBreakdownResponseDto> {
    return this.buildCacheService.getCacheBreakdown(clusterId);
  }

  /**
   * Trigger a manual cache inspection in the background.
   * Returns immediately. Poll GET /cache/breakdown until scanStatus changes.
   */
  @Post('cache/breakdown/refresh')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Request a manual cache breakdown refresh (async)',
    description:
      'Starts an inspection Job that runs buildctl du --verbose against the cache PVC. ' +
      'Skipped if a build is active or a scan is already running. ' +
      'Poll GET /cache/breakdown until scanStatus is "ok" or "failed".',
  })
  @ApiResponse({ status: 202, type: RefreshCacheBreakdownResponseDto })
  async refreshCacheBreakdown(
    @Param('clusterId', ParseUUIDPipe) clusterId: string,
  ): Promise<RefreshCacheBreakdownResponseDto> {
    return this.buildCacheService.requestRefresh(clusterId);
  }

  @Post('cache/clear')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Clear BuildKit cache (async)',
    description:
      'Deletes and recreates the flui-buildkit-cache PVC, wiping all cached layers. ' +
      'Returns operationId immediately. ' +
      'Subscribe to /infrastructure WebSocket room operation:{operationId} for real-time progress.',
  })
  @ApiResponse({ status: 202, type: ClearBuildCacheResponseDto })
  async clearCache(
    @Param('clusterId', ParseUUIDPipe) clusterId: string,
    @Request() req: any,
  ): Promise<ClearBuildCacheResponseDto> {
    return this.buildCacheService.clearCacheAsync(clusterId, req.user?.sub);
  }
}
