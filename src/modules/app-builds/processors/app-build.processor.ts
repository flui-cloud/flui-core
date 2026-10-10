import { Processor, Process, InjectQueue } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job, Queue } from 'bull';
import { PassThrough } from 'node:stream';
import * as k8s from '@kubernetes/client-node';
import { Octokit } from '@octokit/rest';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import {
  RepositoryEntity,
  GitProvider,
} from '../../repositories/entities/repository.entity';
import { ownsRepository } from '../../repositories/repositories/repositories.repository';
import { RepositoryCredentialEntity } from '../../repositories/entities/repository-credential.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ApplicationEventsGateway } from '../../applications/gateway/application-events.gateway';
import { ApplicationDeployService } from '../../applications/services/application-deploy.service';
import { AppBuildsRepository } from '../repositories/app-builds.repository';
import { TriggerBuildJobData } from '../services/app-build.service';
import {
  BuildJobService,
  BUILD_NAMESPACE,
} from '../services/build-job.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { BuildCacheInspectionService } from '../services/build-cache-inspection.service';
import { BuildAgentConfigService } from '../services/build-agent-config.service';
import { AppBuildStatus } from '../enums/app-build-status.enum';
import { GitBuildSourceConfig } from '../../applications/interfaces/source-config.interface';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { FrameworkType } from '../../frameworks/framework-core/enums/framework-type.enum';
import { DetectionOrchestratorService } from '../../frameworks/framework-core/services/detection-orchestrator.service';
import { DeployStrategy } from '../../frameworks/framework-core/enums/deploy-strategy.enum';

const MAX_LOG_LINES = 2000;
const LOG_FLUSH_INTERVAL = 20;
const IMAGE_REF_PREFIX = 'IMAGE_REF=';
const COMMIT_SHA_PREFIX = 'COMMIT_SHA=';
const RAILPACK_PLAN_MARKER = '--- RAILPACK PLAN ---';
const RAILPACK_BUILD_MARKER = '--- RAILPACK BUILD ---';

@Processor('app-build')
export class AppBuildProcessor {
  private readonly logger = new Logger(AppBuildProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    @InjectRepository(RepositoryEntity)
    private readonly repositoryRepository: Repository<RepositoryEntity>,
    @InjectRepository(RepositoryCredentialEntity)
    private readonly credentialRepository: Repository<RepositoryCredentialEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly kubernetesService: KubernetesService,
    private readonly eventsGateway: ApplicationEventsGateway,
    private readonly appBuildsRepository: AppBuildsRepository,
    private readonly buildJobService: BuildJobService,
    private readonly applicationDeployService: ApplicationDeployService,
    private readonly clustersService: ClustersService,
    @InjectQueue('app-build') private readonly buildQueue: Queue,
    private readonly buildCacheInspectionService: BuildCacheInspectionService,
    private readonly detectionOrchestrator: DetectionOrchestratorService,
    private readonly buildAgentConfig: BuildAgentConfigService,
  ) {}

