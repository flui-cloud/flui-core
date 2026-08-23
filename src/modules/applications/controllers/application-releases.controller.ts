import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
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
import { AppAccessGuard } from '../guards/app-access.guard';
import { ApplicationService } from '../services/application.service';
import { ApplicationReleaseService } from '../services/application-release.service';
import { ApplicationVersionsService } from '../services/application-versions.service';
import {
  ApplicationReleaseDto,
  ApplicationReleaseListDto,
} from '../dto/application-release.dto';
import { AvailableVersionsResponseDto } from '../dto/available-versions.dto';
import { AppRevisionResponseDto } from '../dto/application-response.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller()
@UseGuards(AppAccessGuard)
export class ApplicationReleasesController {
  constructor(
    private readonly applicationService: ApplicationService,
    private readonly applicationReleaseService: ApplicationReleaseService,
    private readonly applicationVersionsService: ApplicationVersionsService,
  ) {}

  // ── Releases ──────────────────────────────────────────

  @Get('applications/:id/release')
  @ApiOperation({
    summary:
      'Get the current release (most recent deploy/rollback operation) and its derived status',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: ApplicationReleaseDto })
  async getCurrentRelease(
    @Param('id') id: string,
  ): Promise<ApplicationReleaseDto | null> {
    await this.applicationReleaseService.assertApplicationExists(id);
    return this.applicationReleaseService.getCurrentRelease(id);
  }

  @Get('applications/:id/releases')
  @ApiOperation({
    summary: 'List recent releases (deploy/rollback operations) for the app',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: ApplicationReleaseListDto })
  async listReleases(
    @Param('id') id: string,
  ): Promise<ApplicationReleaseListDto> {
    await this.applicationReleaseService.assertApplicationExists(id);
    const releases = await this.applicationReleaseService.listReleases(id);
    return { releases };
  }

  // ── Versioning ────────────────────────────────────────

  @Get('applications/:id/available-versions')
  @ApiOperation({
    summary: 'List available image versions',
    description:
      'For GIT_BUILD apps returns GHCR versions. For DOCKER_IMAGE apps returns DockerHub tags. Supports pagination for DockerHub.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: AvailableVersionsResponseDto })
  async getAvailableVersions(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<AvailableVersionsResponseDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.applicationVersionsService.getAvailableVersions(
      id,
      userId,
      page ? Number.parseInt(page, 10) : 1,
      limit ? Number.parseInt(limit, 10) : 25,
    );
  }

  // ── Revisions ─────────────────────────────────────────

  @Get('applications/:id/revisions')
  @ApiOperation({
    summary: 'List deploy revisions',
    description:
      'Returns only DEPLOY and ROLLBACK events, ordered by revision number DESC.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: [AppRevisionResponseDto] })
  async getRevisions(
    @Param('id') id: string,
  ): Promise<AppRevisionResponseDto[]> {
    const revisions = await this.applicationService.getRevisions(id);
    return revisions.map((r) =>
      this.applicationService.toRevisionResponseDto(r),
    );
  }

  @Get('applications/:id/revisions/:revisionId')
  @ApiOperation({ summary: 'Get revision detail with full snapshots' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'revisionId', description: 'Revision ID' })
  @ApiResponse({ status: 200, type: AppRevisionResponseDto })
  @ApiResponse({ status: 404, description: 'Revision not found' })
  async getRevisionById(
    @Param('id') id: string,
    @Param('revisionId') revisionId: string,
  ): Promise<AppRevisionResponseDto> {
    const revision = await this.applicationService.getRevisionById(
      id,
      revisionId,
    );
    return this.applicationService.toRevisionResponseDto(revision);
  }
}
