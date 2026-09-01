import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Request } from 'express';
import { DockerImageSourceConfig } from '../interfaces/source-config.interface';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { stripSandboxPlacementFields } from '../utils/sandbox-placement.util';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ApplicationService } from '../services/application.service';
import { ApplicationGroupingService } from '../services/application-grouping.service';
import { ApplicationGroupDto } from '../dto/application-group.dto';
import { AppManagementService } from '../services/app-management.service';
import { ApplicationDeployService } from '../services/application-deploy.service';
import { SystemAppCatalogService } from '../services/system-app-catalog.service';
import { ApplicationReconciliationService } from '../services/application-reconciliation.service';
import {
  ApplicationWorkflowService,
  GenerateWorkflowDto,
  GenerateWorkflowV3Dto,
  GenerateWorkflowResultDto,
} from '../services/application-workflow.service';
import { WorkflowRunStatus } from '../../repositories/services/github-workflow.service';
import { WorkflowConsent } from '../../repositories/services/workflow-consent';
import { BuildExpectation } from '../../app-builds/services/build-expectation';
import { SANDBOX_GUEST_REQUEST } from '../../sandbox/guards/sandbox-fence.guard';
import { AppRevisionsRepository } from '../repositories/app-revisions.repository';
import { AppEventType, AppEventActorType } from '../enums/app-event-type.enum';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { UpdateApplicationDto } from '../dto/update-application.dto';
import { DeployApplicationDto } from '../dto/deploy-application.dto';
import { RollbackApplicationDto } from '../dto/rollback-application.dto';
import {
  ApplicationResponseDto,
  AppResourceResponseDto,
  AppAuditEventSummaryDto,
  CreateApplicationResponseDto,
  DeleteApplicationResponseDto,
} from '../dto/application-response.dto';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationKind } from '../enums/application-kind.enum';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AppAccessGuard, AppAction } from '../guards/app-access.guard';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { deployFromYamlClause, deployValidatesOnly } from '../deploy-clause';
import { ApplicationAccessService } from '../services/application-access.service';
import { DockerHubService } from '../../images/services/dockerhub.service';
import { ApplicationSourceDeployService } from '../services/application-source-deploy.service';
import {
  DeployFromYamlDto,
  DeployFromYamlResponseDto,
} from '../dto/deploy-from-yaml.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller()
@UseGuards(AppAccessGuard)
export class ApplicationsController {
  private readonly logger = new Logger(ApplicationsController.name);

  constructor(
    private readonly applicationAccess: ApplicationAccessService,
    private readonly applicationService: ApplicationService,
    private readonly applicationDeployService: ApplicationDeployService,
    private readonly systemAppCatalogService: SystemAppCatalogService,
    private readonly reconciliationService: ApplicationReconciliationService,
    private readonly appRevisionsRepository: AppRevisionsRepository,
    private readonly dockerHubService: DockerHubService,
    private readonly applicationWorkflowService: ApplicationWorkflowService,
    private readonly applicationSourceDeployService: ApplicationSourceDeployService,
    private readonly appManagementService: AppManagementService,
    private readonly applicationGroupingService: ApplicationGroupingService,
  ) {}

  // ── CRUD ──────────────────────────────────────────────

  @Post('clusters/:clusterId/applications')
  // The action the trial exists to show, and therefore the first place the
  // cycle has to hold: an agent's first write raises a request, the person
  // answers "always: create applications in this cluster", and from there it
  // flows. People, the CLI and service identities are untouched — only a
  // credential declaring an `mcp:*` ceiling waits.
  @ActionCycle({
    action: 'POST /clusters/:clusterId/applications',
    bind: ['clusterId'],
    sentence: 'create applications in cluster {clusterId}',
    consequence:
      'The applications are scheduled onto the cluster and start consuming its capacity.',
  })
  @ApiOperation({
    summary: 'Create a new application in a cluster',
    description:
      'Creates the application and optionally triggers a deploy immediately. ' +
      'When autoDeploy is true, the response includes an operation object for tracking progress. ' +
      'For docker_image sources, the image is verified against DockerHub before creation.',
  })
  @ApiParam({ name: 'clusterId', description: 'Target cluster ID' })
  @ApiResponse({ status: 201, type: CreateApplicationResponseDto })
  async create(
    @Param('clusterId') clusterId: string,
    @Body() dto: CreateApplicationDto,
    @Req() req: Request,
  ): Promise<CreateApplicationResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;

