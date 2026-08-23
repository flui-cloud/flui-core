import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Req,
  ParseUUIDPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AppBuildService } from '../services/app-build.service';
import { BuildAccessService } from '../services/build-access.service';
import { TriggerStandaloneBuildDto } from '../dto/trigger-standalone-build.dto';
import { AppBuildResponseDto } from '../dto/app-build-response.dto';

/**
 * Builds that do not belong to an application yet — the wizard builds a
 * repository first and creates the application from the finished image.
 *
 * Nothing on this controller asked anything until now. A sandbox guest was
 * refused by the fence, which is a different list for a different reason, and
 * everybody else — an `editor` scoped to their own applications included —
 * could read another tenant's build, start one on any cluster, and delete one.
 * The rule is `BuildAccessService`, the same one the per-application routes ask.
 */
@ApiTags('Builds')
@ApiBearerAuth()
@Controller('builds')
export class StandaloneBuildsController {
  constructor(
    private readonly appBuildService: AppBuildService,
    private readonly buildAccess: BuildAccessService,
    private readonly access: ApplicationAccessService,
  ) {}

  /**
   * Trigger a standalone build (no application required).
   * Used in the wizard flow: build first, then create the app from the completed build.
   * Subscribe to WS namespace /applications with subscribe:build { buildId } for real-time events.
   *
   * There is no build to ask about yet, so the question is the one this build
   * is a step towards: may you create an application on that cluster? It is the
   * same call `POST /clusters/:id/applications` makes, and it pins a sandbox
   * guest to the cluster of its own tenancy.
   */
  @Post()
  @ApiOperation({ summary: 'Trigger a standalone build (wizard flow)' })
  @ApiResponse({ status: 201, type: AppBuildResponseDto })
  async triggerStandaloneBuild(
    @Body() dto: TriggerStandaloneBuildDto,
    @Req() req: Request,
  ): Promise<AppBuildResponseDto> {
    const user = req.user as AuthenticatedUser;
    await this.access.assertCanCreate(user, {
      clusterId: dto.targetClusterId,
    });
    const build = await this.appBuildService.triggerStandaloneBuild(
      dto.gitUrl,
      dto.branch,
      dto.targetClusterId,
      dto.buildClusterId ?? dto.targetClusterId,
      user?.userId,
    );
    return build;
  }

  /**
   * Get a build by ID (works for both standalone and app-linked builds).
   */
  @Get(':buildId')
  @ApiOperation({ summary: 'Get a build by ID' })
  @ApiResponse({ status: 200, type: AppBuildResponseDto })
  async getBuild(
    @Param('buildId', ParseUUIDPipe) buildId: string,
    @Req() req: Request,
  ): Promise<AppBuildResponseDto> {
    return this.buildAccess.buildForCaller(
      buildId,
      req.user as AuthenticatedUser,
      IAM_PERMISSION.APP_READ,
    );
  }

  /**
   * Delete a standalone build (only allowed when the build is not yet linked to an application).
   * Cancels the build if still active, then removes the DB record.
   */
  @Delete(':buildId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a standalone build (only if not yet linked to an app)',
  })
  @ApiResponse({ status: 204 })
  async deleteStandaloneBuild(
    @Param('buildId', ParseUUIDPipe) buildId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.buildAccess.buildForCaller(
      buildId,
      req.user as AuthenticatedUser,
      IAM_PERMISSION.APP_WRITE,
    );
    return this.appBuildService.deleteStandaloneBuild(buildId);
  }
}