  @Process({ name: 'build-from-source', concurrency: 1 })
  async handleBuild(job: Job<TriggerBuildJobData>): Promise<void> {
    const {
      buildId: incomingBuildId,
      applicationId,
      operationId,
      forceRebuild,
    } = job.data;
    const isStandalone = !applicationId;
    const startedAt = Date.now();

    this.logger.log(
      `[PROCESSOR-VERSION] v2 — FrameworkType-aligned detection (hasTool/regex)`,
    );
    const buildTarget = isStandalone
      ? 'standalone build'
      : `application ${applicationId}`;
    this.logger.log(
      `Processing build job for ${buildTarget}, operation: ${operationId}`,
    );

    // ── Defensive gate ────────────────────────────────────────────────────
    // The in-cluster build agent is demoted in favor of the managed offering.
    // Even if something enqueues a job to `app-build` bypassing the deploy
    // service, we MUST NOT allocate any resources in the user's cluster
    // (namespace, PVC, secrets, pods) while the agent is disabled.
    if (!this.buildAgentConfig.isInClusterBuildAgentEnabled()) {
      this.logger.warn(
        `Build job ${job.id} received while in-cluster build agent is disabled ` +
          `(FLUI_IN_CLUSTER_BUILD_AGENT_ENABLED=false) — marking as FAILED without ` +
          `touching the flui-build namespace.`,
      );
      if (incomingBuildId) {
        await this.appBuildsRepository
          .updateStatus(
            incomingBuildId,
            AppBuildStatus.FAILED,
            'In-cluster build agent is disabled',
          )
          .catch(() => {});
      }
      await this.updateOperation(
        operationId,
        OperationStatus.FAILED,
        undefined,
        undefined,
        'In-cluster build agent is disabled',
      ).catch(() => {});
      return;
    }

    let kubeconfig: string | null = null;
    let jobName: string | null = null;
    let activeBuildId: string | null = incomingBuildId || null;

    try {
      // ── Step 1: INIT ───────────────────────────────────────────────────────
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        0,
        OperationStep.APP_BUILD_INIT,
      );

      // Load app (only for app-linked builds)
      let app: ApplicationEntity | null = null;
      let sourceConfig: GitBuildSourceConfig | null = null;

      if (!isStandalone) {
        app = await this.applicationRepository.findOne({
          where: { id: applicationId },
        });
        if (!app) throw new Error(`Application ${applicationId} not found`);
        sourceConfig = app.sourceConfig as GitBuildSourceConfig;
      }

      // Create or load AppBuildEntity
      let build = activeBuildId
        ? await this.appBuildsRepository.findById(activeBuildId)
        : null;
      if (!build) {
        const clusterId =
          job.data.buildClusterId || (app ? app.clusterId : null);
        if (!clusterId)
          throw new Error('No buildClusterId provided for standalone build');
        build = await this.appBuildsRepository.create({
          applicationId: app ? app.id : null,
          buildClusterId: clusterId,
          branch: sourceConfig?.branch || 'main',
          k8sJobName: 'pending',
          status: AppBuildStatus.PENDING,
          operationId,
          startedAt: new Date(),
        });
      }
      activeBuildId = build.id;
      const branch = build.branch || sourceConfig?.branch || 'main';

      const cluster = await this.clusterRepository.findOne({
        where: { id: build.buildClusterId },
      });
      if (!cluster?.kubeconfigEncrypted) {
        throw new Error(
          `Cluster ${build.buildClusterId} not found or kubeconfig missing`,
        );
      }
      kubeconfig = this.encryptionService.decrypt(cluster.kubeconfigEncrypted);

      // Load GitHub credential — use job.data.userId for standalone builds
      const userId = isStandalone ? job.data.userId : app.userId;
      if (!userId)
        throw new Error(`No userId available for build ${activeBuildId}`);

      const credential = await this.credentialRepository.findOne({
        where: { userId, provider: GitProvider.GITHUB, isActive: true },
        order: { createdAt: 'DESC' },
      });
      if (!credential) {
        throw new Error(`No active GitHub credential found for user ${userId}`);
      }

      const githubToken = this.encryptionService.decrypt(
        credential.accessTokenEncrypted,
      );
      const githubUsername = credential.githubUsername;
      if (!githubUsername) {
        throw new Error(
          `GitHub username not set on credential ${credential.id}`,
        );
      }

      // Resolve repo owner/name
      let repoOwner: string;
      let repoName: string;

      if (isStandalone) {
        // Parse from gitUrl stored on the build record
        const match = build.gitUrl
          ? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(build.gitUrl)
          : null;
        if (!match)
          throw new Error(
            `Cannot parse repoOwner/repoName from gitUrl: ${build.gitUrl}`,
          );
        repoOwner = match[1];
        repoName = match[2];
      } else {
        const linked = sourceConfig?.repositoryId
          ? await this.repositoryRepository.findOne({
              where: { id: sourceConfig.repositoryId },
            })
          : null;
        const repository =
          linked && ownsRepository(linked, app?.userId) ? linked : null;
        if (repository) {
          repoOwner = repository.owner;
          repoName = repository.repositoryName;
        } else if (sourceConfig?.gitUrl) {
          const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(
            sourceConfig.gitUrl,
          );
          if (!match)
            throw new Error(
              `Cannot parse repoOwner/repoName from sourceConfig.gitUrl: ${sourceConfig.gitUrl}`,
            );
          repoOwner = match[1];
          repoName = match[2];
        } else {
          throw new Error(
            `Application ${applicationId} has no repositoryId or gitUrl in sourceConfig — cannot determine clone target`,
          );
        }
      }

      this.logger.log(
        `Clone target: github.com/${repoOwner}/${repoName} (branch: ${branch}) ` +
          `[standalone: ${isStandalone}, githubUser: ${githubUsername}]`,
      );

      // Fetch latest commit SHA from GitHub API
      let headCommitSha: string | undefined;
      try {
        const octokit = new Octokit({ auth: githubToken });
        const { data } = await octokit.repos.getBranch({
          owner: repoOwner,
          repo: repoName,
          branch,
        });
        headCommitSha = data.commit.sha;
        await this.appBuildsRepository.update(activeBuildId, {
          commitSha: headCommitSha,
        });
        this.logger.log(
          `Head commit: ${headCommitSha} on ${repoOwner}/${repoName}@${branch}`,
        );
      } catch (err) {
        this.logger.warn(
          `Failed to fetch head commit SHA: ${err.message} — proceeding without deduplication`,
        );
      }

      // Deduplication: skip build if same commit was already built successfully (bypassed when forceRebuild=true or standalone)
      if (headCommitSha && !forceRebuild && !isStandalone) {
        const existing =
          await this.appBuildsRepository.findCompletedByCommitSha(
            applicationId,
            headCommitSha,
          );
        if (existing) {
          this.logger.log(
            `Commit ${headCommitSha} already built (build: ${existing.id}, image: ${existing.imageRef}) — skipping build`,
          );
          await this.appBuildsRepository.update(activeBuildId, {
            status: AppBuildStatus.COMPLETED,
            imageRef: existing.imageRef,
            commitSha: headCommitSha,
            completedAt: new Date(),
          });
          await this.updateOperation(
            operationId,
            OperationStatus.COMPLETED,
            100,
            OperationStep.APP_BUILD_FINALIZE,
          );
          this.eventsGateway.emitBuildCompleted(applicationId, {
            appId: applicationId,
            buildId: activeBuildId,
            imageRef: existing.imageRef,
            duration: Date.now() - startedAt,
            timestamp: new Date(),
          });
          await this.applicationDeployService.triggerDeployWithImage(
            applicationId,
            existing.imageRef,
            app.userId,
          );
          return;
        }
      }

      // Compute imageRef and job name.
      // When forceRebuild=true we append a short build-time suffix so the K8s Job name is
      // unique (avoids conflict with the previous job that may still be in TTL window) and
      // the image tag is distinguishable from a prior build of the same commit.
      const forceSuffix = forceRebuild ? `-${Date.now().toString(36)}` : '';
      const imageRef = this.buildJobService.buildImageRef(
        githubUsername,
        repoName,
        headCommitSha ?? build.commitSha,
        branch,
        forceSuffix,
      );
      jobName = this.buildJobService.buildJobName(
        repoName,
        headCommitSha ?? build.commitSha,
        forceSuffix,
      );

      await this.appBuildsRepository.update(activeBuildId, {
        k8sJobName: jobName,
        imageRef,
      });

      this.eventsGateway.emitBuildStarted(applicationId, {
        appId: applicationId,
        buildId: activeBuildId,
        operationId,
        branch: build.branch,
        commitSha: build.commitSha,
        timestamp: new Date(),
      });

      // ── PRE-FLIGHT: Framework Analysis ───────────────────────────────────
      let preflightStrategy: DeployStrategy = DeployStrategy.RAILPACK_DIRECT;
      let preflightBuildCmd: string | undefined;
      let preflightStartCmd: string | undefined;
      let preflightDockerfile: string | undefined;

      if (job.data.advisorChoices || job.data.advisorStrategy) {
        // User already confirmed choices — use them directly
        preflightStrategy =
          (job.data.advisorStrategy as DeployStrategy) ??
          DeployStrategy.RAILPACK_DIRECT;
        preflightBuildCmd = job.data.advisorChoices?.buildCommand;
        preflightStartCmd = job.data.advisorChoices?.startCommand;

        // Only accept Dockerfiles with the # FLUI-BUILD marker
        const rawDockerfile = job.data.advisorDockerfile;
        if (rawDockerfile?.trimStart().startsWith('# FLUI-BUILD')) {
          preflightDockerfile = rawDockerfile;
        } else if (rawDockerfile) {
          this.logger.warn(
            '[PRE-FLIGHT] advisorDockerfile ignored — missing # FLUI-BUILD marker',
          );
        }

        this.logger.log(
          `[PRE-FLIGHT] Using user-confirmed advisor choices: strategy=${preflightStrategy}`,
        );
      } else {
        try {
          const octokit = new Octokit({ auth: githubToken });
          const result = await this.detectionOrchestrator.detectFromGitHub(
            octokit,
            repoOwner,
            repoName,
            headCommitSha || branch,
          );
          if (result) {
            const { buildPlan, detection } = result;
            preflightStrategy = buildPlan.deployStrategy;
            preflightBuildCmd = buildPlan.suggestedBuildCommand;
            preflightStartCmd = buildPlan.suggestedStartCommand;
            preflightDockerfile = buildPlan.dockerfile || undefined;

            await this.appBuildsRepository.update(activeBuildId, {
              deployStrategy: preflightStrategy,
              deployabilityScore: buildPlan.deployabilityScore,
              deployabilityFactors: buildPlan.deployabilityFactors as any,
              suggestedBuildCommand: preflightBuildCmd ?? null,
              suggestedStartCommand: preflightStartCmd ?? null,
              recommendedStructure: buildPlan.recommendedStructure ?? null,
            });

            if (preflightStrategy === DeployStrategy.NEEDS_ADJUSTMENT) {
              const hints = buildPlan.recommendedStructure?.join(', ') ?? '';
              const warnings = buildPlan.projectWarnings?.join(' ') ?? '';
              throw new Error(
                `Build advisor: project not deployable as-is. ${warnings}${hints ? ' Recommended: ' + hints : ''}`,
              );
            }

            this.logger.log(
              `[PRE-FLIGHT] strategy=${preflightStrategy} score=${buildPlan.deployabilityScore} framework=${detection.framework}`,
            );
          }
        } catch (err) {
          if ((err as Error).message?.startsWith('Build advisor')) throw err;
          this.logger.warn(
            `[PRE-FLIGHT] Detection failed, proceeding with RAILPACK_DIRECT: ${(err as Error).message}`,
          );
        }
      }

      // ── Step 2: CREATE JOB ────────────────────────────────────────────────
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        15,
        OperationStep.APP_BUILD_CREATE_JOB,
      );

