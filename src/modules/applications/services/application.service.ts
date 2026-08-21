import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { validate as uuidValidate } from 'uuid';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { RepositoriesRepository } from '../../repositories/repositories/repositories.repository';
import { AppRevisionsRepository } from '../repositories/app-revisions.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { ApplicationEntity } from '../entities/application.entity';
import { AppRevisionEntity } from '../entities/app-revision.entity';
import { AppResourceEntity } from '../entities/app-resource.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { UpdateApplicationDto } from '../dto/update-application.dto';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationKind } from '../enums/application-kind.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import { ClusterDnsZoneService } from '../../dns/services/cluster-dns-zone.service';
import {
  AppEndpointService,
  PrimaryEndpointState,
} from '../../dns/services/app-endpoint.service';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { internalHostingNotAvailableException } from '../../dns/constants/internal-hosting-error';
import {
  ApplicationSourceConfig,
  ApplicationScaling,
  GitBuildSourceConfig,
  ApplicationEnvVar,
} from '../interfaces/source-config.interface';
import { AppEventType } from '../enums/app-event-type.enum';
import {
  ApplicationResponseDto,
  AppRevisionResponseDto,
  AppResourceResponseDto,
  AppAuditEventSummaryDto,
  ContainerDetailDto,
  AppOperationResponseDto,
} from '../dto/application-response.dto';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  KubernetesService,
  PodMetrics,
} from '../../infrastructure/shared/services/kubernetes.service';
import { ResourceProfilesService } from '../../images/services/resource-profiles.service';
import { buildUserNamespace } from '../utils/k8s-namespace.util';
import {
  assertNoClientNamespace,
  assertPlaceableNamespace,
} from '../utils/reserved-namespace.util';
import { InfrastructureOperationEntity } from '../../infrastructure/servers/entities/infrastructure-operations.entity';

@Injectable()
export class ApplicationService {
  private readonly logger = new Logger(ApplicationService.name);

  constructor(
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appRevisionsRepository: AppRevisionsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly encryptionService: EncryptionService,
    private readonly kubernetesService: KubernetesService,
    private readonly resourceProfilesService: ResourceProfilesService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @Inject(forwardRef(() => ClusterDnsZoneService))
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    @Inject(forwardRef(() => AppEndpointService))
    private readonly appEndpointService: AppEndpointService,
  ) {}

  /**
   * Gating predicate used by both create() and update() before persisting an
   * `exposure=internal` application. Throws the structured 400
   * INTERNAL_HOSTING_NOT_AVAILABLE if the cluster is not internal-ready.
   */
  private async assertInternalHostingReady(clusterId: string): Promise<void> {
    const status =
      await this.clusterDnsZoneService.getInternalHostingStatus(clusterId);
    if (!status.ready) {
      throw internalHostingNotAvailableException(clusterId, status.missing);
    }
  }

