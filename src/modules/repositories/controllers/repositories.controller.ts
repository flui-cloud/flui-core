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
  ParseUUIDPipe,
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
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ExtractEnvDto, ExtractedEnvVarDto } from '../dto/extract-env.dto';
import { RepositoryMapResponseDto } from '../dto/repository-map.dto';
import { RepoMapService } from '../services/repo-map.service';
import {
  RepositoryApplyDto,
  RepositoryApplyResponseDto,
} from '../dto/repository-apply.dto';
import { RepoApplyService } from '../services/repo-apply.service';
import { mapApplyClause } from '../map-apply-clause';
import { SANDBOX_GUEST_REQUEST } from '../../sandbox/guards/sandbox-fence.guard';

@ApiTags('Repositories')
@ApiBearerAuth()
@Controller('repositories')
export class RepositoriesController {
  constructor(
    private readonly repositoriesService: RepositoriesService,
    private readonly webhookService: WebhookService,
    private readonly repoMapService: RepoMapService,
    private readonly repoApplyService: RepoApplyService,
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
  // Every call asks. Which repositories are being connected is in the body and
  // not in the path, so there is no id an "always" could be pinned to, and a
  // standing yes would let any repository be connected from then on.
  @ActionCycle({
    action: 'POST /repositories/import',
    sentence: 'connect GitHub repositories to this instance',
    consequence:
      'Each one is stored here together with a credential that can read it, and applications can then be built and deployed from its code.',
  })
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

  /**
   * The id is checked before it reaches Postgres, and that is the whole point.
   *
   * `repositories.id` is a uuid column, so anything else — a path segment that
   * was meant to be a sibling route, a probe — reached the driver and came back
   * as `invalid input syntax for type uuid`, which this API answers as a 500.
   * The same shape is already documented on the API-key strategy, where a
   * varchar/uuid mismatch answered 500 instead of 401. A 500 says the server
   * broke; nothing broke, the id simply cannot name anything.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get repository details' })
  @ApiResponse({ status: 200, description: 'Repository details' })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async getRepository(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
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
      'Detects the framework and generates a build plan. Authentication is ' +
      'required: the repository is public, the caller is not.',
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

  /**
   * The map, as the engine actually holds it — read-only.
   *
   * Every fact keeps its citation (`file:line`) and its firmness (declared /
   * derived / circumstantial), the open questions and caveats stay questions
   * and caveats, and the verdict stays one of the six the taxonomy allows.
   * Flattening any of that into a list of ticks would throw away the only
   * thing this engine has to say: not "it works", but what will happen and
   * what we could not tell.
   *
   * `clusterId` is optional and it changes what the verdict *is*: without one,
   * only the repository half is computed and `verdict.capacity.assessed` is
   * `false` — never a `deployable` that was never weighed against a cluster.
   */
  @Post(':id/map')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary:
      'Map the repository: units, services, verdict and rendered manifests',
    description:
      'Reads the repository as one in-memory archive of one commit — no clone, symlinks refused, ' +
      'ceilings declared in the response — and returns what it says about itself: deployable units, ' +
      'the services it wants, required inputs, external dependencies, blockers, caveats, open ' +
      'questions and the decisions taken on its behalf, each with its file:line evidence and its ' +
      'confidence; the verdict with its reason and remedy; and one rendered flui.yaml per unit. ' +
      'Read-only: nothing is deployed, provisioned or written.',
  })
  @ApiQuery({
    name: 'branch',
    required: false,
    description: 'Git ref to read from (defaults to the default branch)',
  })
  @ApiQuery({
    name: 'clusterId',
    required: false,
    description:
      'Weigh the map against this cluster. Omitted, the verdict answers only the repository half and says so in verdict.capacity.',
  })
  @ApiResponse({
    status: 200,
    description:
      'Map produced (a repository that could not be read answers with read.ok=false and a not_assessed verdict)',
    type: RepositoryMapResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  async mapRepository(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Query('branch') branch?: string,
    @Query('clusterId') clusterId?: string,
  ): Promise<RepositoryMapResponseDto> {
    const { userId } = req.user as AuthenticatedUser;
    const repository = await this.repositoriesService.getRepository(userId, id);
    return this.repoMapService.mapFor(userId, {
      repositoryId: repository.id,
      owner: repository.owner,
      repo: repository.repositoryName,
      ref: branch || repository.defaultBranch,
      clusterId,
    });
  }

  /**
   * The map, acted on — on a branch of Flui's own.
   *
   * The author's branch is read and cut from, never written to. What lands is
   * one commit on `flui/deploy-<sha7>` carrying one rendered `flui.yaml` per
   * deployable unit and the workflow that builds it, and that commit is what
   * starts the builds. If the build goes green the author promotes the
   * manifests onto their own branch; if it does not, a branch is deleted and
   * nothing happened to their repository.
   *
   * Nothing about the manifests comes from the request: they are rendered
   * server-side from the map at the moment of the apply. The caller chooses
   * the cluster, the branch to read, and — at most — which of the rendered
   * units to apply.
   */
  @Post(':id/map/apply')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(IAM_PERMISSION.APP_CREATE)
  // Unlike `POST /repositories/import`, the repository being acted on IS the
  // path parameter here, so an "always" has an edge to be pinned to and gets
  // one. Without `bind` the request cannot state its own boundary and the
  // cycle offers only "allow once" — fail-closed, but it would ask on every
  // apply of a repository somebody already said yes to.
  @ActionCycle({
    action: 'POST /repositories/:id/map/apply',
    bind: ['id'],
    sentence:
      'commit Flui-rendered manifests to repository {id} and start their builds',
    clause: mapApplyClause,
    consequence:
      'A new branch flui/deploy-<sha7> is created in the repository at the commit that was read — the branch you name is read and never written to — and one commit lands on it carrying a flui.yaml and a build workflow per unit. That commit starts a GitHub Actions build for each, which spends this repository’s Actions minutes, and one application is created per unit on the Flui branch.',
  })
  @ApiOperation({
    summary: 'Apply the map: cut a Flui branch, commit the manifests, build',
    description:
      'Reads the repository at the given branch, refuses unless the verdict allows a deploy, then creates ' +
      'a branch `flui/deploy-<sha7>` **at the exact commit the map was read from** and lands ONE commit on ' +
      'it containing the rendered flui.yaml of every deployable unit plus a build workflow for each. That ' +
      'commit triggers the builds. One Application is created per unit, on the Flui branch — a distinct ' +
      'identity from anything deployed from the author’s own branch, so an apply can never overwrite a ' +
      'production application. The author’s branch is never written to. ' +
      'A failure before the commit deletes the Flui branch but does NOT delete the applications already ' +
      'created: preparing one provisions the services its manifest declares, and a service is only removed ' +
      'through the removal preview. Those applications are named in the error and reused by the next apply.',
  })
  @ApiResponse({
    status: 201,
    description:
      'Branch cut, commit landed, builds started. Check `partial`: when true the commit is real and every ' +
      'build is running, but at least one unit could not be armed — `units[].armed` and `units[].reason` say which.',
    type: RepositoryApplyResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'A named unit has no rendered manifest',
  })
  @ApiResponse({
    status: 403,
    description:
      'No write access to the repository (nothing was written), or a sandbox guest',
  })
  @ApiResponse({ status: 404, description: 'Repository not found' })
  @ApiResponse({
    status: 409,
    description:
      'A Flui branch for this exact commit already exists — an earlier apply holds it',
  })
  @ApiResponse({
    status: 422,
    description:
      'The repository could not be read, the verdict does not allow a deploy, or no unit rendered',
  })
  async applyRepositoryMap(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ errorHttpStatusCode: 404 })) id: string,
    @Body() dto: RepositoryApplyDto,
  ): Promise<RepositoryApplyResponseDto> {
    const { userId, email } = req.user as AuthenticatedUser;
    const repository = await this.repositoriesService.getRepository(userId, id);
    const marked = req as Request & { [SANDBOX_GUEST_REQUEST]?: unknown };
    return this.repoApplyService.apply(userId, email, {
      repositoryId: repository.id,
      owner: repository.owner,
      repo: repository.repositoryName,
      branch: dto.branch || repository.defaultBranch,
      clusterId: dto.clusterId,
      unitIds: dto.unitIds,
      isSandboxGuest: marked[SANDBOX_GUEST_REQUEST] !== undefined,
    });
  }
}