      // Pre-flight resource check — fail fast if cluster cannot accommodate the build job
      const resourceCheck = await this.clustersService.getBuildResources(
        build.buildClusterId,
      );
      if (resourceCheck.status === 'insufficient') {
        throw new Error(
          `Cluster has insufficient resources for build job. ` +
            `Required: ${resourceCheck.required.cpu} CPU, ${resourceCheck.required.memory} memory. ` +
            `Available: ${resourceCheck.available.cpu} CPU, ${resourceCheck.available.memory} memory.`,
        );
      }

      await this.buildJobService.ensureBuildNamespace(kubeconfig);
      await this.buildJobService.ensureGhcrSecret(
        kubeconfig,
        githubUsername,
        githubToken,
      );
      await this.buildJobService.ensureBuildCachePvc(kubeconfig);
      await this.buildJobService.ensureBuildRunnerImage(
        kubeconfig,
        githubUsername,
        githubToken,
      );
      const appForJob = isStandalone
        ? ({
            id: `standalone-${activeBuildId}`,
            slug: repoName,
            sourceConfig: { branch },
            port: undefined,
          } as any)
        : app;
      await this.buildJobService.createBuildJob(kubeconfig, {
        build: { ...build, k8sJobName: jobName, imageRef },
        app: appForJob,
        repoOwner,
        repoName,
        githubToken,
        imageRef,
        noCache: forceRebuild ?? false,
        cloneUrl: job.data.publicCloneUrl,
        deployStrategy: preflightStrategy,
        suggestedBuildCommand: preflightBuildCmd,
        suggestedStartCommand: preflightStartCmd,
        dockerfileContent: preflightDockerfile,
      });