    const access = await this.applicationAccess.assertCanCreate(user, {
      clusterId,
      category: dto.category,
      kind: dto.kind,
      slug: dto.slug,
    });
    if (access.isSandbox) {
      stripSandboxPlacementFields(dto);
    }

    // Create app atomically from a completed standalone build
    if (dto.buildId) {
      return this.applicationDeployService.createFromBuild(
        clusterId,
        dto,
        user?.userId,
        user?.email,
      );
    }

    // Validate Docker image existence for DockerHub images before creating
    if (dto.sourceType === ApplicationSourceType.DOCKER_IMAGE) {
      const imageRef = (dto.sourceConfig as DockerImageSourceConfig)?.imageRef;
      if (imageRef && this.isDockerHubImage(imageRef)) {
        const result = await this.dockerHubService.verifyImage(imageRef);
        if (!result.exists) {
          throw new BadRequestException(
            `Docker image not found: ${imageRef}. ` +
              `Please verify the image name and tag on DockerHub.`,
          );
        }
      }
    }

    const entity = await this.applicationService.create(
      clusterId,
      dto,
      user?.userId,
      user?.email,
    );
    await this.appRevisionsRepository.createAuditEvent({
      applicationId: entity.id,
      eventType: AppEventType.CREATED,
      actor: { type: AppEventActorType.API },
      changeMetadata: {
        clusterId,
        sourceType: dto.sourceType,
        k8sNamespace: entity.k8sNamespace,
      },
    });

    const application = this.applicationService.toResponseDto(
      await this.applicationService.findById(entity.id),
    );

    // Auto-deploy if requested
    if (dto.autoDeploy) {
      // The author travels with the release: without it the first release of
      // every autoDeploy application is recorded as having no one behind it.
      const operation = await this.applicationDeployService.deploy(
        entity.id,
        {},
        user?.userId,
      );
      return {
        application,
        operation: {
          id: operation.id,
          status: operation.status,
          totalSteps: operation.totalSteps,
          operationType: operation.operationType,
        },
      };
    }