  async create(
    clusterId: string,
    dto: CreateApplicationDto,
    userId?: string,
    userEmail?: string,
  ): Promise<ApplicationEntity> {
    await this.validateSourceConfig(dto);

    // The DTO no longer declares k8sNamespace, but the validation pipe keeps
    // undeclared properties: the body can still carry one, and naming a
    // namespace names someone's tenancy.
    assertNoClientNamespace((dto as { k8sNamespace?: string }).k8sNamespace);
    const k8sNamespace = userEmail ? buildUserNamespace(userEmail) : 'default';
    assertPlaceableNamespace(k8sNamespace);

    if (dto.exposure === ApplicationExposure.INTERNAL) {
      await this.assertInternalHostingReady(clusterId);
    }

    const slug = dto.slug ?? (await this.generateUniqueSlug(dto.name));

    const envWithEncryptedSecrets = dto.env
      ? dto.env.map((e) => ({
          ...e,
          value:
            e.secret && !e.externalSecretRef
              ? this.encryptionService.encrypt(e.value)
              : e.value,
        }))
      : [];

    // Resource resolution priority:
    // 1. Raw resources in body (explicit override by advanced user)
    // 2. resourceProfile name → expand from JSON profiles
    // 3. Default profile ("small") from JSON
    const resolvedResources = this.resolveResources(dto);

    const entity = await this.applicationsRepository.create({
      name: dto.name,
      slug,
      description: dto.description,
      category: dto.category,
      kind:
        dto.kind ??
        (dto.category === ApplicationCategory.SYSTEM
          ? ApplicationKind.SYSTEM
          : ApplicationKind.APPLICATION),
      sourceType: dto.sourceType,
      clusterId,
      k8sNamespace,
      userId,
      sourceConfig: dto.sourceConfig as ApplicationSourceConfig,
      env: envWithEncryptedSecrets,
      resources: resolvedResources,
      scaling: dto.scaling || ({ enabled: false } as ApplicationScaling),
      replicas: dto.replicas ?? 1,
      port: dto.port,
      portProtocol: dto.portProtocol ?? null,
      configFiles: dto.configFiles ?? null,
      healthProbe: dto.healthProbe ?? null,
      volumes: dto.volumes ?? [],
      workloadKind: dto.workloadKind ?? 'Deployment',
      persistenceScope: dto.persistenceScope ?? 'shared',
      dedicatedNodeName: dto.dedicatedNodeName ?? null,
      allowMasterPlacement: dto.allowMasterPlacement ?? false,
      startCommand: dto.startCommand,
      command: dto.command ?? null,
      securityContext: dto.securityContext,
      labels: dto.labels || {},
      metadata: dto.metadata || {},
      systemProtected: dto.category === ApplicationCategory.SYSTEM,
      exposure: dto.exposure ?? ApplicationExposure.PUBLIC,
      deployOnPush: dto.deployOnPush ?? false,
    });

    this.logger.log(
      `Application created: ${entity.name} (${entity.id}) on cluster ${clusterId}`,
    );
    return entity;
  }

