import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppRevisionsRepository } from '../repositories/app-revisions.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationResources } from '../interfaces/source-config.interface';
import { AppEventType, AppEventActorType } from '../enums/app-event-type.enum';
import { ApplicationStatus } from '../enums/application-status.enum';
import {
  AppRuntimeResponseDto,
  ContainerRuntimeDetailDto,
  ContainerResourcesDto,
  UpdateResourcesDto,
  UpdateReplicasDto,
} from '../dto/app-management.dto';
import { ApplicationEventsGateway } from '../gateway/application-events.gateway';
import { RolloutSection } from '../dto/application-events.dto';
import { AppOperationRunner } from './app-operation-runner.service';
import { OperationType } from '../../infrastructure/servers/entities/infrastructure-operations.entity';

/** Rollout poll interval (ms) */
const ROLLOUT_POLL_INTERVAL_MS = 3000;
/** Maximum time to wait for a rollout to complete (ms) */
const ROLLOUT_TIMEOUT_MS = 5 * 60 * 1000;

@Injectable()
export class AppManagementService {
  private readonly logger = new Logger(AppManagementService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appRevisionsRepository: AppRevisionsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly gateway: ApplicationEventsGateway,
    private readonly runner: AppOperationRunner,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async getRuntimeStatus(appId: string): Promise<AppRuntimeResponseDto> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    return this.buildRuntimeResponse(app, kubeconfig);
  }

  async updateResources(
    appId: string,
    dto: UpdateResourcesDto,
  ): Promise<AppRuntimeResponseDto> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const {
      kind,
      name: deploymentName,
      resource: deployment,
    } = await this.getWorkloadOrThrow(app, kubeconfig);

    const containers: any[] = deployment.spec?.template?.spec?.containers ?? [];

    const targetIndex = dto.containerName
      ? containers.findIndex((c) => c.name === dto.containerName)
      : 0;

    if (targetIndex === -1) {
      throw new NotFoundException(
        `Container "${dto.containerName}" not found in deployment "${deploymentName}"`,
      );
    }
    if (containers.length === 0) {
      throw new UnprocessableEntityException(
        `Deployment "${deploymentName}" has no containers`,
      );
    }

    const container = containers[targetIndex];
    container.resources = container.resources ?? {};

    if (dto.requests) {
      container.resources.requests = {
        ...container.resources.requests,
        ...(dto.requests.cpu !== undefined && { cpu: dto.requests.cpu }),
        ...(dto.requests.memory !== undefined && {
          memory: dto.requests.memory,
        }),
      };
    }

    if (dto.limits) {
      container.resources.limits = {
        ...container.resources.limits,
        ...(dto.limits.cpu !== undefined && { cpu: dto.limits.cpu }),
        ...(dto.limits.memory !== undefined && { memory: dto.limits.memory }),
      };
    }

    // Capture before state for audit
    const beforeResources = app.resources;

    await this.kubernetesService.patchWorkloadContainerResources(
      kubeconfig,
      kind,
      app.k8sNamespace,
      deploymentName,
      container.name,
      container.resources,
    );
    this.logger.log(
      `Updated resources for container "${container.name}" in ${kind} "${deploymentName}"`,
    );

    // Sync DB entity so the stored resources reflect the live state
    const merged = this.buildEntityResources(dto, app.resources);
    await this.applicationsRepository.update(appId, { resources: merged });

    // Audit event
    await this.appRevisionsRepository.createAuditEvent({
      applicationId: appId,
      eventType: AppEventType.RESOURCE_UPDATE,
      actor: { type: AppEventActorType.API },
      changeMetadata: {
        before: beforeResources ?? {},
        after: merged,
        containerName: dto.containerName ?? null,
      },
    });

    // Fire-and-forget: track the rollout until all pods are ready
    this.watchRollout(
      app,
      kubeconfig,
      'update-resources',
      RolloutSection.RESOURCES,
      true,
    );