      await this.appBuildsRepository.updateStatus(
        activeBuildId,
        AppBuildStatus.CLONING,
      );

      // ── Step 3: WAIT FOR POD RUNNING ──────────────────────────────────────
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        25,
        OperationStep.APP_BUILD_CLONING,
      );

      const logBuffer: string[] = [];

      const podName = await this.buildJobService.waitForPodRunning(
        kubeconfig,
        activeBuildId,
        600_000,
        (line) => {
          logBuffer.push(line);
          this.eventsGateway.emitBuildLog(applicationId, {
            appId: applicationId,
            buildId: activeBuildId,
            line,
            stream: 'stdout',
            timestamp: new Date(),
          });
        },
      );

      await this.appBuildsRepository.update(activeBuildId, {
        k8sPodName: podName,
        status: AppBuildStatus.ANALYZING,
      });

      // ── Step 4: STREAM LOGS ───────────────────────────────────────────────
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        30,
        OperationStep.APP_BUILD_ANALYZING,
      );
      let inPlanSection = false;
      let planJsonBuffer = '';
      let planEmitted = false;
      let finalImageRef = imageRef;
      let detectedFramework: string | undefined;
      let detectedPort: number | undefined;
      let detectedFrontendFramework: string | undefined;
      let detectedStartCommand: string | undefined;

      const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
      const logApi = new k8s.Log(kc);
      const logStream = new PassThrough();

      // Heartbeat every 30s so the frontend knows the build is still running
      const heartbeatInterval = setInterval(() => {
        this.eventsGateway.emitBuildHeartbeat(
          applicationId,
          activeBuildId,
          AppBuildStatus.BUILDING,
        );
      }, 30_000);

      logStream.on('data', (chunk: Buffer) => {
        const lines = chunk.toString().split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;

          // Detect railpack plan section
          if (line.includes(RAILPACK_PLAN_MARKER)) {
            this.logger.debug(`[BUILD-MARKER] PLAN marker detected`);
            inPlanSection = true;
            continue;
          }
          if (line.includes(RAILPACK_BUILD_MARKER)) {
            this.logger.debug(
              `[BUILD-MARKER] BUILD marker detected — switching to BUILDING`,
            );
            inPlanSection = false;
            this.updateOperation(
              operationId,
              OperationStatus.IN_PROGRESS,
              40,
              OperationStep.APP_BUILD_BUILDING,
            ).catch(() => {});
            this.appBuildsRepository
              .updateStatus(activeBuildId, AppBuildStatus.BUILDING)
              .catch((e) =>
                this.logger.warn(
                  `[BUILD-MARKER] Failed to update status: ${e.message}`,
                ),
              );
          }

          // Collect railpack plan JSON — may arrive split across multiple chunks
          if (inPlanSection && !planEmitted) {
            const trimmed = line.trim();
            if (trimmed.startsWith('{')) {
              planJsonBuffer = trimmed; // reset on JSON start
            } else if (planJsonBuffer) {
              planJsonBuffer += trimmed; // accumulate continuation chunks
            }
            if (planJsonBuffer) {
              try {
                const plan = JSON.parse(planJsonBuffer);
                this.logger.debug(
                  `[PLAN-PARSED] OK — framework detection starting`,
                );
                planEmitted = true;
                inPlanSection = false;
                detectedFramework = this.detectFramework(plan);
                detectedPort = this.extractPort(plan, detectedFramework);
                detectedFrontendFramework = this.detectFrontendFramework(plan);
                detectedStartCommand = this.correctStartCommand(
                  plan.deploy?.startCommand,
                );
                this.logger.log(
                  `[detectFramework] framework=${detectedFramework} port=${detectedPort} startCommand=${detectedStartCommand ?? 'none'}`,
                );
                this.appBuildsRepository
                  .update(activeBuildId, {
                    railpackPlan: plan,
                    detectedPort,
                    detectedFramework,
                    detectedFrontendFramework,
                    detectedStartCommand,
                  })
                  .catch(() => {});
                if (!isStandalone && detectedPort && !app.port) {
                  this.applicationRepository
                    .update(applicationId, { port: detectedPort })
                    .catch(() => {});
                  app.port = detectedPort;
                  this.logger.log(
                    `Auto-detected port ${detectedPort} (${detectedFramework}) for application ${applicationId}`,
                  );
                }
                // For standalone builds, extract a suggested app name from project manifests
                if (isStandalone && !build.suggestedName) {
                  this.extractSuggestedName(repoOwner, repoName, githubToken)
                    .then((suggestedName: string) =>
                      this.appBuildsRepository.update(activeBuildId, {
                        suggestedName,
                      }),
                    )
                    .catch(() => {});
                }
                this.eventsGateway.emitBuildPlan(applicationId, {
                  appId: applicationId,
                  buildId: activeBuildId,
                  framework: detectedFramework,
                  buildCommand: this.extractBuildCommand(plan),
                  startCommand: plan.deploy?.startCommand,
                  raw: plan,
                  timestamp: new Date(),
                });
              } catch {
                // JSON not complete yet, keep accumulating
              }
            }
          }

          // Capture actual commit SHA emitted by build script (fallback for GitHub API failures)
          if (line.startsWith(COMMIT_SHA_PREFIX)) {
            const scrapedSha = line.substring(COMMIT_SHA_PREFIX.length).trim();
            if (scrapedSha && !headCommitSha) {
              headCommitSha = scrapedSha;
              this.appBuildsRepository
                .update(activeBuildId, { commitSha: scrapedSha })
                .catch(() => {});
              this.logger.log(
                `[BUILD] Captured commit SHA from build output: ${scrapedSha}`,
              );
            }
          }

          // Detect final image ref from build script
          if (line.startsWith(IMAGE_REF_PREFIX)) {
            finalImageRef = line.substring(IMAGE_REF_PREFIX.length).trim();
          }

          // Stream to WebSocket
          this.eventsGateway.emitBuildLog(applicationId, {
            appId: applicationId,
            buildId: activeBuildId,
            line,
            stream: 'stdout',
            timestamp: new Date(),
          });

          if (logBuffer.length < MAX_LOG_LINES) {
            logBuffer.push(line);
            // Flush to Postgres every LOG_FLUSH_INTERVAL lines
            if (logBuffer.length % LOG_FLUSH_INTERVAL === 0) {
              this.appBuildsRepository
                .update(activeBuildId, { logs: [...logBuffer] })
                .catch(() => {});
            }
          }
        }
      });

      // Wait for log stream to complete (container exits).
      // k8s.Log with follow:true can hang even after the container exits — race it
      // against a polling loop that detects container termination directly.
      const { coreApi } = this.kubernetesService.getKubeClient(kubeconfig);
      let buildExitCode: number | undefined;

      const logStreamDone = new Promise<void>((resolve, reject) => {
        logStream.once('error', reject);
        logStream.once('close', resolve);
        logApi
          .log(BUILD_NAMESPACE, podName, 'build', logStream, { follow: true })
          .catch(reject);
      });

      const containerExited = new Promise<void>((resolve) => {
        const poll = setInterval(async () => {
          try {
            const pod = await coreApi.readNamespacedPod({
              name: podName,
              namespace: BUILD_NAMESPACE,
            });
            const cs = pod.status?.containerStatuses?.find(
              (c) => c.name === 'build',
            );
            if (cs?.state?.terminated !== undefined) {
              buildExitCode = cs.state.terminated.exitCode;
              clearInterval(poll);
              // Brief delay to allow final log chunks to flush through the stream
              setTimeout(resolve, 2000);
            }
          } catch {
            /* transient API error — retry next tick */
          }
        }, 5000);
      });

      await Promise.race([logStreamDone, containerExited]);
      clearInterval(heartbeatInterval);
      logStream.destroy();

      // Persist buffered logs
      await this.appBuildsRepository.update(activeBuildId, { logs: logBuffer });

      // Verify build container exit code
      if (buildExitCode === undefined) {
        const podStatus = await coreApi.readNamespacedPod({
          name: podName,
          namespace: BUILD_NAMESPACE,
        });
        const cs = podStatus.status?.containerStatuses?.find(
          (c) => c.name === 'build',
        );
        buildExitCode = cs?.state?.terminated?.exitCode;
      }
      if (buildExitCode !== undefined && buildExitCode !== 0) {
        throw new Error(`Build container exited with code ${buildExitCode}`);
      }

      // ── Step 5: FINALIZE ──────────────────────────────────────────────────
      // waitForJobCompletion is not needed: exit code already verified above.
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        95,
        OperationStep.APP_BUILD_PUSHING,
      );
      await this.appBuildsRepository.updateStatus(
        activeBuildId,
        AppBuildStatus.PUSHING,
      );

      // ── Step 6: FINALIZE ──────────────────────────────────────────────────
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        95,
        OperationStep.APP_BUILD_FINALIZE,
      );

      const duration = Date.now() - startedAt;

      await this.appBuildsRepository.update(activeBuildId, {
        status: AppBuildStatus.COMPLETED,
        imageRef: finalImageRef,
        completedAt: new Date(),
      });

      if (!isStandalone) {
        const updatedSourceConfig: any = {
          ...sourceConfig,
          lastBuildJobId: activeBuildId,
        };
        if (detectedFramework)
          updatedSourceConfig.framework = detectedFramework;
        const appUpdate: Record<string, any> = {
          imageRef: finalImageRef,
          sourceConfig: updatedSourceConfig,
        };
        // Only write auto-detected start command if the user hasn't set a manual override
        if (detectedStartCommand && !app.startCommand) {
          appUpdate.startCommand = detectedStartCommand;
        }
        await this.applicationRepository.update(applicationId, appUpdate);

        // Persist detected framework back to the repository record for future builds
        if (sourceConfig?.repositoryId && (detectedFramework || detectedPort)) {
          this.repositoryRepository
            .update(sourceConfig.repositoryId, {
              detectedFramework,
              detectedFrontendFramework,
              detectedPort,
            })
            .catch((err) =>
              this.logger.warn(
                `Failed to update repository framework info: ${err.message}`,
              ),
            );
        }
      }

      await this.updateOperation(
        operationId,
        OperationStatus.COMPLETED,
        100,
        OperationStep.APP_BUILD_FINALIZE,
      );

      this.logger.log(
        `Build ${activeBuildId} completed for ${isStandalone ? 'standalone' : applicationId} in ${duration}ms. Image: ${finalImageRef}`,
      );

      // ── Cleanup K8s Job immediately (kills buildkitd sidecar) ────────────
      if (kubeconfig && jobName) {
        await this.buildJobService.deleteJob(
          kubeconfig,
          jobName,
          activeBuildId,
        );
      }

      // ── Trigger Path A deploy (only for app-linked builds) ───────────────
      let deployOperationId: string | undefined;
      if (!isStandalone) {
        const deployOperation =
          await this.applicationDeployService.triggerDeployWithImage(
            applicationId,
            finalImageRef,
            app.userId,
          );
        deployOperationId = deployOperation?.id;
      }

      this.eventsGateway.emitBuildCompleted(applicationId, {
        appId: applicationId,
        buildId: activeBuildId,
        imageRef: finalImageRef,
        duration,
        deployOperationId,
        timestamp: new Date(),
      });

      this.triggerCacheScanIfIdle(build.buildClusterId);
    } catch (error) {
      this.logger.error(
        `Build failed for application ${applicationId}: ${error.message}`,
        error.stack,
      );

      if (kubeconfig && jobName) {
        await this.buildJobService.deleteJob(
          kubeconfig,
          jobName,
          activeBuildId,
        );
      }

      if (activeBuildId) {
        await this.appBuildsRepository.updateStatus(
          activeBuildId,
          AppBuildStatus.FAILED,
          error.message,
        );
      }

      await this.updateOperation(
        operationId,
        OperationStatus.FAILED,
        undefined,
        undefined,
        error.message,
      );

      if (!isStandalone && applicationId) {
        await this.applicationRepository
          .update(applicationId, { status: ApplicationStatus.PENDING })
          .catch(() => {});
      }

      this.eventsGateway.emitBuildFailed(applicationId, {
        appId: applicationId,
        buildId: activeBuildId || 'unknown',
        operationId,
        error: error.message,
        attempt: job.attemptsMade + 1,
        timestamp: new Date(),
      });

      this.triggerCacheScanIfIdle(job.data.buildClusterId);
      throw error;
    }
  }

  /**
   * Trigger a background cache inspection if the build queue is now idle.
   * active <= 1 because the current job still counts as active until this handler returns.
   * No-op when the in-cluster build agent is disabled — nothing should be
   * allocated in flui-build in that case.
   */
  private triggerCacheScanIfIdle(clusterId: string): void {
    if (!clusterId) return;
    if (!this.buildAgentConfig.isInClusterBuildAgentEnabled()) return;
    Promise.all([
      this.buildQueue.getWaitingCount(),
      this.buildQueue.getActiveCount(),
    ])
      .then(([waiting, active]) => {
        if (waiting === 0 && active <= 1) {
          this.buildCacheInspectionService.triggerBackgroundScan(clusterId);
        }
      })
      .catch((err) =>
        this.logger.warn(`Cache scan check failed: ${err.message}`),
      );
  }

  /**
   * Correct known-broken start command patterns generated by railpack.
   * Returns the corrected command, or the original if no fix is needed.
   * Returns undefined if rawCmd is empty/null.
   */
  private correctStartCommand(rawCmd: string): string | undefined {
    if (!rawCmd) return undefined;

    // Java/Gradle: railpack generates `*/build/libs/*jar` expecting a multi-project subdir layout.
    // Single-project builds (most common) have the JAR directly at /app/build/libs/ — glob fails.
    // Replace with find-based discovery that works for both single and multi-project.
    if (/(?:\*\/)?build\/libs\/\*jar/.test(rawCmd)) {
      let fixed = rawCmd.replace(
        /\$\(ls -1[^)]*(?:\*\/)?build\/libs\/\*jar[^)]*\)/,
        '$(ls /app/build/libs/*.jar /app/*/build/libs/*.jar 2>/dev/null | grep -v plain | head -1)',
      );
      // Railpack also generates -jar BEFORE -D flags, but Java requires -D flags BEFORE -jar.
      // e.g. `java $JAVA_OPTS -jar -Dserver.port=$PORT <jarfile>` → wrong
      //      `java $JAVA_OPTS -Dserver.port=$PORT -jar <jarfile>` → correct
      fixed = fixed.replace(/(-jar)\s+(-D\S+)\s+/, '$2 $1 ');
      return fixed;
    }

    // Java/Maven: target/*.jar pattern — similar issue if project has submodules
    if (/target\/\*\.?jar/.test(rawCmd)) {
      let fixed = rawCmd.replace(
        /\$\(ls -1[^)]*target\/\*\.?jar[^)]*\)/,
        '$(ls /app/target/*.jar 2>/dev/null | grep -v plain | head -1)',
      );
      fixed = fixed.replace(/(-jar)\s+(-D\S+)\s+/, '$2 $1 ');
      return fixed;
    }

    return rawCmd; // pass through unchanged (Node, Python, Go, Ruby, etc.)
  }

  /** Infer a FrameworkType from a railpack plan, aligned with the framework detection system. */
  private detectFramework(plan: any): string {
    const steps: any[] = plan.steps ?? [];
    const startCmd: string = plan.deploy?.startCommand ?? '';
    const buildStep = steps.find((s) => s.name === 'build');
    const buildCmds: string[] =
      buildStep?.commands?.map((c: any) => c.cmd ?? '') ?? [];
    const allCmds: string[] = steps.flatMap((s: any) =>
      (s.commands ?? []).map((c: any) => c.cmd ?? ''),
    );
    const miseStep = steps.find((s) => s.name === 'packages:mise');
    const miseTml: string = miseStep?.assets?.['generated-mise-toml'] ?? '';
    this.logger.log(
      `[detectFramework] miseStep=${miseStep ? 'found' : 'NOT_FOUND'} miseTml=${JSON.stringify(miseTml.slice(0, 300))}`,
    );

    // Match only tool *definitions* (e.g. `node = "20"`) to avoid false positives
    // from mise settings sections like `[settings.node]` or idiomatic_version_file lists.
    const hasTool = (tool: string) =>
      new RegExp(String.raw`^\s*${tool}\s*=`, 'm').test(miseTml);
    const hasCmd = (pattern: RegExp) => allCmds.some((c) => pattern.test(c));
    const hasBuildCmd = (pattern: RegExp) =>
      buildCmds.some((c) => pattern.test(c));

    // Java → Spring Boot (only supported Java framework)
    if (hasTool('java')) return FrameworkType.SPRING_BOOT;

    // .NET → ASP.NET Core
    if (hasCmd(/dotnet\s+(publish|run|build)/))
      return FrameworkType.ASPNET_CORE;

    // Ruby → Rails
    if (
      hasTool('ruby') ||
      hasCmd(/bundle\s+exec/) ||
      startCmd.includes('rails')
    )
      return FrameworkType.RAILS;

    // PHP → Laravel
    if (
      hasCmd(/composer\s+install/) ||
      hasCmd(/php\s+artisan/) ||
      startCmd.includes('artisan')
    )
      return FrameworkType.LARAVEL;

    // Elixir → Phoenix
    if (
      hasTool('elixir') ||
      hasCmd(/mix\s+(deps|phx|compile)/) ||
      startCmd.includes('phx.server')
    )
      return FrameworkType.PHOENIX;

    // Go
    if (hasTool('go') || hasCmd(/go\s+build/)) return FrameworkType.GO;

    // Python — distinguish specific frameworks
    if (hasTool('python')) {
      if (hasCmd(/manage\.py/) || startCmd.includes('manage.py'))
        return FrameworkType.DJANGO;
      if (startCmd.includes('uvicorn') || hasCmd(/uvicorn/))
        return FrameworkType.FASTAPI;
      if (startCmd.includes('fh_run') || hasCmd(/fasthtml/))
        return FrameworkType.FASTHTML;
      if (startCmd.includes('flask') || hasCmd(/flask/))
        return FrameworkType.FLASK;
      return FrameworkType.GENERIC_PYTHON;
    }

    // Node.js — distinguish specific frameworks
    if (hasTool('node')) {
      if (startCmd.includes('caddy')) return FrameworkType.STATIC_HTML;
      if (hasBuildCmd(/next\s+build/) || startCmd.includes('next start'))
        return FrameworkType.NEXTJS;
      if (
        hasBuildCmd(/ng\s+build/) ||
        allCmds.some((c) => c.includes('.angular'))
      )
        return FrameworkType.ANGULAR;
      if (hasBuildCmd(/nuxt\s+(build|generate)/) || startCmd.includes('nuxt'))
        return FrameworkType.NUXT;
      if (hasBuildCmd(/remix\s+(build|vite:build)/)) return FrameworkType.REMIX;
      if (hasBuildCmd(/astro\s+build/)) return FrameworkType.ASTRO;
      if (hasBuildCmd(/react-router\s+build/))
        return FrameworkType.REACT_ROUTER;
      if (
        hasBuildCmd(/tanstack/) ||
        buildCmds.some((c) => c.includes('@tanstack/start'))
      )
        return FrameworkType.TANSTACK_START;
      if (
        hasBuildCmd(/svelte-kit\s+build/) ||
        buildCmds.some((c) => c.includes('sveltekit'))
      )
        return FrameworkType.SVELTE_KIT;
      if (hasBuildCmd(/nest\s+build/) || startCmd.includes('dist/main'))
        return FrameworkType.NESTJS;
      if (hasBuildCmd(/vite\s+build/)) {
        if (buildCmds.some((c) => c.includes('vue-tsc')))
          return FrameworkType.VUE_VITE;
        return FrameworkType.REACT_VITE;
      }
      if (startCmd.includes('express') || hasCmd(/express/))
        return FrameworkType.EXPRESS;
      return FrameworkType.GENERIC_NODE;
    }

    // Fallback: inspect install step commands
    const installCmds: string[] =
      steps
        .find((s) => s.name === 'install')
        ?.commands?.map((c: any) => c.cmd ?? '') ?? [];
    if (
      installCmds.some(
        (c) => c.includes('npm') || c.includes('yarn') || c.includes('pnpm'),
      )
    )
      return FrameworkType.GENERIC_NODE;
    if (installCmds.some((c) => c.includes('pip')))
      return FrameworkType.GENERIC_PYTHON;
    if (installCmds.some((c) => c.includes('bundle')))
      return FrameworkType.RAILS;

    return FrameworkType.UNKNOWN;
  }

  /** Detect the UI framework (Angular, React, Vue, etc.) from a railpack plan — display only, does not affect port. */
  private detectFrontendFramework(plan: any): string | undefined {
    const steps: any[] = plan.steps ?? [];

    // Angular: has .angular in exclude list or output dir ends with /browser
    const buildStep = steps.find((s) => s.name === 'build');
    const excludes: string[] =
      buildStep?.inputs?.flatMap((i: any) => i.exclude ?? []) ?? [];
    if (excludes.includes('.angular')) return 'Angular';

    const deployInputs: any[] = plan.deploy?.inputs ?? [];
    const outputDirs: string[] = deployInputs.flatMap(
      (i: any) => i.include ?? [],
    );
    if (outputDirs.some((d: string) => d.endsWith('/browser')))
      return 'Angular';

    // React / Vue: look for vite in build commands or output dir named 'dist'
    const buildCmds: string[] =
      buildStep?.commands?.map((c: any) => c.cmd ?? '') ?? [];
    if (
      buildCmds.some(
        (c) => c.includes('vite build') || c.includes('react-scripts build'),
      )
    )
      return 'React';
    if (buildCmds.some((c) => c.includes('vue-tsc') || c.includes('nuxt')))
      return 'Vue';

    // Nuxt
    const startCmd: string = plan.deploy?.startCommand ?? '';
    if (startCmd.includes('nuxt')) return 'Vue (Nuxt)';
    if (startCmd.includes('next')) return 'React (Next.js)';

    return undefined;
  }

  /** Extract the container port from a railpack plan, falling back to framework defaults. */
  private extractPort(plan: any, framework: string): number | undefined {
    const envPort = plan.deploy?.variables?.PORT;
    if (envPort) {
      const parsed = Number.parseInt(String(envPort), 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }

    if (plan.deploy?.port) {
      const parsed = Number.parseInt(String(plan.deploy.port), 10);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }

    const defaults: Record<string, number> = {
      // Node.js family
      [FrameworkType.NEXTJS]: 3000,
      [FrameworkType.NESTJS]: 3000,
      [FrameworkType.EXPRESS]: 3000,
      [FrameworkType.REMIX]: 3000,
      [FrameworkType.REACT_ROUTER]: 3000,
      [FrameworkType.NUXT]: 3000,
      [FrameworkType.ANGULAR]: 4200,
      [FrameworkType.SVELTE_KIT]: 3000,
      [FrameworkType.REACT_VITE]: 5173,
      [FrameworkType.VUE_VITE]: 5173,
      [FrameworkType.ASTRO]: 4321,
      [FrameworkType.TANSTACK_START]: 3000,
      [FrameworkType.GENERIC_NODE]: 3000,
      [FrameworkType.STATIC_HTML]: 80,
      // Python family
      [FrameworkType.DJANGO]: 8000,
      [FrameworkType.FASTAPI]: 8000,
      [FrameworkType.FLASK]: 5000,
      [FrameworkType.FASTHTML]: 5001,
      [FrameworkType.GENERIC_PYTHON]: 8000,
      // Java
      [FrameworkType.SPRING_BOOT]: 8080,
      // Ruby
      [FrameworkType.RAILS]: 3000,
      // PHP
      [FrameworkType.LARAVEL]: 8000,
      // .NET
      [FrameworkType.ASPNET_CORE]: 8080,
      // Elixir
      [FrameworkType.PHOENIX]: 4000,
      // Go
      [FrameworkType.GO]: 8080,
    };
    return defaults[framework];
  }

  /** Extract the build command from the railpack plan's build step. */
  private extractBuildCommand(plan: any): string | undefined {
    const buildStep = (plan.steps ?? []).find((s: any) => s.name === 'build');
    if (!buildStep) return undefined;
    const cmd = buildStep.commands?.find((c: any) => c.cmd)?.cmd;
    return cmd ?? undefined;
  }

  /**
   * Extract a suggested app name from project manifests (package.json, pyproject.toml, Cargo.toml).
   * Falls back to the repo slug if nothing is found.
   */
  private async extractSuggestedName(
    repoOwner: string,
    repoName: string,
    githubToken: string,
  ): Promise<string> {
    const octokit = new Octokit({ auth: githubToken });
    const getContent = async (path: string): Promise<string | null> => {
      try {
        const res = await octokit.repos.getContent({
          owner: repoOwner,
          repo: repoName,
          path,
        });
        return Buffer.from((res.data as any).content, 'base64').toString();
      } catch {
        return null;
      }
    };

    // package.json → name
    const pkg = await getContent('package.json');
    if (pkg) {
      try {
        const parsed = JSON.parse(pkg);
        if (parsed.name) return parsed.name;
      } catch {
        /* ignore */
      }
    }

    // pyproject.toml → [tool.poetry] name or [project] name
    const pyproject = await getContent('pyproject.toml');
    if (pyproject) {
      const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject);
      if (match) return match[1];
    }

    // Cargo.toml → [package] name
    const cargo = await getContent('Cargo.toml');
    if (cargo) {
      const match = /\[package\][\s\S]*?^name\s*=\s*["']([^"']+)["']/m.exec(
        cargo,
      );
      if (match) return match[1];
    }

    return repoName;
  }

  private async updateOperation(
    operationId: string,
    status: OperationStatus,
    progress?: number,
    step?: OperationStep,
    errorMessage?: string,
  ): Promise<void> {
    const update: Partial<InfrastructureOperationEntity> = { status };
    if (progress !== undefined) update.progress = progress;
    if (step !== undefined) update.currentStep = step;
    if (errorMessage) update.errorMessage = errorMessage;
    if (
      status === OperationStatus.COMPLETED ||
      status === OperationStatus.FAILED
    ) {
      update.completedAt = new Date();
    }
    if (status === OperationStatus.IN_PROGRESS && progress === 0) {
      update.startedAt = new Date();
    }
    await this.operationRepository.update(operationId, update);
  }
}