  /**
   * Validates `dto.sourceConfig` before persisting an application.
   * For `git_build`, ensures that `repositoryId` (when provided) is a real
   * Flui Repository UUID, not a GitHub `owner/repo` full_name. Without this,
   * downstream code (workflow generation, deploy) crashes with a Postgres
   * "invalid input syntax for type uuid" error.
   */
  private async validateSourceConfig(dto: CreateApplicationDto): Promise<void> {
    const sourceConfig = dto.sourceConfig as
      | { type?: string; repositoryId?: string }
      | undefined;
    if (sourceConfig?.type !== 'git_build') return;

    const repositoryId = sourceConfig.repositoryId;
    if (!repositoryId) return;

    if (!uuidValidate(repositoryId)) {
      throw new BadRequestException(
        `sourceConfig.repositoryId ("${repositoryId}") must be the UUID of a Flui Repository entity, ` +
          'not a GitHub "owner/repo" full_name. Register the repository first via POST /repositories ' +
          'and use the returned id.',
      );
    }

    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository) {
      throw new BadRequestException(
        `sourceConfig.repositoryId "${repositoryId}" does not match any registered Flui repository.`,
      );
    }
  }

  /**
   * Resolve CPU/memory resources for a new application.
   * Priority: `resourceProfile` (named profile) > raw `resources` > default profile ("small").
   * When a named profile is explicitly provided it always wins, even if raw resources are also sent.
   */
  private resolveResources(dto: CreateApplicationDto): {
    cpu: { request: string; limit: string };
    memory: { request: string; limit: string };
  } {
    // 1. Named profile explicitly provided — expand from JSON (highest priority)
    if (dto.resourceProfile) {
      const profile = this.resourceProfilesService.resolveResources(
        dto.resourceProfile,
      );
      return {
        cpu: { request: profile.cpu.request, limit: profile.cpu.limit },
        memory: {
          request: profile.memory.request,
          limit: profile.memory.limit,
        },
      };
    }

    // 2. Raw resources explicitly provided — use as-is (advanced user override, no profile selected)
    if (dto.resources?.cpu?.request || dto.resources?.memory?.request) {
      const defaultProfile = this.resourceProfilesService.resolveResources(
        this.resourceProfilesService.getDefaultProfileName(),
      );
      return {
        cpu: {
          request: dto.resources.cpu?.request ?? defaultProfile.cpu.request,
          limit: dto.resources.cpu?.limit ?? defaultProfile.cpu.limit,
        },
        memory: {
          request:
            dto.resources.memory?.request ?? defaultProfile.memory.request,
          limit: dto.resources.memory?.limit ?? defaultProfile.memory.limit,
        },
      };
    }

    // 3. Neither provided — fall back to default profile ("small")
    const profile = this.resourceProfilesService.resolveResources(
      this.resourceProfilesService.getDefaultProfileName(),
    );
    return {
      cpu: { request: profile.cpu.request, limit: profile.cpu.limit },
      memory: { request: profile.memory.request, limit: profile.memory.limit },
    };
  }

  async findById(id: string): Promise<ApplicationEntity> {
    const app = await this.applicationsRepository.findById(id);
    if (!app) {
      throw new NotFoundException(`Application ${id} not found`);
    }
    return app;
  }

  async findBySlug(slug: string): Promise<ApplicationEntity> {
    const app = await this.applicationsRepository.findBySlug(slug);
    if (!app) {
      throw new NotFoundException(`Application with slug ${slug} not found`);
    }
    return app;
  }

  async findByClusterId(
    clusterId: string,
    filters?: {
      category?: ApplicationCategory;
      kind?: ApplicationKind;
      status?: ApplicationStatus;
    },
  ): Promise<ApplicationEntity[]> {
    return this.applicationsRepository.findByClusterId(clusterId, filters);
  }

  /**
   * Carry the monorepo subPath across a wholesale sourceConfig replacement: a
   * client PATCHing sourceConfig without it must not silently un-monorepo the app
   * and break its image ref (`{repo}/{subPath}` → bare `{repo}`).
   */
  private preserveMonorepoSubPath(
    incoming: ApplicationSourceConfig,
    current: ApplicationSourceConfig | undefined,
  ): ApplicationSourceConfig {
    const incomingGit = incoming as GitBuildSourceConfig;
    const existing = current as GitBuildSourceConfig | undefined;
    if (
      incomingGit?.type === 'git_build' &&
      incomingGit.subPath === undefined &&
      existing?.type === 'git_build' &&
      existing.subPath
    ) {
      incomingGit.subPath = existing.subPath;
    }
    return incoming;
  }

  private static readonly SECRET_MASK = '********';

  /**
   * Resolve one PATCHed env entry against what's stored. Dashboard reads mask
   * secrets as `********` and drop `externalSecretRef`; a naive write would then
   * encrypt the mask (destroying the secret) or turn a building-block link into a
   * plain value. So: preserve a stored ref/secret when the client sends it back
   * stripped or masked; encrypt only genuinely new secret values; tag as `user`.
   */
  private resolvePatchEnvVar(
    incoming: ApplicationEnvVar,
    existingByName: Map<string, ApplicationEnvVar>,
  ): ApplicationEnvVar {
    const prev = existingByName.get(incoming.name);
    const masked =
      incoming.value === undefined ||
      incoming.value === '' ||
      incoming.value === ApplicationService.SECRET_MASK;
    if (prev?.externalSecretRef && !incoming.externalSecretRef && masked) {
      return prev;
    }
    const tagged: ApplicationEnvVar = {
      ...incoming,
      source: incoming.source ?? 'user',
    };
    if (tagged.externalSecretRef) return tagged;
    // A key still waiting for a person stays waiting. The editor sends back the
    // mask (or nothing) for a secret it never held, and without this the flag
    // would be dropped on the next save — turning a declared "no value yet"
    // into a configured empty secret nobody chose.
    if (prev?.pending && masked) {
      return { ...tagged, secret: true, value: '', pending: true };
    }
    if (tagged.secret && incoming.value === ApplicationService.SECRET_MASK) {
      return { ...tagged, value: prev?.value ?? '' };
    }
    if (tagged.secret) {
      return { ...tagged, value: this.encryptionService.encrypt(tagged.value) };
    }
    return tagged;
  }

  async update(
    id: string,
    dto: UpdateApplicationDto,
  ): Promise<ApplicationEntity> {
    const app = await this.findById(id);

    if (
      dto.exposure === ApplicationExposure.INTERNAL &&
      app.exposure !== ApplicationExposure.INTERNAL
    ) {
      await this.assertInternalHostingReady(app.clusterId);
    }

    const updateData: Partial<ApplicationEntity> = {};

    if (dto.name !== undefined) updateData.name = dto.name;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.sourceConfig !== undefined)
      updateData.sourceConfig = this.preserveMonorepoSubPath(
        dto.sourceConfig as ApplicationSourceConfig,
        app.sourceConfig,
      );
    if (dto.resources !== undefined) updateData.resources = dto.resources;
    if (dto.scaling !== undefined)
      updateData.scaling = dto.scaling as ApplicationScaling;
    if (dto.replicas !== undefined) updateData.replicas = dto.replicas;
    if (dto.port !== undefined) updateData.port = dto.port;
    if (dto.startCommand !== undefined)
      updateData.startCommand = dto.startCommand ?? null;
    if (dto.labels !== undefined) updateData.labels = dto.labels;
    if (dto.tags !== undefined) updateData.tags = dto.tags;
    if (dto.metadata !== undefined) updateData.metadata = dto.metadata;
    if (dto.exposure !== undefined) updateData.exposure = dto.exposure;
    if (dto.deployOnPush !== undefined)
      updateData.deployOnPush = dto.deployOnPush;

    if (dto.env !== undefined) {
      const existingByName = new Map(
        ((app.env as ApplicationEnvVar[] | undefined) ?? []).map((e) => [
          e.name,
          e,
        ]),
      );
      updateData.env = (dto.env as ApplicationEnvVar[]).map((e) =>
        this.resolvePatchEnvVar(e, existingByName),
      );
    }

    return this.applicationsRepository.update(id, updateData);
  }

  async delete(id: string): Promise<void> {
    const app = await this.findById(id);

    if (app.systemProtected) {
      throw new BadRequestException(
        `Cannot delete system-protected application: ${app.name}`,
      );
    }

    await this.applicationsRepository.updateStatus(
      id,
      ApplicationStatus.DELETING,
    );
    this.logger.log(`Application marked for deletion: ${app.name} (${id})`);
  }

  async softDelete(id: string): Promise<void> {
    await this.applicationsRepository.softDelete(id);
  }

  async updateStatus(id: string, status: ApplicationStatus): Promise<void> {
    await this.applicationsRepository.updateStatus(id, status);
  }

  async getRevisions(applicationId: string): Promise<AppRevisionEntity[]> {
    await this.findById(applicationId);
    return this.appRevisionsRepository.findDeployRevisions(applicationId);
  }

  async getRevisionById(
    applicationId: string,
    revisionId: string,
  ): Promise<AppRevisionEntity> {
    await this.findById(applicationId);
    const revision = await this.appRevisionsRepository.findById(revisionId);
    if (revision?.applicationId !== applicationId) {
      throw new NotFoundException(`Revision ${revisionId} not found`);
    }
    return revision;
  }

  async getAuditEvents(
    applicationId: string,
    options?: { eventType?: AppEventType; limit?: number; offset?: number },
  ): Promise<{ events: AppRevisionEntity[]; total: number }> {
    await this.findById(applicationId);
    return this.appRevisionsRepository.findAllEvents(applicationId, options);
  }

  async getResources(applicationId: string): Promise<AppResourceEntity[]> {
    await this.findById(applicationId);
    return this.appResourcesRepository.findByApplicationId(applicationId);
  }

  /**
   * Get resources enriched with live K8s data: container specs (requests/limits),
   * replica counts, and current CPU/memory usage from metrics-server.
   */
  async getResourcesLive(
    applicationId: string,
  ): Promise<AppResourceResponseDto[]> {
    const app = await this.findById(applicationId);
    const resources =
      await this.appResourcesRepository.findByApplicationId(applicationId);

    const cluster = await this.clusterRepository.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      return resources.map((r) => this.toResourceResponseDto(r));
    }

    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    // Collect all namespaces with workload resources for metrics
    const workloadKinds = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
    const namespacesWithWorkloads = new Set<string>();
    for (const r of resources) {
      if (workloadKinds.has(r.kind)) {
        namespacesWithWorkloads.add(r.namespace);
      }
    }

    // Fetch pod metrics per namespace
    const metricsByNamespace = new Map<string, PodMetrics[]>();
    for (const ns of namespacesWithWorkloads) {
      const metrics = await this.kubernetesService.getPodMetrics(
        kubeconfig,
        ns,
      );
      metricsByNamespace.set(ns, metrics);
    }

    const dtos: AppResourceResponseDto[] = [];

    for (const resource of resources) {
      const dto = this.toResourceResponseDto(resource);

      if (workloadKinds.has(resource.kind)) {
        const detail = await this.kubernetesService.getResourceDetail(
          kubeconfig,
          resource.kind,
          resource.name,
          resource.namespace,
        );

        if (detail) {
          dto.replicas = detail.replicas;

          // Get app label for matching pods to metrics
          const k8sResource = await this.kubernetesService.getResource(
            kubeconfig,
            resource.kind,
            resource.name,
            resource.namespace,
          );
          const matchLabels = k8sResource?.spec?.selector?.matchLabels || {};
          const nsMetrics = metricsByNamespace.get(resource.namespace) || [];

          // Aggregate usage across pods per container name
          const usageByContainer = this.aggregatePodMetrics(
            nsMetrics,
            matchLabels,
            kubeconfig,
            resource.namespace,
          );

          dto.containers = detail.containers.map((c) => {
            const containerDto: ContainerDetailDto = {
              name: c.name,
              image: c.image,
              requests: {
                cpu: c.requests.cpu || undefined,
                memory: c.requests.memory || undefined,
              },
              limits: {
                cpu: c.limits.cpu || undefined,
                memory: c.limits.memory || undefined,
              },
            };
            const usage = usageByContainer.get(c.name);
            if (usage) {
              containerDto.usage = usage;
            }
            return containerDto;
          });
        }
      }

      dtos.push(dto);
    }

    return dtos;
  }

  /**
   * Aggregate metrics across all pods that match the selector labels.
   * Returns summed CPU/memory usage per container name.
   */
  private aggregatePodMetrics(
    podMetrics: PodMetrics[],
    matchLabels: Record<string, string>,
    _kubeconfig: string,
    _namespace: string,
  ): Map<string, { cpu: string; memory: string }> {
    const result = new Map<string, { cpuNano: number; memoryBytes: number }>();

    // podMetrics already filtered by namespace; we match by pod name prefix
    // (K8s generates pod names from deployment name, e.g. flui-web-xxxxx-yyy)
    // We use all available pods since getPodMetrics already returns for the namespace
    const appLabel =
      matchLabels['app'] || matchLabels['app.kubernetes.io/name'] || '';

    for (const pod of podMetrics) {
      // Simple heuristic: pod name starts with the app label
      if (appLabel && !pod.name.startsWith(appLabel)) continue;

      for (const container of pod.containers) {
        const existing = result.get(container.name) || {
          cpuNano: 0,
          memoryBytes: 0,
        };
        existing.cpuNano += this.parseCpuToNano(container.usage.cpu);
        existing.memoryBytes += this.parseMemoryToBytes(container.usage.memory);
        result.set(container.name, existing);
      }
    }

    const formatted = new Map<string, { cpu: string; memory: string }>();
    for (const [name, val] of result) {
      formatted.set(name, {
        cpu: this.formatNanoToCpu(val.cpuNano),
        memory: this.formatBytesToMemory(val.memoryBytes),
      });
    }
    return formatted;
  }

  private parseCpuToNano(cpu: string): number {
    if (!cpu) return 0;
    if (cpu.endsWith('n')) return Number.parseInt(cpu.slice(0, -1), 10) || 0;
    if (cpu.endsWith('u'))
      return (Number.parseInt(cpu.slice(0, -1), 10) || 0) * 1000;
    if (cpu.endsWith('m'))
      return (Number.parseInt(cpu.slice(0, -1), 10) || 0) * 1_000_000;
    return (Number.parseFloat(cpu) || 0) * 1_000_000_000;
  }

  private parseMemoryToBytes(memory: string): number {
    if (!memory) return 0;
    const units: Record<string, number> = {
      Ki: 1024,
      Mi: 1024 ** 2,
      Gi: 1024 ** 3,
      Ti: 1024 ** 4,
      K: 1000,
      M: 1000 ** 2,
      G: 1000 ** 3,
    };
    for (const [suffix, multiplier] of Object.entries(units)) {
      if (memory.endsWith(suffix)) {
        return (
          (Number.parseInt(memory.slice(0, -suffix.length), 10) || 0) *
          multiplier
        );
      }
    }
    return Number.parseInt(memory, 10) || 0;
  }

  private formatNanoToCpu(nano: number): string {
    if (nano >= 1_000_000_000) return `${(nano / 1_000_000_000).toFixed(1)}`;
    return `${Math.round(nano / 1_000_000)}m`;
  }

  private formatBytesToMemory(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}Gi`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}Mi`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}Ki`;
    return `${bytes}`;
  }

  async getLastOperation(
    applicationId: string,
  ): Promise<InfrastructureOperationEntity | null> {
    return this.operationRepository.findOne({
      where: { resourceId: applicationId },
      order: { createdAt: 'DESC' },
    });
  }

  async getOperations(
    applicationId: string,
    limit = 20,
    offset = 0,
  ): Promise<{ items: InfrastructureOperationEntity[]; total: number }> {
    const [items, total] = await this.operationRepository.findAndCount({
      where: { resourceId: applicationId },
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  private extractDigestFromImageRef(
    imageRef: string | null | undefined,
  ): string | null {
    if (!imageRef) return null;
    const at = imageRef.lastIndexOf('@');
    if (at < 0) return null;
    const rest = imageRef.slice(at + 1);
    return /^sha256:[0-9a-f]{64}$/.test(rest) ? rest : null;
  }

  toOperationDto(op: InfrastructureOperationEntity): AppOperationResponseDto {
    const dto = new AppOperationResponseDto();
    dto.id = op.id;
    dto.operationType = op.operationType;
    dto.status = op.status;
    dto.progress = op.progress;
    dto.currentStep = op.currentStep;
    dto.currentStepIndex = op.currentStepIndex;
    dto.totalSteps = op.totalSteps;
    dto.errorMessage = op.errorMessage;
    dto.imageRef = op.metadata?.imageRef;
    dto.digest =
      op.metadata?.digest ??
      this.extractDigestFromImageRef(op.metadata?.imageRef);
    dto.startedAt = op.startedAt;
    dto.completedAt = op.completedAt;
    dto.createdAt = op.createdAt;
    return dto;
  }

  toResponseDto(entity: ApplicationEntity): ApplicationResponseDto {
    const dto = new ApplicationResponseDto();
    dto.id = entity.id;
    dto.name = entity.name;
    dto.slug = entity.slug;
    dto.description = entity.description;
    dto.category = entity.category;
    dto.kind = entity.kind ?? ApplicationKind.APPLICATION;
    dto.sourceType = entity.sourceType;
    dto.clusterId = entity.clusterId;
    dto.projectId = entity.projectId ?? null;
    dto.k8sNamespace = entity.k8sNamespace;
    dto.status = entity.status;
    dto.reconciliationStatus = entity.reconciliationStatus;
    dto.lastReconciliationAt = entity.lastReconciliationAt;
    dto.reconciliationError = entity.reconciliationError;
    dto.sourceConfig = entity.sourceConfig;
    dto.env =
      entity.env?.map((e) => ({
        name: e.name,
        value: e.secret ? ApplicationService.SECRET_MASK : e.value,
        secret: e.secret,
        ...(e.pending ? { pending: true } : {}),
        ...(e.externalSecretRef
          ? { externalSecretRef: e.externalSecretRef }
          : {}),
        ...(e.source ? { source: e.source } : {}),
      })) || [];
    dto.resources = entity.resources;
    dto.scaling = entity.scaling;
    dto.replicas = entity.replicas;
    dto.port = entity.port;
    dto.currentRevisionId = entity.currentRevisionId;
    dto.imageRef = entity.imageRef;
    dto.startCommand = entity.startCommand ?? null;
    dto.userId = entity.userId;
    dto.systemProtected = entity.systemProtected;
    dto.autoDeploy = entity.autoDeploy ?? false;
    dto.deployOnPush = entity.deployOnPush ?? false;
    dto.exposure = entity.exposure ?? ApplicationExposure.PUBLIC;
    dto.activeRevisionId = entity.currentRevisionId ?? null;
    dto.workloadKind = entity.workloadKind ?? 'Deployment';
    dto.persistenceScope = entity.persistenceScope ?? 'shared';
    dto.dedicatedNodeName = entity.dedicatedNodeName ?? null;
    dto.allowMasterPlacement = entity.allowMasterPlacement ?? false;
    dto.labels = entity.labels;
    dto.metadata = entity.metadata;
    dto.buildPath = entity.buildPath;
    dto.frameworkConfirmed = entity.frameworkConfirmed;
    dto.workflowRunId = entity.workflowRunId;
    dto.workflowRunUrl = entity.workflowRunUrl;
    dto.buildStartedAt = entity.buildStartedAt;
    dto.lastBuildStatus = entity.lastBuildStatus;
    dto.lastBuildConclusion = entity.lastBuildConclusion;
    dto.lastDeployedAt = entity.lastDeployedAt;
    // Surface catalog provenance so the FE can cross-reference a running
    // app with its catalog entry without parsing sourceConfig. Populated by
    // the catalog install processor via labels[flui.cloud/catalog-app] and
    // metadata.{catalogInstallId,catalogVersion}; undefined for apps created
    // outside the catalog.
    dto.catalogSlug = entity.labels?.['flui.cloud/catalog-app'];
    dto.catalogInstallId = entity.metadata?.catalogInstallId;
    dto.catalogVersion = entity.metadata?.catalogVersion;
    dto.createdAt = entity.createdAt;
    dto.updatedAt = entity.updatedAt;
    return dto;
  }

  async toResponseDtoWithOperation(
    entity: ApplicationEntity,
  ): Promise<ApplicationResponseDto> {
    const dto = this.toResponseDto(entity);
    const lastOp = await this.getLastOperation(entity.id);
    if (lastOp) {
      dto.lastOperation = this.toOperationDto(lastOp);
    }
    if (entity.exposure === ApplicationExposure.INTERNAL) {
      dto.internalUrl = await this.computeInternalUrl(entity);
    } else {
      const endpoints = await this.appEndpointService.listByApplicationId(
        entity.id,
      );
      const primary = endpoints.find((e) => e.fqdn);
      this.applyPublicEndpoint(
        dto,
        entity,
        primary && {
          fqdn: primary.fqdn,
          reconciliationStatus: primary.reconciliationStatus,
          errorMessage: primary.errorMessage ?? null,
        },
      );
    }
    return dto;
  }

  /**
   * Build the authoritative public access URL from an endpoint hostname. The path
   * comes from the app's catalog `entrypointPath` (default "/"), mirroring how the
   * dashboard and catalog compose "Open app" links — callers must never guess it.
   */
  private publicUrlFromFqdn(entity: ApplicationEntity, fqdn: string): string {
    return `https://${fqdn}${entity.metadata?.entrypointPath ?? '/'}`;
  }

  /** Of the candidate hostnames, those that are a real app endpoint fqdn. */
  filterKnownEndpointHosts(hosts: string[]): Promise<string[]> {
    return this.appEndpointService.existingFqdns(hosts);
  }

  /**
   * Map a list of applications to response DTOs with each app's real access URL
   * attached: public apps get `url` from their endpoint fqdn (one batched query),
   * internal apps get `internalUrl` resolving each cluster's internal zone once. So
   * every exposure mode carries a real, citable endpoint — no per-app N+1.
   */
  async toResponseDtosWithUrls(
    entities: ApplicationEntity[],
  ): Promise<ApplicationResponseDto[]> {
    const dtos = entities.map((e) => this.toResponseDto(e));
    const isInternal = (e: ApplicationEntity) =>
      (e.exposure ?? ApplicationExposure.PUBLIC) ===
      ApplicationExposure.INTERNAL;

    const publicIds = entities.filter((e) => !isInternal(e)).map((e) => e.id);
    const endpoints =
      await this.appEndpointService.mapPrimaryEndpoints(publicIds);

    const internalClusterIds = [
      ...new Set(entities.filter(isInternal).map((e) => e.clusterId)),
    ];
    const zoneByCluster = new Map<string, string | undefined>();
    await Promise.all(
      internalClusterIds.map(async (clusterId) => {
        const status =
          await this.clusterDnsZoneService.getInternalHostingStatus(clusterId);
        zoneByCluster.set(
          clusterId,
          status.ready ? status.zoneName : undefined,
        );
      }),
    );

    entities.forEach((entity, i) => {
      if (isInternal(entity)) {
        const zone = zoneByCluster.get(entity.clusterId);
        if (zone) dtos[i].internalUrl = this.internalUrlFromZone(entity, zone);
        return;
      }
      this.applyPublicEndpoint(dtos[i], entity, endpoints.get(entity.id));
    });
    return dtos;
  }

  /**
   * Attach the public URL and the endpoint's own state to a DTO.
   *
   * The URL is withheld until the endpoint actually reconciled. A hostname is
   * written when the endpoint row is created, minutes before an Ingress or a DNS
   * record exists — and if reconciliation then fails, that hostname resolves
   * nowhere forever. `endpointStatus` travels with it so a caller can say why:
   * an absent URL plus a reason beats a link that does not work.
   */
  private applyPublicEndpoint(
    dto: ApplicationResponseDto,
    entity: ApplicationEntity,
    endpoint?: PrimaryEndpointState,
  ): void {
    if (!endpoint) return;
    dto.endpointStatus = endpoint.reconciliationStatus;
    dto.endpointError = endpoint.errorMessage ?? undefined;
    if (endpoint.reconciliationStatus === ReconciliationStatus.IN_SYNC) {
      dto.url = this.publicUrlFromFqdn(entity, endpoint.fqdn);
    }
  }

  /** `https://<slug>.internal.<zoneName><entrypointPath>` — the internal "Open" URL. */
  private internalUrlFromZone(
    entity: ApplicationEntity,
    zoneName: string,
  ): string {
    return `https://${entity.slug}.internal.${zoneName}${entity.metadata?.entrypointPath ?? '/'}`;
  }

  /**
   * Composes the public-facing URL the dashboard uses for the "Open" button
   * on internal apps. Returns undefined when the cluster is not internal-ready.
   */
  private async computeInternalUrl(
    entity: ApplicationEntity,
  ): Promise<string | undefined> {
    const status = await this.clusterDnsZoneService.getInternalHostingStatus(
      entity.clusterId,
    );
    if (!status.ready || !status.zoneName) return undefined;
    return this.internalUrlFromZone(entity, status.zoneName);
  }

  toRevisionResponseDto(entity: AppRevisionEntity): AppRevisionResponseDto {
    const dto = new AppRevisionResponseDto();
    dto.id = entity.id;
    dto.eventType = entity.eventType;
    dto.actor = entity.actor ?? undefined;
    dto.changeMetadata = entity.changeMetadata ?? {};
    dto.revisionNumber = entity.revisionNumber ?? undefined;
    dto.imageRef = entity.imageRef;
    dto.commitSha = entity.commitSha;
    dto.chartVersion = entity.chartVersion;
    dto.resourcesSnapshot = entity.resourcesSnapshot ?? undefined;
    dto.envKeys = entity.envSnapshot?.map((e) => e.name) ?? [];
    dto.replicas = entity.replicas ?? undefined;
    dto.status = entity.status;
    dto.errorMessage = entity.errorMessage;
    dto.deployedBy = entity.deployedBy;
    dto.operationId = entity.operationId;
    dto.buildId = entity.buildId ?? null;
    dto.rollbackReason = entity.rollbackReason;
    dto.createdAt = entity.createdAt;
    return dto;
  }

  toAuditEventSummaryDto(entity: AppRevisionEntity): AppAuditEventSummaryDto {
    const dto = new AppAuditEventSummaryDto();
    dto.id = entity.id;
    dto.eventType = entity.eventType;
    dto.actor = entity.actor ?? undefined;
    dto.changeMetadata = entity.changeMetadata ?? {};
    dto.revisionNumber = entity.revisionNumber ?? undefined;
    dto.imageRef = entity.imageRef;
    dto.createdAt = entity.createdAt;
    return dto;
  }

  toResourceResponseDto(entity: AppResourceEntity): AppResourceResponseDto {
    const dto = new AppResourceResponseDto();
    dto.id = entity.id;
    dto.kind = entity.kind;
    dto.name = entity.name;
    dto.namespace = entity.namespace;
    dto.apiVersion = entity.apiVersion;
    dto.status = entity.status;
    dto.reconciliationStatus = entity.reconciliationStatus;
    dto.lastObservedAt = entity.lastObservedAt;
    dto.errorMessage = entity.errorMessage;
    dto.metadata = entity.metadata;
    dto.createdAt = entity.createdAt;
    dto.updatedAt = entity.updatedAt;
    return dto;
  }

  private async generateUniqueSlug(name: string): Promise<string> {
    const base = name
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-|-$/g, '');
    const shortId = Math.random().toString(36).substring(2, 8);
    const slug = `${base}-${shortId}`;

    const exists = await this.applicationsRepository.existsBySlug(slug);
    if (exists) {
      return this.generateUniqueSlug(name);
    }
    return slug;
  }
}