    return this.buildRuntimeResponse(app, kubeconfig);
  }

  async applyReplicas(
    appId: string,
    replicas: number,
  ): Promise<{ app: ApplicationEntity; kubeconfig: string; previous: number }> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const { kind, name: deploymentName } = await this.getWorkloadOrThrow(
      app,
      kubeconfig,
    );

    const previous = app.replicas;

    await this.kubernetesService.scaleWorkload(
      kubeconfig,
      kind,
      app.k8sNamespace,
      deploymentName,
      replicas,
    );
    this.logger.log(
      `Scaled ${kind} "${deploymentName}" to ${replicas} replica(s)`,
    );

    await this.applicationsRepository.update(appId, { replicas });

    return { app, kubeconfig, previous };
  }

  async updateReplicas(
    appId: string,
    dto: UpdateReplicasDto,
  ): Promise<AppRuntimeResponseDto> {
    const {
      app,
      kubeconfig,
      previous: previousReplicas,
    } = await this.applyReplicas(appId, dto.replicas);

    // Audit event
    await this.appRevisionsRepository.createAuditEvent({
      applicationId: appId,
      eventType: AppEventType.SCALE,
      actor: { type: AppEventActorType.API },
      changeMetadata: {
        before: { replicas: previousReplicas },
        after: { replicas: dto.replicas },
      },
    });

    this.watchRollout(app, kubeconfig, 'scale', RolloutSection.REPLICAS, false);

    return this.buildRuntimeResponse(app, kubeconfig);
  }

  async restartDeployment(appId: string): Promise<AppRuntimeResponseDto> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);
    const { kind, name: deploymentName } = await this.getWorkloadOrThrow(
      app,
      kubeconfig,
    );

    const restartedAt = new Date().toISOString();
    await this.kubernetesService.restartWorkload(
      kubeconfig,
      kind,
      app.k8sNamespace,
      deploymentName,
    );
    this.logger.log(
      `Triggered rolling restart for ${kind} "${deploymentName}"`,
    );

    // Audit event
    await this.appRevisionsRepository.createAuditEvent({
      applicationId: appId,
      eventType: AppEventType.RESTART,
      actor: { type: AppEventActorType.API },
      changeMetadata: { triggeredAt: restartedAt },
    });

    // Fire-and-forget: track the rollout until all pods have restarted
    this.watchRollout(app, kubeconfig, 'restart', RolloutSection.PODS, true);

    return this.buildRuntimeResponse(app, kubeconfig);
  }

  /** Stop an application: scale to 0 replicas and mark it STOPPED. */
  async stop(appId: string): Promise<AppRuntimeResponseDto> {
    const current = await this.applicationsRepository.findById(appId);
    if (!current) {
      throw new NotFoundException(`Application ${appId} not found`);
    }
    const { app, kubeconfig } = await this.applyReplicas(appId, 0);
    await this.applicationsRepository.updateStatus(
      appId,
      ApplicationStatus.STOPPED,
    );
    await this.appRevisionsRepository.createAuditEvent({
      applicationId: appId,
      eventType: AppEventType.STOP,
      actor: { type: AppEventActorType.API },
      changeMetadata: { previousReplicas: current.replicas },
    });
    return this.buildRuntimeResponse(app, kubeconfig);
  }

  /** Start a stopped application: restore its replicas (>=1) and mark it RUNNING. */
  async start(appId: string): Promise<AppRuntimeResponseDto> {
    const current = await this.applicationsRepository.findById(appId);
    if (!current) {
      throw new NotFoundException(`Application ${appId} not found`);
    }
    const replicas = current.replicas > 0 ? current.replicas : 1;
    const { app, kubeconfig } = await this.applyReplicas(appId, replicas);
    await this.applicationsRepository.updateStatus(
      appId,
      ApplicationStatus.RUNNING,
    );
    await this.appRevisionsRepository.createAuditEvent({
      applicationId: appId,
      eventType: AppEventType.START,
      actor: { type: AppEventActorType.API },
      changeMetadata: { restoredReplicas: replicas },
    });
    return this.buildRuntimeResponse(app, kubeconfig);
  }

  async swapVolumeClaim(
    appId: string,
    volumeName: string,
    newClaimName: string,
    userId?: string,
  ): Promise<AppRuntimeResponseDto & { operationId: string }> {
    const { app, kubeconfig } = await this.resolveAppAndKubeconfig(appId);

    const { result, operationId } = await this.runner.run(
      {
        appId,
        operationType: OperationType.APP_VOLUME_SWAP,
        resourceName: app.slug,
        userId,
        metadata: { volumeName, newClaimName },
      },
      async () => {
        const {
          kind,
          name: deploymentName,
          resource: deployment,
        } = await this.getWorkloadOrThrow(app, kubeconfig);
        const volumes: any[] = deployment.spec?.template?.spec?.volumes ?? [];
        const target = volumes.find((v) => v.name === volumeName);
        if (!target?.persistentVolumeClaim) {
          throw new NotFoundException(
            `Volume "${volumeName}" with a PVC not found on ${kind} "${deploymentName}".`,
          );
        }
        const previousClaim = target.persistentVolumeClaim.claimName;

        await this.kubernetesService.patchWorkloadVolumeClaimName(
          kubeconfig,
          kind,
          app.k8sNamespace,
          deploymentName,
          volumeName,
          newClaimName,
        );
        this.logger.log(
          `Swapped volume "${volumeName}" claimName ${previousClaim} → ${newClaimName} on ${kind} "${deploymentName}"`,
        );

        const updatedVolumes = (app.volumes ?? []).map((v) =>
          v.name === volumeName ? { ...v, claimNameOverride: newClaimName } : v,
        );
        await this.applicationsRepository.update(appId, {
          volumes: updatedVolumes,
        });
        await this.appRevisionsRepository.createAuditEvent({
          applicationId: appId,
          eventType: AppEventType.RESTART,
          actor: { type: AppEventActorType.API },
          changeMetadata: {
            operation: 'pvc-swap',
            volumeName,
            previousClaim,
            newClaim: newClaimName,
          },
        });
        this.watchRollout(
          app,
          kubeconfig,
          'pvc-swap',
          RolloutSection.PODS,
          true,
        );
        return this.buildRuntimeResponse(app, kubeconfig);
      },
    );
    return { ...result, operationId };
  }

  // ── Rollout watcher ────────────────────────────────────────────────────────

  /**
   * Polls the Deployment replica status in the background and emits WebSocket
   * events until all pods are ready or the timeout is reached.
   * This method is intentionally fire-and-forget (not awaited by callers).
   */
  private watchRollout(
    app: ApplicationEntity,
    kubeconfig: string,
    operation: string,
    section: RolloutSection,
    indeterminate: boolean,
  ): void {
    const run = async () => {
      const startTime = Date.now();
      const { kind: workloadKind, name: deploymentName } =
        await this.resolveWorkloadKind(app.id);

      // Short initial delay to let K8s register the update
      await this.sleep(1000);

      while (Date.now() - startTime < ROLLOUT_TIMEOUT_MS) {
        await this.sleep(ROLLOUT_POLL_INTERVAL_MS);

        try {
          const detail = await this.kubernetesService.getResourceDetail(
            kubeconfig,
            workloadKind,
            deploymentName,
            app.k8sNamespace,
          );

          const desired = detail?.replicas?.desired ?? 0;
          const ready = detail?.replicas?.ready ?? 0;
          const available = detail?.replicas?.available ?? 0;
          const unavailable = detail?.replicas?.unavailable ?? 0;
          const scalingToZero = desired === 0;
          let percentage: number | null;
          if (indeterminate) {
            percentage = null;
          } else if (scalingToZero) {
            percentage = available + unavailable === 0 ? 100 : 0;
          } else {
            percentage = Math.round((ready / desired) * 100);
          }

          this.gateway.emitRolloutProgress(app.id, {
            appId: app.id,
            operation,
            section,
            indeterminate,
            percentage,
            readyReplicas: ready,
            desiredReplicas: desired,
            message: scalingToZero
              ? `Waiting for pods to terminate (${available + unavailable} remaining)`
              : `Waiting for pods to be ready (${ready}/${desired})`,
            timestamp: new Date(),
          });

          const isComplete = scalingToZero
            ? available === 0 && unavailable === 0
            : ready >= desired;
          if (isComplete) {
            const runtimeSnapshot = await this.buildRuntimeResponse(
              app,
              kubeconfig,
            );
            this.gateway.emitRolloutCompleted(app.id, {
              appId: app.id,
              operation,
              section,
              duration: Date.now() - startTime,
              runtimeSnapshot,
              timestamp: new Date(),
            });
            return;
          }
        } catch (err) {
          this.logger.warn(
            `[${app.id}] watchRollout poll error (will retry): ${err.message}`,
          );
        }
      }

      // Timeout reached
      this.gateway.emitRolloutFailed(app.id, {
        appId: app.id,
        operation,
        section,
        error: `Rollout timeout after ${ROLLOUT_TIMEOUT_MS / 1000}s`,
        timestamp: new Date(),
      });
    };

    run().catch((err) =>
      this.logger.error(`[${app.id}] watchRollout fatal error: ${err.message}`),
    );
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async resolveAppAndKubeconfig(
    appId: string,
  ): Promise<{ app: ApplicationEntity; kubeconfig: string }> {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException(`Application ${appId} not found`);

    const cluster = await this.clusterRepository.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${app.clusterId} has no kubeconfig available`,
      );
    }

    return {
      app,
      kubeconfig: this.encryptionService.decrypt(cluster.kubeconfigEncrypted),
    };
  }

  private async resolveWorkloadKind(
    appId: string,
  ): Promise<{ kind: string; name: string }> {
    const workloadKinds = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
    const resources =
      await this.appResourcesRepository.findByApplicationId(appId);
    const primary = resources.find((r) => workloadKinds.has(r.kind));
    return {
      kind: primary?.kind ?? 'Deployment',
      name: primary?.name ?? appId,
    };
  }

  /** Resolve + fetch the app's primary workload (StatefulSet for persistent apps, else Deployment). */
  private async getWorkloadOrThrow(
    app: ApplicationEntity,
    kubeconfig: string,
  ): Promise<{ kind: string; name: string; resource: any }> {
    const { kind, name } = await this.resolveWorkloadKind(app.id);
    const resource = await this.kubernetesService.getResource(
      kubeconfig,
      kind,
      name,
      app.k8sNamespace,
    );
    if (!resource) {
      throw new NotFoundException(
        `${kind} "${name}" not found in namespace "${app.k8sNamespace}". Deploy the application first.`,
      );
    }
    return { kind, name, resource };
  }

  private async buildRuntimeResponse(
    app: ApplicationEntity,
    kubeconfig: string,
  ): Promise<AppRuntimeResponseDto> {
    const { kind: workloadKind, name: workloadName } =
      await this.resolveWorkloadKind(app.id);
    const deploymentName = workloadName;

    const detail = await this.kubernetesService.getResourceDetail(
      kubeconfig,
      workloadKind,
      deploymentName,
      app.k8sNamespace,
    );

    const labelSelector = `app.kubernetes.io/instance=${app.id}`;
    const podMetrics = await this.kubernetesService.getPodMetrics(
      kubeconfig,
      app.k8sNamespace,
      labelSelector,
    );

    // Aggregate usage across all pods per container name
    const usageByContainer = new Map<
      string,
      { cpuTotal: number; memTotal: number; count: number }
    >();
    for (const pod of podMetrics) {
      for (const c of pod.containers) {
        const existing = usageByContainer.get(c.name) ?? {
          cpuTotal: 0,
          memTotal: 0,
          count: 0,
        };
        existing.cpuTotal += this.parseCpu(c.usage.cpu);
        existing.memTotal += this.parseMemory(c.usage.memory);
        existing.count += 1;
        usageByContainer.set(c.name, existing);
      }
    }

    const containers: ContainerRuntimeDetailDto[] = (
      detail?.containers ?? []
    ).map((c) => {
      const agg = usageByContainer.get(c.name);
      const usageDto: ContainerResourcesDto | undefined = agg
        ? {
            cpu: this.formatCpu(agg.cpuTotal),
            memory: this.formatMemory(agg.memTotal),
          }
        : undefined;

      return {
        name: c.name,
        image: c.image,
        requests: { cpu: c.requests.cpu, memory: c.requests.memory },
        limits: { cpu: c.limits.cpu, memory: c.limits.memory },
        usage: usageDto,
      };
    });

    return {
      appId: app.id,
      deploymentName,
      namespace: app.k8sNamespace,
      replicas: detail?.replicas ?? {},
      containers,
    };
  }

  private buildEntityResources(
    dto: UpdateResourcesDto,
    existing: ApplicationResources | undefined,
  ): ApplicationResources {
    const current: ApplicationResources = existing ?? {};
    return {
      cpu: {
        request: dto.requests?.cpu ?? current.cpu?.request,
        limit: dto.limits?.cpu ?? current.cpu?.limit,
      },
      memory: {
        request: dto.requests?.memory ?? current.memory?.request,
        limit: dto.limits?.memory ?? current.memory?.limit,
      },
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Minimal CPU/memory parsing for aggregating metrics (nanocores → millicores string)
  private parseCpu(raw: string): number {
    if (!raw) return 0;
    if (raw.endsWith('n')) return Number.parseInt(raw) / 1_000_000; // nanocores → millicores
    if (raw.endsWith('u')) return Number.parseInt(raw) / 1_000; // microcores → millicores
    if (raw.endsWith('m')) return Number.parseInt(raw); // millicores
    return Number.parseFloat(raw) * 1000; // cores → millicores
  }

  private formatCpu(millicores: number): string {
    if (millicores >= 1000) return `${(millicores / 1000).toFixed(2)}`;
    return `${Math.round(millicores)}m`;
  }

  private parseMemory(raw: string): number {
    if (!raw) return 0;
    if (raw.endsWith('Ki')) return Number.parseInt(raw) * 1024;
    if (raw.endsWith('Mi')) return Number.parseInt(raw) * 1024 * 1024;
    if (raw.endsWith('Gi')) return Number.parseInt(raw) * 1024 * 1024 * 1024;
    if (raw.endsWith('k')) return Number.parseInt(raw) * 1000;
    if (raw.endsWith('M')) return Number.parseInt(raw) * 1_000_000;
    if (raw.endsWith('G')) return Number.parseInt(raw) * 1_000_000_000;
    return Number.parseInt(raw);
  }

  private formatMemory(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}Gi`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}Mi`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}Ki`;
    return `${bytes}`;
  }
}
