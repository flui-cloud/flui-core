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
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RepositoriesService } from '../services/repositories.service';
import { WebhookService } from '../services/webhook.service';
import { ConnectRepositoryResponseDto } from '../dto/create-repository.dto';
import { CreateWebhookDto } from '../dto/webhook.dto';
import {
  AvailableRepositoryDto,
  ImportRepositoriesDto,
  ImportRepositoriesResponseDto,
} from '../dto/github-oauth.dto';
import {
  AnalyzeRepositoryDto,
  RepositoryAnalysisDto,
} from '../dto/analyze-repository.dto';
import { PublicRepositoryAnalyzeDto } from '../dto/public-repository-analyze.dto';
import { RepositoryManifestsDto } from '../dto/repository-manifest.dto';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ExtractEnvDto, ExtractedEnvVarDto } from '../dto/extract-env.dto';

@ApiTags('Repositories')
@ApiBearerAuth()
@Controller('repositories')
export class RepositoriesController {
  constructor(
    private readonly repositoriesService: RepositoriesService,
    private readonly webhookService: WebhookService,
  ) {}

  @Get('available')
  @ApiOperation({ summary: 'List available repositories from GitHub OAuth' })
  @ApiResponse({
    status: 200,
    description: 'List of available repositories',
    type: [AvailableRepositoryDto],
  })
  @ApiResponse({
    status: 404,
    description: 'No active GitHub connection found',
  })
  async listAvailableRepositories(
    @Req() req: Request,
  ): Promise<AvailableRepositoryDto[]> {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.listAvailableRepositories(userId);
  }

