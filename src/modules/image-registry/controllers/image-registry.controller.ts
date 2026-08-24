import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  ParseIntPipe,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { ImageRegistryService } from '../services/image-registry.service';
import {
  ImageResponseDto,
  ListImagesQueryDto,
  AddFluiTagDto,
} from '../dto/image-registry.dto';
import { GhcrTagDto } from '../dto/ghcr.dto';
import { ImageEntity } from '../entities/image.entity';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';

@ApiTags('Image Registry')
@ApiBearerAuth()
@Controller('image-registry')
export class ImageRegistryController {
  constructor(
    private readonly imageRegistryService: ImageRegistryService,
    private readonly appAccess: ApplicationAccessService,
    private readonly applications: ApplicationsRepository,
  ) {}

  /**
   * Whose image this is.
   *
   * An image row names the application it was built for, and every other route
   * in this controller that touches one — the GHCR pair — resolves that
   * application and refuses somebody else's. These two did not: they took an id
   * and wrote, so any authenticated account could delete another tenant's image
   * record, or strip the `stable` tag off it, by guessing a uuid.
   */
  private async assertMayChangeImage(
    imageId: string,
    user: AuthenticatedUser | undefined,
  ): Promise<void> {
    if (!user) throw new ForbiddenException('Unauthenticated');
    const image = await this.imageRegistryService.getImage(imageId);
    const app = await this.applications.findById(image.appId);
    if (!app) throw new NotFoundException(`Image ${imageId} not found`);
    await this.appAccess.assertCan(user, IAM_PERMISSION.APP_WRITE, app);
  }

  @Get()
  @ApiOperation({
    summary: 'List all images',
    description:
      'List all images with optional filters by appId, tag, and pagination',
  })
  @ApiResponse({
    status: 200,
    description: 'Images listed',
    type: [ImageResponseDto],
  })
  async listImages(@Query() query: ListImagesQueryDto): Promise<ImageEntity[]> {
    return this.imageRegistryService.listImages(query);
  }

  @Get('apps/:appId')
  @ApiOperation({
    summary: 'List images by app',
    description: 'List all images for a specific application',
  })
  @ApiResponse({
    status: 200,
    description: 'Images listed',
    type: [ImageResponseDto],
  })
  async listImagesByApp(@Param('appId') appId: string): Promise<ImageEntity[]> {
    return this.imageRegistryService.listImagesByApp(appId);
  }

  @Get(':imageId')
  @ApiOperation({ summary: 'Get image details' })
  @ApiResponse({
    status: 200,
    description: 'Image found',
    type: ImageResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Image not found' })
  async getImage(@Param('imageId') imageId: string): Promise<ImageEntity> {
    return this.imageRegistryService.getImage(imageId);
  }

  @Post(':imageId/tags')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Add a Flui tag to an image',
    description: 'Add a custom tag like "production", "stable", "v1.2.0"',
  })
  @ApiResponse({
    status: 200,
    description: 'Tag added',
    type: ImageResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Image not found' })
  async addFluiTag(
    @Param('imageId') imageId: string,
    @Body() dto: AddFluiTagDto,
  ): Promise<ImageEntity> {
    return this.imageRegistryService.addFluiTag(imageId, dto.tag);
  }

  @Delete(':imageId/tags/:tag')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a Flui tag from an image' })
  @ApiResponse({
    status: 200,
    description: 'Tag removed',
    type: ImageResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Image not found' })
  async removeFluiTag(
    @Param('imageId') imageId: string,
    @Param('tag') tag: string,
    @Req() req: Request,
  ): Promise<ImageEntity> {
    await this.assertMayChangeImage(imageId, req.user as AuthenticatedUser);
    return this.imageRegistryService.removeFluiTag(imageId, tag);
  }

  @Post(':imageId/deploy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deploy this image',
    description:
      "Deploy a specific image version to the app's cluster (rollback)",
  })
  @ApiResponse({ status: 200, description: 'Deploy triggered' })
  @ApiResponse({ status: 404, description: 'Image not found' })
  async deployImage(
    @Param('imageId') imageId: string,
    @Req() req: Request,
  ): Promise<{ operationId: string; status: string }> {
    const { userId } = req.user as AuthenticatedUser;
    const op = await this.imageRegistryService.deployImageById(imageId, userId);
    return { operationId: op.id, status: op.status };
  }

  @Delete(':imageId')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete an image',
    description: 'Delete image record. Blocks if image is currently deployed.',
  })
  @ApiResponse({ status: 200, description: 'Image deleted' })
  @ApiResponse({ status: 400, description: 'Cannot delete deployed image' })
  @ApiResponse({ status: 404, description: 'Image not found' })
  async deleteImage(
    @Param('imageId') imageId: string,
    @Req() req: Request,
  ): Promise<{ deleted: boolean }> {
    await this.assertMayChangeImage(imageId, req.user as AuthenticatedUser);
    await this.imageRegistryService.deleteImage(imageId);
    return { deleted: true };
  }

  // ── GHCR Registry Endpoints ───────────────────────────────────────────

  @Get('apps/:appId/ghcr')
  @ApiOperation({
    summary: 'List real GHCR image versions for an app',
    description:
      'Queries GitHub Container Registry for all container versions of this application. Joins with local image records for deployed state and Flui tags.',
  })
  @ApiResponse({
    status: 200,
    description: 'GHCR versions listed',
    type: [GhcrTagDto],
  })
  @ApiResponse({ status: 404, description: 'Application or package not found' })
  async listGhcrVersions(
    @Req() req: Request,
    @Param('appId') appId: string,
  ): Promise<GhcrTagDto[]> {
    const { userId } = req.user as AuthenticatedUser;
    return this.imageRegistryService.listGhcrTagsForApp(appId, userId);
  }

  @Delete('apps/:appId/ghcr/:versionId')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a GHCR image version',
    description:
      'Permanently deletes a container version from GitHub Packages. Refuses to delete the currently deployed version or the image of the latest release; pass force=true to override the latest-release guard. The currently-deployed guard is never bypassable.',
  })
  @ApiResponse({ status: 200, description: 'Version deleted' })
  @ApiResponse({
    status: 400,
    description: 'Cannot delete currently deployed or latest-release version',
  })
  @ApiResponse({ status: 404, description: 'Version not found' })
  async deleteGhcrVersion(
    @Req() req: Request,
    @Param('appId') appId: string,
    @Param('versionId', ParseIntPipe) versionId: number,
    @Query('force') force?: string,
  ): Promise<{ deleted: boolean }> {
    const { userId } = req.user as AuthenticatedUser;
    await this.imageRegistryService.deleteGhcrTagForApp(
      appId,
      versionId,
      userId,
      { force: force === 'true' },
    );
    return { deleted: true };
  }

  @Post('apps/:appId/ghcr/:tag/deploy')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redeploy an older GHCR tag (rollback)',
    description:
      'Verifies the tag exists on GHCR, then triggers a deploy with that image. Use for rolling back to a previous version.',
  })
  @ApiResponse({ status: 200, description: 'Deploy triggered' })
  @ApiResponse({ status: 404, description: 'Tag not found on GHCR' })
  async redeployGhcrTag(
    @Req() req: Request,
    @Param('appId') appId: string,
    @Param('tag') tag: string,
  ): Promise<{ operationId: string; status: string }> {
    const { userId } = req.user as AuthenticatedUser;
    const op = await this.imageRegistryService.redeployGhcrTag(
      appId,
      tag,
      userId,
    );
    return { operationId: op.id, status: op.status };
  }
}