    return { application, operation: null };
  }

  /**
   * Returns true for images that belong to DockerHub (no custom registry host).
   * Examples that return true: 'nginx', 'nginx:1.25', 'myuser/app:v1', 'docker.io/library/nginx'
   * Examples that return false: 'ghcr.io/owner/app:v1', 'registry.example.com/app:v1'
   */
  private isDockerHubImage(imageRef: string): boolean {
    const clean = imageRef.replace(/^docker\.io\//, '');
    const firstSegment = clean.split('/')[0];
    // A custom registry host always contains a dot (e.g. ghcr.io, registry.example.com)
    // or a colon for port (e.g. localhost:5000). DockerHub images have neither.
    return !firstSegment.includes('.') && !firstSegment.includes(':');
  }

  @Get('clusters/:clusterId/applications')
  @ApiOperation({ summary: 'List applications in a cluster' })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiQuery({ name: 'category', enum: ApplicationCategory, required: false })
  @ApiQuery({ name: 'kind', enum: ApplicationKind, required: false })
  @ApiQuery({ name: 'status', enum: ApplicationStatus, required: false })
  @ApiQuery({
    name: 'refresh',
    required: false,
    type: Boolean,
    description:
      'Reconcile application status from K8s before returning (default: false)',
  })
  @ApiResponse({ status: 200, type: [ApplicationResponseDto] })
  async listByCluster(
    @Req() req: Request,
    @Param('clusterId') clusterId: string,
    @Query('category') category?: ApplicationCategory,
    @Query('kind') kind?: ApplicationKind,
    @Query('status') status?: ApplicationStatus,
    @Query('refresh') refresh?: string,
  ): Promise<ApplicationResponseDto[]> {
    if (refresh === 'true') {
      await this.reconciliationService.reconcileByClusterId(clusterId);
    }
    const apps = await this.applicationService.findByClusterId(clusterId, {
      category,
      kind,
      status,
    });
    const visible = await this.applicationAccess.filterReadable(
      req.user as AuthenticatedUser,
      apps,
    );
    const access = await this.applicationAccess.summarise(
      req.user as AuthenticatedUser,
      visible,
    );
    // Enriched, not plain: `toResponseDto` leaves `url` and `internalUrl` empty,
    // so every consumer of this list — the dashboard included — was reading
    // applications with no address at all. The enrichment costs two queries for
    // the whole page, not one per application.
    const dtos = await this.applicationService.toResponseDtosWithUrls(visible);
    return dtos.map((dto) => ({ ...dto, access: access.get(dto.id) }));
  }

  @Get('clusters/:clusterId/applications/grouped')
  @ApiOperation({
    summary: 'List applications grouped by composed-app bundle',
    description:
      'Like the flat listing, but composed catalog installs collapse their ' +
      'component apps into a single entry (with aggregated status and the ' +
      'primary URL). Standalone apps are groups of one. Both the dashboard ' +
      'and CLI render from this shape.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiQuery({
    name: 'refresh',
    required: false,
    type: Boolean,
    description:
      'Reconcile application status from K8s before returning (default: false)',
  })
  @ApiResponse({ status: 200, type: [ApplicationGroupDto] })
  async listGroupedByCluster(
    @Req() req: Request,
    @Param('clusterId') clusterId: string,
    @Query('refresh') refresh?: string,
  ): Promise<ApplicationGroupDto[]> {
    if (refresh === 'true') {
      await this.reconciliationService.reconcileByClusterId(clusterId);
    }
    return this.applicationGroupingService.listGroupedByCluster(
      clusterId,
      req.user as AuthenticatedUser,
    );
  }

  @Get('applications/:id')
  @ApiOperation({ summary: 'Get application details' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiQuery({
    name: 'refresh',
    required: false,
    type: Boolean,
    description:
      'Reconcile application status from K8s before returning (default: false)',
  })
  @ApiResponse({ status: 200, type: ApplicationResponseDto })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async findById(
    @Param('id') id: string,
    @Req() req: Request,
    @Query('refresh') refresh?: string,
  ): Promise<ApplicationResponseDto> {
    if (refresh === 'true') {
      await this.reconciliationService.reconcileOne(id);
    }
    const app = await this.applicationService.findById(id);
    const dto = await this.applicationService.toResponseDtoWithOperation(app);
    const access = await this.applicationAccess.summarise(
      req.user as AuthenticatedUser,
      [app],
    );
    return { ...dto, access: access.get(app.id) };
  }

  @Get('applications/:id/operations')
  @ApiOperation({
    summary: 'List operations for an application (deploy, rollback, etc.)',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max items (default 20)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Offset for pagination (default 0)',
  })
  @ApiResponse({ status: 200 })
  async getOperations(
    @Param('id') id: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    await this.applicationService.findById(id); // ensure app exists
    const result = await this.applicationService.getOperations(
      id,
      limit ? Number.parseInt(limit, 10) : 20,
      offset ? Number.parseInt(offset, 10) : 0,
    );
    return {
      items: result.items.map((op) =>
        this.applicationService.toOperationDto(op),
      ),
      total: result.total,
    };
  }

  @Patch('applications/:id')
  @ApiOperation({
    summary: 'Update application configuration',
    description:
      'Persists configuration changes. When fields that affect the rendered K8s Deployment change (env, resources, scaling, replicas, port, startCommand, exposure, sourceConfig) and the app is in a deployed state with a known imageRef, an automatic redeploy is triggered so the live workload picks up the change.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: ApplicationResponseDto })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdateApplicationDto,
  ): Promise<ApplicationResponseDto> {
    // A tag decides which grants select this application — `showcase` alone puts
    // it in front of every guest on the instance. That is an access decision, so
    // holding app:write over the application is not enough to make it.
    const tagChangeRefused =
      dto.tags !== undefined &&
      !(await this.applicationAccess.mayPublishShowcase(
        req.user as AuthenticatedUser | undefined,
      ));
    if (tagChangeRefused) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'TAGS_ADMIN_ONLY',
        message:
          'Tags decide who can see an application, so changing them needs showcase:publish.',
      });
    }
    const app = await this.applicationService.update(id, dto);

    const deployableFieldChanged =
      dto.env !== undefined ||
      dto.resources !== undefined ||
      dto.scaling !== undefined ||
      dto.replicas !== undefined ||
      dto.port !== undefined ||
      dto.startCommand !== undefined ||
      dto.exposure !== undefined ||
      dto.sourceConfig !== undefined;

    const reconcilableStatuses = new Set<ApplicationStatus>([
      ApplicationStatus.RUNNING,
      ApplicationStatus.DEGRADED,
      ApplicationStatus.FAILED,
      ApplicationStatus.UPDATING,
    ]);

    if (
      deployableFieldChanged &&
      app.imageRef &&
      reconcilableStatuses.has(app.status)
    ) {
      const userId = (req.user as AuthenticatedUser | undefined)?.userId;
      try {
        await this.applicationDeployService.triggerDeployWithImage(
          app.id,
          app.imageRef,
          userId,
        );
      } catch (err) {
        this.logger.warn(
          `Auto-redeploy after PATCH failed for ${app.id}: ${(err as Error).message}`,
        );
      }
    }

    return this.applicationService.toResponseDto(app);
  }

  @Delete('applications/:id')
  @AppAction(IAM_PERMISSION.APP_DELETE)
  @ActionCycle({
    action: 'DELETE /applications/:id',
    bind: ['id'],
    sentence: 'delete application {id} for good, and the data it holds',
  })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Delete an application',
    description:
      'Queues an async delete job that removes K8s resources and soft-deletes the application. ' +
      'Track progress via the returned operation (polling or WebSocket subscribe:application).',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({
    status: 202,
    type: DeleteApplicationResponseDto,
    description: 'Delete job accepted — track via operation',
  })
  @ApiResponse({
    status: 400,
    description: 'Cannot delete system-protected application',
  })
  async delete(@Param('id') id: string): Promise<DeleteApplicationResponseDto> {
    this.logger.log(`[DELETE] HTTP DELETE /applications/${id} received`);
    try {
      const operation =
        await this.applicationDeployService.deleteApplication(id);
      this.logger.log(
        `[DELETE] HTTP DELETE /applications/${id} → returning operation ${operation.id} status=${operation.status}`,
      );
      return {
        operation: {
          id: operation.id,
          status: operation.status,
          totalSteps: operation.totalSteps,
          operationType: operation.operationType,
        },
      };
    } catch (err) {
      this.logger.error(
        `[DELETE] HTTP DELETE /applications/${id} failed: ${err.message}`,
        err.stack,
      );
      throw err;
    }
  }

  // ── Source Deploy ─────────────────────────────────────

  @Post('applications/manifest/validate')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a flui.yaml (kind: Application) without deploying it',
    description:
      'Runs the deploy up to the point before it acts: the same parse and the ' +
      'same overlay of branch environment and stored overrides, then the ' +
      'questions a schema cannot answer — target cluster, connected repository, ' +
      'build credentials, live capacity against the resources asked for, whether ' +
      'this creates an application or updates one, and how it is reached. ' +
      'Returns the effective manifest, the checks, and whether anything would ' +
      'stop a deploy. A check of `unknown` means this installation could not ' +
      'answer and never blocks. Writes nothing.',
  })
  @ApiResponse({ status: 200, type: DeployFromYamlResponseDto })
  async validateManifest(
    @Req() req: Request,
    @Body() dto: DeployFromYamlDto,
  ): Promise<DeployFromYamlResponseDto> {
    const user = req.user as AuthenticatedUser;
    // Reads, and reads only — the permission above is what a reader already
    // holds, and the service is entered on the branch that returns before it
    // creates anything. Sharing that entry point with the deploy is deliberate:
    // a validator of its own would drift from what the deploy actually does.
    return this.applicationSourceDeployService.deployFromYaml(
      user.userId,
      { ...dto, validateOnly: true },
      user.email,
    );
  }

  @Post('applications/deploy-from-yaml')
  @HttpCode(HttpStatus.CREATED)
  // Every call asks. The application may not exist yet, so there is no id an
  // "always" could be pinned to, and a standing yes would cover every future
  // deploy. The clause names the repository and branch, which is the only way
  // the person deciding can tell which application this is about.
  @ActionCycle({
    action: 'POST /applications/deploy-from-yaml',
    sentence: 'create or replace an application from a manifest and deploy it',
    clause: deployFromYamlClause,
    // The same path also answers "would this manifest work", and that call
    // returns before it acts: see `deployValidatesOnly`.
    dryRun: deployValidatesOnly,
    consequence:
      'A build workflow is committed to the repository and a build and deploy start; where the application already exists, the running version is replaced by what this manifest builds.',
  })
  @ApiOperation({
    summary: 'Deploy from source using a flui.yaml (kind: Application)',
    description:
      'Creates or updates an application from a flui.yaml manifest, commits a ' +
      'GitHub Actions workflow to the linked repository, and triggers a build+deploy cycle. ' +
      'Idempotent: re-deploying the same manifest updates the existing app.',
  })
  @ApiResponse({ status: 201, type: DeployFromYamlResponseDto })
  async deployFromYaml(
    @Req() req: Request,
    @Body() dto: DeployFromYamlDto,
  ): Promise<DeployFromYamlResponseDto> {
    const user = req.user as AuthenticatedUser;
    await this.applicationAccess.assertCanCreate(user, {
      clusterId: dto.clusterId,
    });
    return this.applicationSourceDeployService.deployFromYaml(
      user.userId,
      dto,
      user.email,
    );
  }

  // ── Deploy Operations ─────────────────────────────────

  @Post('applications/:id/deploy')
  // Pinned to the one application, not to "deploying": an agent allowed to
  // redeploy this app forever has been given exactly that, and a second
  // application asks again.
  @ActionCycle({
    action: 'POST /applications/:id/deploy',
    bind: ['id'],
    sentence: 'deploy application {id} whenever it asks',
    consequence:
      'The running version is replaced by the one being built; if that build is broken, the application is down until it is rolled back.',
  })
  @ApiOperation({ summary: 'Trigger deployment for an application' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 201, description: 'Deploy job queued' })
  async deploy(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DeployApplicationDto,
  ) {
    // `deployedBy` on the release record, and the owner of the operation this
    // returns. The parameter stays optional in the service: a GitHub webhook
    // deploys with no person behind it, and inventing one to satisfy a type
    // would be worse than an honest absence.
    const userId = (req.user as AuthenticatedUser | undefined)?.userId;
    return this.applicationDeployService.deploy(id, dto, userId);
  }

  @Post('applications/:id/rollback')
  @AppAction(IAM_PERMISSION.APP_DEPLOY)
  @ApiOperation({ summary: 'Rollback to a previous revision' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 201, description: 'Rollback job queued' })
  async rollback(@Param('id') id: string, @Body() dto: RollbackApplicationDto) {
    return this.applicationDeployService.rollback(id, dto);
  }

  // ── GitHub Actions Workflow ───────────────────────────

  @Post('applications/:id/generate-workflow')
  @ApiOperation({
    summary: 'Generate and commit GitHub Actions workflow',
    description:
      'Generates a GitHub Actions workflow YAML and Dockerfile, commits them to the linked repository, and saves the webhook token. Triggers the first build.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 201, description: 'Workflow committed' })
  async generateWorkflow(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: GenerateWorkflowDto,
  ): Promise<GenerateWorkflowResultDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.applicationWorkflowService.generateAndCommitWorkflow(
      id,
      userId,
      dto,
    );
  }

  @Post('applications/:id/workflow-preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What the V3 workflow commit would write, before writing it',
    description:
      'Renders the workflow body in full, names every path the commit touches, ' +
      'and says whether it would push to the branch or open a pull request. ' +
      'Writes nothing. The body carries no credentials: the webhook token is a ' +
      'repository secret, named in `webhookSecretName`.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, description: 'The consent record' })
  async previewWorkflowV3(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: GenerateWorkflowV3Dto,
  ): Promise<WorkflowConsent> {
    const { userId } = req.user as AuthenticatedUser;
    return this.applicationWorkflowService.previewWorkflowV3(
      id,
      userId,
      dto,
      isSandboxGuest(req),
    );
  }

  @Post('applications/:id/generate-workflow-v3')
  @ApiOperation({
    summary: 'Generate and commit universal V3 workflow (Dockerfile-first)',
    description:
      'V3: Generates a universal GitHub Actions workflow that builds from the Dockerfile already in the repo. ' +
      'No framework-specific steps, no Dockerfile generation, no secret saving. ' +
      'Image naming: ghcr.io/{owner}/flui-{app-slug}:{sha}',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 201, description: 'V3 workflow committed' })
  async generateWorkflowV3(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: GenerateWorkflowV3Dto,
  ): Promise<GenerateWorkflowResultDto> {
    const { userId } = req.user as AuthenticatedUser;
    return this.applicationWorkflowService.generateAndCommitWorkflowV3(
      id,
      userId,
      dto,
      isSandboxGuest(req),
    );
  }

  @Get('applications/:id/build-expectation')
  @ApiOperation({
    summary: 'How long a build here has taken, measured',
    description:
      'Median and slowest of the finished builds we can attribute to the ' +
      'caller — this application first, their other applications as a fallback. ' +
      'Returns no figures at all when there is nothing measured, rather than a ' +
      'constant dressed up as one.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, description: 'The measurement, or its absence' })
  async getBuildExpectation(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<BuildExpectation> {
    const { userId } = req.user as AuthenticatedUser;
    return this.applicationWorkflowService.getBuildExpectation(id, userId);
  }

  @Get('applications/:id/workflow-status')
  @ApiOperation({ summary: 'Get current GitHub Actions workflow run status' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, description: 'Workflow run status' })
  async getWorkflowStatus(
    @Req() req: Request,
    @Param('id') id: string,
  ): Promise<WorkflowRunStatus> {
    const { userId } = req.user as AuthenticatedUser;
    return this.applicationWorkflowService.getWorkflowStatus(id, userId);
  }

  // `scale:execute`, like `start` below it and like replicas and restart on
  // AppManagementController: stopping is scaling to zero, and the four of them
  // are one domain — runtime, with no reach into configuration. They derived
  // `app:write` from the verb until the permission that names them got a route
  // to govern.
  @Post('applications/:id/stop')
  @AppAction(IAM_PERMISSION.SCALE_EXECUTE)
  @HttpCode(HttpStatus.OK)
  @ActionCycle({
    action: 'POST /applications/:id/stop',
    bind: ['id'],
    sentence: 'stop application {id}',
    // "At one replica" and not "at the count it had": stopping writes
    // `replicas: 0` to the row, so `start()` finds nothing to restore and
    // brings the application back at one however many it was running.
    consequence:
      'It scales to zero and stops answering; nothing it holds is deleted, and starting it again brings it back at a single replica, whatever it was running before.',
  })
  @ApiOperation({ summary: 'Stop an application (scale to 0)' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: ApplicationResponseDto })
  async stop(@Param('id') id: string): Promise<ApplicationResponseDto> {
    const current = await this.applicationService.findById(id);
    const { app } = await this.appManagementService.applyReplicas(id, 0);
    await this.applicationService.updateStatus(id, ApplicationStatus.STOPPED);
    await this.appRevisionsRepository.createAuditEvent({
      applicationId: id,
      eventType: AppEventType.STOP,
      actor: { type: AppEventActorType.API },
      changeMetadata: { previousReplicas: current.replicas },
    });
    return this.applicationService.toResponseDto(app);
  }

  @Post('applications/:id/start')
  @AppAction(IAM_PERMISSION.SCALE_EXECUTE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Start a stopped application' })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, type: ApplicationResponseDto })
  async start(@Param('id') id: string): Promise<ApplicationResponseDto> {
    const current = await this.applicationService.findById(id);
    const replicas = current.replicas > 0 ? current.replicas : 1;
    const { app } = await this.appManagementService.applyReplicas(id, replicas);
    await this.applicationService.updateStatus(id, ApplicationStatus.RUNNING);
    await this.appRevisionsRepository.createAuditEvent({
      applicationId: id,
      eventType: AppEventType.START,
      actor: { type: AppEventActorType.API },
      changeMetadata: { restoredReplicas: replicas },
    });
    return this.applicationService.toResponseDto(app);
  }

  // ── Resources & Events ────────────────────────────────

  @Get('applications/:id/events')
  @ApiOperation({
    summary: 'List all audit events for an application',
    description:
      'Returns the full audit timeline: deploy, rollback, scale, resource update, restart, start, stop, etc.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiQuery({
    name: 'type',
    enum: [
      'deploy',
      'rollback',
      'scale',
      'resource_update',
      'restart',
      'start',
      'stop',
      'config_update',
      'reconciled',
      'created',
    ],
    required: false,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Max events to return (default 50)',
  })
  @ApiQuery({
    name: 'offset',
    required: false,
    type: Number,
    description: 'Pagination offset (default 0)',
  })
  @ApiResponse({ status: 200, type: [AppAuditEventSummaryDto] })
  async getAuditEvents(
    @Param('id') id: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ): Promise<{ events: AppAuditEventSummaryDto[]; total: number }> {
    const result = await this.applicationService.getAuditEvents(id, {
      eventType: type as AppEventType | undefined,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
      offset: offset ? Number.parseInt(offset, 10) : undefined,
    });
    return {
      events: result.events.map((e) =>
        this.applicationService.toAuditEventSummaryDto(e),
      ),
      total: result.total,
    };
  }

  @Get('applications/:id/resources')
  @ApiOperation({
    summary: 'List K8s resources owned by an application',
    description:
      'Returns resource records from DB. Use ?refresh=true to enrich with ' +
      'live K8s data: container specs (requests/limits), replica counts, and CPU/memory usage.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiQuery({
    name: 'refresh',
    required: false,
    type: Boolean,
    description:
      'Fetch live data from K8s: container specs, replica counts, CPU/memory usage (default: false)',
  })
  @ApiResponse({ status: 200, type: [AppResourceResponseDto] })
  async getResources(
    @Param('id') id: string,
    @Query('refresh') refresh?: string,
  ): Promise<AppResourceResponseDto[]> {
    if (refresh === 'true') {
      return this.applicationService.getResourcesLive(id);
    }
    const resources = await this.applicationService.getResources(id);
    return resources.map((r) =>
      this.applicationService.toResourceResponseDto(r),
    );
  }

  // ── System Apps ────────────────────────────────────────

  // Not app-scoped — AppAccessGuard finds no :id/:appId and steps aside — and it
  // reaches into a cluster to create records for what it finds there.
  @Post('clusters/:clusterId/system-apps/discover')
  @RequireSection(SECTION.INFRASTRUCTURE)
  @ApiOperation({
    summary: 'Discover system apps from K8s cluster',
    description:
      'Queries the K8s cluster for known system apps, creates ApplicationEntity records, ' +
      'and patches flui-app-id labels on K8s resources for biunivocal correlation.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 201, description: 'Discovery result' })
  async discoverSystemApps(@Param('clusterId') clusterId: string) {
    return this.systemAppCatalogService.discoverSystemApps(clusterId);
  }

  @Get('clusters/:clusterId/system-apps/catalog')
  @ApiOperation({
    summary: 'List expected system apps for a cluster type',
    description:
      'Returns the catalog of system apps expected for the given cluster.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200, description: 'System app catalog' })
  async getSystemAppCatalog(@Param('clusterId') clusterId: string) {
    return this.systemAppCatalogService.getCatalogForClusterType(
      'observability',
    );
  }

  // ── Reconciliation ─────────────────────────────────────

  @Post('applications/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Force reconciliation for an application',
    description:
      'Immediately reconciles the application state against K8s. ' +
      'Detects drift and auto-heals if driftPolicy=auto_heal.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiResponse({ status: 200, description: 'Reconciliation summary' })
  async reconcile(@Param('id') id: string) {
    return this.reconciliationService.reconcileOne(id);
  }
}

/**
 * Whether the caller is a sandbox guest, read off the marker the global fence
 * guard already set. Resolving the access a second time here would ask the same
 * question of the database twice on every deploy.
 */
function isSandboxGuest(req: Request): boolean {
  const marked = req as Request & { [SANDBOX_GUEST_REQUEST]?: unknown };
  return marked[SANDBOX_GUEST_REQUEST] !== undefined;
}