  @Post('import')
  // Narrows `viewer` and `showcase_viewer`, which can import repositories today
  // and will not after this: without a permission on the route the credential
  // ceiling cannot see it, so a key scoped to reads could import too.
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({ summary: 'Import selected repositories from GitHub' })
  @ApiResponse({
    status: 201,
    description: 'Repositories imported',
    type: ImportRepositoriesResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No active GitHub connection found',
  })
  async importRepositories(
    @Req() req: Request,
    @Body() dto: ImportRepositoriesDto,
  ): Promise<ImportRepositoriesResponseDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.importRepositories(userId, dto);
  }

  @Get()
  // Answers with the caller's own repositories, and every built-in role holds
  // `app:read`, so nobody loses the list. It is here for the ceiling.
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'List all connected repositories for the current user',
  })
  @ApiResponse({ status: 200, description: 'List of repositories' })
  async listRepositories(
    @Req() req: Request,
  ): Promise<ConnectRepositoryResponseDto[]> {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.listRepositories(userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get repository details' })
  @ApiResponse({ status: 200, description: 'Repository details' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async getRepository(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<ConnectRepositoryResponseDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.getRepository(userId, id);
  }

  // No platform gate, and deliberately: ownership already decides. The service
  // 404s a repository that is not the caller's (`repositories.service.ts`), so
  // it does not even reveal that someone else's exists. The admin gate that
  // used to sit here read "only an administrator may disconnect their *own*
  // repository" — it protected nothing the 404 was not already protecting, and
  // refused the legitimate owner. Decision 4.
  // Ownership already decides *which* row — `repositories.service.ts` answers 404
  // for somebody else's, which is why decision 4 removed the admin gate. What was
  // still missing is the other half: with no permission named, the ceiling could
  // not see the route, so a key minted to read applications disconnected them.
  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect a repository' })
  @ApiResponse({ status: 204, description: 'Repository disconnected' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async deleteRepository(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<void> {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.deleteRepository(userId, id);
  }

  @Get(':id/branches')
  @ApiOperation({ summary: 'List repository branches' })
  @ApiResponse({ status: 200, description: 'List of branches' })
  async listBranches(@Req() req: Request, @Param('id') id: string) {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.listBranches(userId, id);
  }

  @Get(':id/commits')
  @ApiOperation({ summary: 'List repository commits' })
  @ApiQuery({
    name: 'branch',
    required: false,
    description: 'Branch name (defaults to default branch)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Number of commits to return (default: 10)',
    type: Number,
  })
  @ApiResponse({ status: 200, description: 'List of commits' })
  async listCommits(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('branch') branch?: string,
    @Query('limit') limit?: number,
  ) {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.listCommits(userId, id, branch, limit);
  }

  @Post(':id/test')
  @ApiOperation({ summary: 'Test repository connection' })
  @ApiResponse({ status: 200, description: 'Connection test result' })
  async testConnection(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ success: boolean; message: string }> {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.testConnection(userId, id);
  }

  @Post('github/public/analyze')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Analyze a public GitHub repository',
    description:
      'Clones a public GitHub repository without requiring it to be imported. ' +
      'Detects the framework and generates a build plan. No authentication required.',
  })
  @ApiResponse({
    status: 200,
    description: 'Analysis completed',
    type: RepositoryAnalysisDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid or non-public GitHub URL' })
  @ApiResponse({ status: 404, description: 'Branch not found' })
  async analyzePublicRepository(
    @Body() dto: PublicRepositoryAnalyzeDto,
  ): Promise<RepositoryAnalysisDto> {
    return this.repositoriesService.analyzePublicRepository(dto);
  }

  @Get(':id/check-dockerfile')
  @ApiOperation({
    summary: 'Check if repository contains a Dockerfile (V3)',
    description:
      'Lightweight check via GitHub API — no clone needed. Used to decide between Path A (Dockerfile) and Templates redirect.',
  })
  @ApiResponse({ status: 200, description: 'Check completed' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async checkDockerfilePresence(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<{ hasDockerfile: boolean }> {
    const { userId } = req.user as AuthenticatedUser;
    const repository = await this.repositoriesService.getRepository(userId, id);
    return this.repositoriesService.checkDockerfilePresence(
      userId,
      repository.owner,
      repository.repositoryName,
    );
  }

  @Get(':id/manifests')
  @ApiOperation({
    summary: 'Discover flui.yaml manifests in the repository (root + subdirs)',
    description:
      'Lightweight discovery via GitHub API — no clone. Returns every flui.yaml ' +
      'found at the repository root and in subdirectories (monorepo: one manifest ' +
      'per deployable), each validated as a kind: Application flui.cloud/v1beta1 manifest. ' +
      'Drives the manifest-first deploy flow.',
  })
  @ApiQuery({
    name: 'branch',
    required: false,
    description: 'Git ref to read from (defaults to the default branch)',
  })
  @ApiResponse({
    status: 200,
    description: 'Manifest discovery completed',
    type: RepositoryManifestsDto,
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async getManifests(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('branch') branch?: string,
  ): Promise<RepositoryManifestsDto> {
    const { userId } = req.user as AuthenticatedUser;
    const repository = await this.repositoriesService.getRepository(userId, id);
    return this.repositoriesService.getFluiManifests(
      userId,
      repository.owner,
      repository.repositoryName,
      branch || repository.defaultBranch,
    );
  }

  @Post(':id/analyze')
  @ApiOperation({
    summary: 'Analyze repository for framework detection',
    description:
      'Clones the repository, detects the framework, and generates a build plan for deployment',
  })
  @ApiResponse({
    status: 200,
    description: 'Repository analysis completed',
    type: RepositoryAnalysisDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  @ApiResponse({
    status: 500,
    description: 'Framework detection failed or repository clone failed',
  })
  async analyzeRepository(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: AnalyzeRepositoryDto,
  ): Promise<RepositoryAnalysisDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.analyzeRepository(userId, id, dto);
  }

  @Post(':id/extract-env')
  @ApiOperation({
    summary: 'Extract environment variable keys from repository config files',
    description:
      'Clones the repository and scans framework-specific config files for env var keys. Only keys are returned — never values.',
  })
  @ApiResponse({
    status: 200,
    description: 'Env vars extracted',
    type: [ExtractedEnvVarDto],
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async extractEnv(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: ExtractEnvDto,
  ): Promise<ExtractedEnvVarDto[]> {
    const { userId } = req.user as AuthenticatedUser;
    return this.repositoriesService.extractEnv(userId, id, dto);
  }

  @Post(':id/webhook')
  @ApiOperation({ summary: 'Configure webhook for repository' })
  @ApiResponse({ status: 201, description: 'Webhook created' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async createWebhook(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: CreateWebhookDto,
  ) {
    const { userId } = req.user as AuthenticatedUser;
    return this.webhookService.createWebhook(userId, id, dto);
  }

  // Same as DELETE :id above: `webhook.service.ts` 404s a repository that is
  // not the caller's, and every other route on this controller already trusts
  // that check alone. Decision 4.
  @Delete(':id/webhook')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete webhook configuration' })
  @ApiResponse({ status: 204, description: 'Webhook deleted' })
  @ApiResponse({ status: 404, description: 'Webhook not found' })
  async deleteWebhook(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<void> {
    const { userId } = req.user as AuthenticatedUser;
    return this.webhookService.deleteWebhook(userId, id);
  }

  @Get(':id/webhooks')
  @ApiOperation({ summary: 'List all webhooks for repository' })
  @ApiResponse({ status: 200, description: 'List of webhooks' })
  async listWebhooks(@Req() req: Request, @Param('id') id: string) {
    const { userId } = req.user as AuthenticatedUser;
    return this.webhookService.listWebhooks(userId, id);
  }
}
