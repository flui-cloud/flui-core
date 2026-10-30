import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { IsNull, Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeType } from '../entities/cluster-node.entity';
import { NodePriceService } from './node-price.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { getOperationSteps } from '../../operations/helpers/operation-steps.helper';
import { ApplicationEntity } from '../../../applications/entities/application.entity';
import { ProviderFactory } from '../../../providers/services/provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { BillingIntervalsService } from './billing-intervals.service';
import { VolumeBillableKind } from '../entities/volume-billable-interval.entity';
import {
  ARM_SERVER_WARNING_CODE,
  providerServerTypeWarning,
} from '../../../providers/core/catalogue/server-architecture';
import { ClusterCapacityService } from './cluster-capacity.service';
import { CapacityCandidateDto } from '../dto/cluster-capacity-plan.dto';
import {
  HaResizeReadiness,
  NodeResizeHaService,
} from './node-resize-ha.service';

export interface ScaleNodeImpactDto {
  clusterId: string;
  node: {
    id: string;
    name: string;
    nodeType: NodeType;
    providerResourceId: string;
    currentServerType: string;
    isLocked: boolean;
  };
  affectedDedicatedApps: Array<{ id: string; slug: string }>;
  expectedDowntimeMs: number;
  warning: string;
  /** Machine types this node could move to, against its own current type. */
  candidates: CapacityCandidateDto[];
  /**
   * On a cluster across three locations: why the resize would be refused now,
   * and the primaries handed over before the node goes down. Null elsewhere.
   */
  highAvailability: {
    refusal: string | null;
    switchovers: Array<{ namespace: string; cluster: string; target: string }>;
  } | null;
}

export interface ScaleNodeRequest {
  targetServerType: string;
  upgradeDisk?: boolean;
  /** New size of the space for copies of replicated volumes on this node, grown once it is back. */
  copiesGiB?: number;
}

export interface ScaleNodeJobData {
  operationId: string;
}

interface ScaleRun {
  operationId: string;
  meta: {
    clusterId: string;
    nodeId: string;
    targetServerType: string;
    upgradeDisk?: boolean;
    copiesGiB?: number;
  };
  cluster: ClusterEntity;
  node: ClusterNodeEntity;
  provider: ReturnType<ProviderFactory['getProvider']>;
  kubeconfig: string | null;
  isMaster: boolean;
  /** Set while the machine is off because of this run, so a failure brings it back. */
  poweredOff: boolean;
}

export interface ExpandSharedVolumeRequest {
  targetSizeGb: number;
}

@Injectable()
export class ClusterNodeScalingService {
  private readonly logger = new Logger(ClusterNodeScalingService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    private readonly providerFactory: ProviderFactory,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly billingIntervals: BillingIntervalsService,
    private readonly nodePriceService: NodePriceService,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly capacity: ClusterCapacityService,
    // Absent in the CLI's own container, which resizes the control cluster's
    // master in process: a resize there works as it always has.
    @Optional() private readonly resizeHa?: NodeResizeHaService,
  ) {}

  private haReadiness(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<HaResizeReadiness | null> {
    return this.resizeHa?.readiness(cluster, node) ?? Promise.resolve(null);
  }

  // ─── Impact preview ────────────────────────────────────────────────────────

  async previewScaleNode(
    clusterId: string,
    nodeId: string,
  ): Promise<ScaleNodeImpactDto> {
    const { cluster, node } = await this.resolveClusterAndNode(
      clusterId,
      nodeId,
    );
    const provider = this.providerFactory.getProvider(
      cluster.provider as CloudProvider,
    );
    const details = await provider.getServerDetailsAsDto?.(
      node.providerResourceId,
    );
    const affected = await this.findDedicatedAppsOnNode(clusterId, node);
    const isLocked = node.nodeType === NodeType.MASTER || affected.length > 0;
    return {
      clusterId,
      node: {
        id: node.id,
        name: node.serverName,
        nodeType: node.nodeType,
        providerResourceId: node.providerResourceId,
        currentServerType: details?.server_type ?? 'unknown',
        isLocked,
      },
      affectedDedicatedApps: affected.map((a) => ({
        id: a.id,
        slug: a.slug,
      })),
      expectedDowntimeMs: 240000,
      candidates: await this.capacity.candidatesFor(
        cluster.provider,
        details?.server_type ?? node.serverType,
      ),
      highAvailability: await this.haReadiness(cluster, node),
      warning:
        affected.length > 0
          ? `Scaling this node will stop ${affected.length} dedicated workload(s) (~3–5 min of downtime). Snapshot them with \`flui app snapshot create\` before proceeding.`
          : 'Scaling this node will power-cycle it; any pods scheduled here will be temporarily unavailable.',
    };
  }

  // ─── Scale node (vertical) ─────────────────────────────────────────────────

  async scaleNode(
    clusterId: string,
    nodeId: string,
    request: ScaleNodeRequest,
    userId?: string,
    options: { queue?: boolean } = {},
  ): Promise<InfrastructureOperationEntity> {
    const { cluster, node } = await this.resolveClusterAndNode(
      clusterId,
      nodeId,
    );
    const provider = this.providerFactory.getProvider(
      cluster.provider as CloudProvider,
    );
    if (!provider.changeServerType) {
      throw new BadRequestException(
        `Provider "${cluster.provider}" does not support changeServerType.`,
      );
    }
    if (!provider.powerOffServer || !provider.powerOnServer) {
      throw new BadRequestException(
        `Provider "${cluster.provider}" does not support power management.`,
      );
    }

    const warning = await providerServerTypeWarning(
      provider,
      request.targetServerType,
    );
    if (warning) {
      this.logger.log(
        `Node ${node.serverName} to ${request.targetServerType}: ${warning}`,
      );
    }

    const currentDetails = await provider.getServerDetailsAsDto?.(
      node.providerResourceId,
    );
    if (currentDetails?.server_type === request.targetServerType) {
      throw new BadRequestException(
        `Node is already on server type "${request.targetServerType}".`,
      );
    }

    const ha = await this.haReadiness(cluster, node);
    if (ha?.refusal) throw new BadRequestException(ha.refusal);

    const steps = getOperationSteps(OperationType.SCALE_NODE);
    const operation = this.operationRepository.create({
      operationType: OperationType.SCALE_NODE,
      status: OperationStatus.PENDING,
      resourceType: 'cluster-node',
      resourceName: node.serverName,
      resourceId: node.id,
      userId,
      totalSteps: steps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        clusterId,
        nodeId,
        nodeName: node.serverName,
        nodeType: node.nodeType,
        currentServerType: currentDetails?.server_type ?? null,
        targetServerType: request.targetServerType,
        upgradeDisk: request.upgradeDisk ?? false,
        ...(request.copiesGiB && { copiesGiB: request.copiesGiB }),
        ...(ha && { highAvailability: true }),
        operationSteps: steps,
        ...(warning
          ? {
              warnings: [{ code: ARM_SERVER_WARNING_CODE, message: warning }],
            }
          : {}),
      },
    });
    const saved = await this.operationRepository.save(operation);
    // The control cluster's master runs the API: its resize is run by the
    // CLI that asked for it, which runScaleNode then does in process.
    if (options.queue === false) return saved;
    await this.infrastructureQueue.add(
      'scale-node',
      { operationId: saved.id } satisfies ScaleNodeJobData,
      { attempts: 1, timeout: 30 * 60 * 1000 },
    );
    this.logger.log(
      `Queued scale-node ${node.serverName} → ${request.targetServerType} (operation ${saved.id})`,
    );
    return saved;
  }

  /**
   * The steps of a resize, each checking where the machine already is, so a
   * job that runs again after the API restarted carries on instead of
   * starting over. A failure once the machine is off tries to bring it back,
   * so a resize that could not finish does not leave a node down.
   */
  async runScaleNode(operationId: string): Promise<void> {
    const operation = await this.operationRepository.findOneOrFail({
      where: { id: operationId },
    });
    const meta = operation.metadata as ScaleRun['meta'];
    const { cluster, node } = await this.resolveClusterAndNode(
      meta.clusterId,
      meta.nodeId,
    );
    const run: ScaleRun = {
      operationId,
      meta,
      cluster,
      node,
      provider: this.providerFactory.getProvider(
        cluster.provider as CloudProvider,
      ),
      kubeconfig: cluster.kubeconfigEncrypted
        ? this.encryptionService.decrypt(cluster.kubeconfigEncrypted)
        : null,
      isMaster: node.nodeType === NodeType.MASTER,
      poweredOff: false,
    };

    await this.operationRepository.update(operationId, {
      status: OperationStatus.IN_PROGRESS,
      startedAt: operation.startedAt ?? new Date(),
    });
    try {
      await this.prepareForResize(run);
      await this.changeMachine(run);
      await this.waitHealthy(run);
      await this.recordNewType(run);

      // Step 5: finalize
      await this.advanceStep(operationId, 5, 100, {
        status: OperationStatus.COMPLETED,
        message: `Node ${node.serverName} scaled to ${meta.targetServerType}`,
        completedAt: new Date().toISOString(),
      });
      await this.operationRepository.update(operationId, {
        status: OperationStatus.COMPLETED,
        completedAt: new Date(),
      });
    } catch (error) {
      await this.failScaleNode(run, error as Error);
    }
  }

  /** Step 0: primaries handed over, then cordon. The master is not cordoned: its API goes down with it. */
  private async prepareForResize(run: ScaleRun): Promise<void> {
    const { operationId, kubeconfig, node } = run;
    const ha = kubeconfig ? await this.haReadiness(run.cluster, node) : null;
    for (const s of ha?.switchovers ?? []) {
      await this.advanceStep(operationId, 0, 20, {
        message: `Handing the primary of ${s.namespace}/${s.cluster} over to ${s.target}`,
      });
      await this.resizeHa!.switchover(kubeconfig!, s);
    }
    if (!run.isMaster && kubeconfig) {
      await this.advanceStep(operationId, 0, 50, {
        message: 'Cordoning worker node',
      });
      try {
        await this.kubernetesService.cordonNode(kubeconfig, node.serverName);
      } catch (err) {
        this.logger.warn(
          `Cordon failed for ${node.serverName}: ${(err as Error).message} — continuing`,
        );
      }
    } else {
      await this.advanceStep(operationId, 0, 50, {
        message: 'Master node: skipping cordon (k8s API co-located)',
      });
    }
    await this.advanceStep(operationId, 0, 100);
  }

  /** Steps 1-3, each skipped when the machine is already past it. */
  private async changeMachine(run: ScaleRun): Promise<void> {
    const { operationId, provider, node, meta } = run;
    const details = () =>
      provider.getServerDetailsAsDto?.(node.providerResourceId);
    const before = await details();

    // Step 1: power off
    await this.advanceStep(operationId, 1, 0, {
      message: 'Powering off node',
    });
    if (before?.server_type !== meta.targetServerType) {
      if (before?.status !== 'off') {
        await provider.powerOffServer!(node.providerResourceId);
      }
      run.poweredOff = true;
      await this.waitForServerStatus(provider, node.providerResourceId, 'off');
    }
    await this.advanceStep(operationId, 1, 100);

    // Step 2: change_type
    await this.advanceStep(operationId, 2, 0, {
      message: `Changing server type → ${meta.targetServerType}`,
    });
    if ((await details())?.server_type !== meta.targetServerType) {
      await provider.changeServerType!(node.providerResourceId, {
        targetServerType: meta.targetServerType,
        upgradeDisk: meta.upgradeDisk ?? false,
      });
    }
    await this.advanceStep(operationId, 2, 100);

    // Step 3: power on
    await this.advanceStep(operationId, 3, 0, {
      message: 'Powering on node',
    });
    if ((await details())?.status !== 'running') {
      await provider.powerOnServer!(node.providerResourceId);
    }
    await this.waitForServerStatus(
      provider,
      node.providerResourceId,
      'running',
    );
    run.poweredOff = false;
    await this.advanceStep(operationId, 3, 100);
  }

  /**
   * Step 4. For the master: a TCP probe of the public IP on port 80
   * (Traefik); when Traefik answers, k3s, ingress and master are all up. For a
   * worker: its Node Ready condition through the master's k8s API. The space
   * for copies grows once the node is back.
   */
  private async waitHealthy(run: ScaleRun): Promise<void> {
    const { operationId, kubeconfig, node, cluster, meta } = run;
    await this.advanceStep(operationId, 4, 0, {
      message: run.isMaster
        ? 'Waiting for master ingress (TCP :80) to respond'
        : 'Waiting for worker node Ready via master k8s API',
    });
    if (run.isMaster) {
      const masterIp = cluster.masterIpAddress;
      if (!masterIp) {
        throw new Error(
          'Cluster has no masterIpAddress recorded — cannot wait for health',
        );
      }
      await this.waitForTcpOpen(masterIp, 80, 480000, 5000);
    } else if (kubeconfig) {
      await this.kubernetesService.waitForNodeReady(
        kubeconfig,
        node.serverName,
        480000,
        5000,
      );
      try {
        await this.kubernetesService.uncordonNode(kubeconfig, node.serverName);
      } catch (err) {
        this.logger.warn(
          `Uncordon failed for ${node.serverName}: ${(err as Error).message}`,
        );
      }
    }
    const grown =
      meta.copiesGiB && kubeconfig && this.resizeHa
        ? await this.resizeHa.growCopies(
            kubeconfig,
            node.serverName,
            meta.copiesGiB,
          )
        : null;
    await this.advanceStep(operationId, 4, 100, {
      ...(grown && { message: grown }),
    });
  }

  private async recordNewType(run: ScaleRun): Promise<void> {
    const { cluster, node, meta } = run;
    const region = node.region ?? cluster.region;
    node.serverType = meta.targetServerType;
    node.hourlyPriceEur = await this.nodePriceService.resolveHourlyEur(
      cluster.provider,
      meta.targetServerType,
      region,
    );
    await this.nodeRepository.save(node);
    await this.billingIntervals.openNodeInterval({
      clusterId: cluster.id,
      nodeId: node.id,
      serverName: node.serverName,
      providerResourceId: node.providerResourceId,
      provider: cluster.provider,
      region,
      serverType: meta.targetServerType,
      nodeType: node.nodeType,
    });
  }

  private async failScaleNode(run: ScaleRun, error: Error): Promise<void> {
    const { operationId, node, provider } = run;
    const message = error.message;
    this.logger.error(
      `scaleNode failed for node=${node.serverName}: ${message}`,
    );
    const recovery = run.poweredOff
      ? await provider.powerOnServer!(node.providerResourceId)
          .then(() => 'powered back on')
          .catch((err: Error) => `could not be powered back on: ${err.message}`)
      : null;
    const current = await this.operationRepository.findOneOrFail({
      where: { id: operationId },
    });
    current.status = OperationStatus.FAILED;
    current.errorMessage = recovery
      ? `${message} The node ${recovery}.`
      : message;
    current.completedAt = new Date();
    current.metadata = {
      ...current.metadata,
      error: message,
      ...(recovery && { recovery }),
      failedAt: new Date().toISOString(),
    } as InfrastructureOperationEntity['metadata'];
    await this.operationRepository.save(current);
  }

  // ─── Expand shared storage volume ──────────────────────────────────────────

  async expandSharedVolume(
    clusterId: string,
    request: ExpandSharedVolumeRequest,
    userId?: string,
  ): Promise<InfrastructureOperationEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);

    if (cluster.sharedStorageEnabled === false) {
      throw new BadRequestException(
        `Cluster ${clusterId} has sharedStorageEnabled=false.`,
      );
    }
    if (!cluster.sharedStorageVolumeId) {
      throw new BadRequestException(
        `Cluster ${clusterId} has no Flui-managed shared storage volume.`,
      );
    }
    const currentSize = cluster.sharedStorageVolumeSizeGb ?? 0;
    if (request.targetSizeGb <= currentSize) {
      throw new BadRequestException(
        `Target size (${request.targetSizeGb} GB) must be greater than current size (${currentSize} GB). Volumes can only grow.`,
      );
    }

    const provider = this.providerFactory.getProvider(
      cluster.provider as CloudProvider,
    );
    if (!provider.expandVolume) {
      throw new BadRequestException(
        `Provider "${cluster.provider}" does not support volume resize.`,
      );
    }

    const steps = getOperationSteps(OperationType.EXPAND_SHARED_VOLUME);
    const operation = this.operationRepository.create({
      operationType: OperationType.EXPAND_SHARED_VOLUME,
      status: OperationStatus.PENDING,
      resourceType: 'cluster',
      resourceName: cluster.name,
      resourceId: cluster.id,
      userId,
      totalSteps: steps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        clusterId,
        volumeId: cluster.sharedStorageVolumeId,
        fromSizeGb: currentSize,
        toSizeGb: request.targetSizeGb,
        operationSteps: steps,
      },
    });
    const saved = await this.operationRepository.save(operation);

    try {
      saved.status = OperationStatus.IN_PROGRESS;
      saved.startedAt = new Date();
      await this.operationRepository.save(saved);

      await this.advanceStep(saved.id, 0, 100, {
        message: 'Precheck OK',
      });

      // Step 1: provider resize
      await this.advanceStep(saved.id, 1, 0, {
        message: 'Resizing volume on provider',
      });
      const volumeZone = await this.resolveVolumeZone(cluster);
      const volumeRef = this.formatVolumeRefForProvider(
        cluster.provider as CloudProvider,
        volumeZone,
        cluster.sharedStorageVolumeId,
      );
      await provider.expandVolume(volumeRef, request.targetSizeGb);
      await this.advanceStep(saved.id, 1, 100);

      // Step 2: resize2fs via privileged k8s Job on the master
      await this.advanceStep(saved.id, 2, 0, {
        message: 'Growing filesystem on master',
      });
      try {
        const device = this.resolveBlockDevice(
          cluster.provider as CloudProvider,
          cluster.sharedStorageVolumeId,
        );
        await this.runResizeFsJob(cluster, device);
      } catch (err) {
        this.logger.warn(
          `resize2fs Job failed: ${(err as Error).message} — the provider resize succeeded but the filesystem still shows the old size.`,
        );
        saved.metadata = {
          ...saved.metadata,
          fsResizeWarning: (err as Error).message,
        };
      }
      await this.advanceStep(saved.id, 2, 100);

      // Step 3: finalize — update cluster row
      await this.advanceStep(saved.id, 3, 0, {
        message: 'Updating cluster record',
      });
      cluster.sharedStorageVolumeSizeGb = request.targetSizeGb;
      await this.clusterRepository.save(cluster);
      if (cluster.sharedStorageVolumeId) {
        await this.billingIntervals.openVolumeInterval({
          clusterId: cluster.id,
          volumeProviderId: cluster.sharedStorageVolumeId,
          provider: cluster.provider,
          region: cluster.region,
          kind: VolumeBillableKind.SHARED_STORAGE,
          sizeGb: request.targetSizeGb,
        });
      }
      await this.advanceStep(saved.id, 3, 100, {
        status: OperationStatus.COMPLETED,
        message: `Shared volume expanded ${currentSize} → ${request.targetSizeGb} GB`,
        completedAt: new Date().toISOString(),
      });
      saved.status = OperationStatus.COMPLETED;
      saved.completedAt = new Date();
      await this.operationRepository.save(saved);
      return saved;
    } catch (error) {
      this.logger.error(
        `expandSharedVolume failed for cluster=${clusterId}: ${(error as Error).message}`,
      );
      saved.status = OperationStatus.FAILED;
      saved.metadata = {
        ...saved.metadata,
        error: (error as Error).message,
        failedAt: new Date().toISOString(),
      };
      await this.operationRepository.save(saved);
      throw error;
    }
  }

  // ─── Uncordon (recovery helper) ────────────────────────────────────────────

  async uncordonNode(clusterId: string, nodeId: string): Promise<void> {
    const { cluster, node } = await this.resolveClusterAndNode(
      clusterId,
      nodeId,
    );
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${clusterId} has no kubeconfig stored — cannot uncordon`,
      );
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    await this.kubernetesService.uncordonNode(kubeconfig, node.serverName);
    this.logger.log(`Uncordoned node ${node.serverName}`);
  }

  // ─── Node-lock check (used by remove worker flow) ──────────────────────────

  async assertNodeUnlocked(clusterId: string, nodeId: string): Promise<void> {
    const node = await this.nodeRepository.findOne({
      where: { id: nodeId, clusterId },
    });
    if (!node) return;
    const apps = await this.findDedicatedAppsOnNode(clusterId, node);
    if (apps.length > 0) {
      throw new BadRequestException({
        code: 'NODE_LOCKED_BY_DEDICATED_APPS',
        message:
          `Node ${node.serverName} hosts ${apps.length} dedicated workload(s) ` +
          `(${apps.map((a) => a.slug).join(', ')}). Back up their data, then delete ` +
          `or redeploy these apps before removing this worker.`,
        details: { affectedApps: apps.map((a) => a.slug) },
      });
    }
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async resolveClusterAndNode(
    clusterId: string,
    nodeId: string,
  ): Promise<{ cluster: ClusterEntity; node: ClusterNodeEntity }> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    const node = await this.nodeRepository.findOne({
      where: { id: nodeId, clusterId },
    });
    if (!node)
      throw new NotFoundException(
        `Node ${nodeId} not found in cluster ${clusterId}`,
      );
    return { cluster, node };
  }

  private async findDedicatedAppsOnNode(
    clusterId: string,
    node: ClusterNodeEntity,
  ): Promise<ApplicationEntity[]> {
    if (node.nodeType === NodeType.MASTER) {
      return this.applicationRepository.find({
        where: {
          clusterId,
          persistenceScope: 'dedicated',
          deletedAt: IsNull(),
        },
      });
    }
    return this.applicationRepository
      .createQueryBuilder('a')
      .where('a.clusterId = :clusterId', { clusterId })
      .andWhere('a.persistenceScope = :scope', { scope: 'dedicated' })
      .andWhere('a.dedicatedNodeName = :name', { name: node.serverName })
      .andWhere('a.deletedAt IS NULL')
      .getMany();
  }

  private async advanceStep(
    operationId: string,
    stepIndex: number,
    stepProgress: number,
    extraMeta: Record<string, any> = {},
  ): Promise<void> {
    const op = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (!op) return;
    op.currentStepIndex = stepIndex;
    op.currentStepProgress = stepProgress;
    op.metadata = { ...op.metadata, ...extraMeta };
    await this.operationRepository.save(op);
  }

  /**
   * Poll a TCP connect on `host:port` until it succeeds or the timeout
   * expires. Used as a tunnel-free liveness check for the master node
   * (Traefik on :80 answers once k3s + ingress are up).
   */
  private async waitForTcpOpen(
    host: string,
    port: number,
    timeoutMs = 480000,
    intervalMs = 5000,
  ): Promise<void> {
    const net = await import('node:net');
    const start = Date.now();
    let lastErr: Error | undefined;
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        const cleanup = () => {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        };
        const onErr = (err: Error) => {
          lastErr = err;
          cleanup();
          resolve(false);
        };
        socket.setTimeout(intervalMs);
        socket.once('connect', () => {
          cleanup();
          resolve(true);
        });
        socket.once('error', onErr);
        socket.once('timeout', () => onErr(new Error('connect timeout')));
        socket.connect(port, host);
      });
      if (ok) return;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    const errSuffix = lastErr ? ` (last error: ${lastErr.message})` : '';
    throw new Error(
      `TCP ${host}:${port} did not open within ${Math.round(timeoutMs / 1000)}s${errSuffix}`,
    );
  }

  private async waitForServerStatus(
    provider: ReturnType<ProviderFactory['getProvider']>,
    serverId: string,
    expected: 'off' | 'running',
    timeoutMs = 180000,
    intervalMs = 4000,
  ): Promise<void> {
    if (!provider.getServerDetailsAsDto) return;
    const start = Date.now();
    let last: string | undefined;
    while (Date.now() - start < timeoutMs) {
      try {
        const details = await provider.getServerDetailsAsDto(serverId);
        last = details?.status;
        if (last && this.matchesExpectedStatus(last, expected)) return;
      } catch (err) {
        this.logger.warn(
          `waitForServerStatus poll error: ${(err as Error).message}`,
        );
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `Server ${serverId} did not reach status="${expected}" within ${Math.round(timeoutMs / 1000)}s (last=${last ?? 'unknown'})`,
    );
  }

  /**
   * Cross-provider status reconciliation. Hetzner returns `off`/`running`,
   * Scaleway returns `stopped`/`running`, Contabo and others have their own
   * vocabulary. Normalise to the two canonical states we care about during
   * a scale operation.
   */
  private matchesExpectedStatus(
    raw: string,
    expected: 'off' | 'running',
  ): boolean {
    const r = raw.toLowerCase();
    if (expected === 'running') return r === 'running' || r === 'ready';
    return (
      r === 'off' ||
      r === 'stopped' ||
      r === 'stopped in place' ||
      r === 'stopped_in_place'
    );
  }

  private formatVolumeRefForProvider(
    provider: CloudProvider,
    zone: string,
    volumeId: string,
  ): string {
    if (provider === CloudProvider.SCALEWAY) {
      return `${zone}:${volumeId}`;
    }
    return volumeId;
  }

  /**
   * Scaleway SBS volumes are zone-scoped (e.g. `fr-par-1`), but the cluster
   * only records the parent region (`fr-par`). Resolve the zone by looking
   * at the master node's providerResourceId, which encodes it as
   * `instance:<zone>:<uuid>`. For Hetzner this is a no-op — the volume id is
   * a numeric global id that doesn't need a zone prefix.
   */
  private async resolveVolumeZone(cluster: ClusterEntity): Promise<string> {
    if (cluster.provider !== CloudProvider.SCALEWAY) return cluster.region;
    const master = await this.nodeRepository.findOne({
      where: { clusterId: cluster.id, nodeType: NodeType.MASTER },
    });
    if (master?.providerResourceId?.includes(':')) {
      const parts = master.providerResourceId.split(':');
      if (parts.length >= 2) return parts[1];
    }
    return cluster.region;
  }

  private resolveBlockDevice(
    provider: CloudProvider,
    volumeId: string,
  ): string {
    if (provider === CloudProvider.SCALEWAY) {
      return `/dev/disk/by-id/scsi-0SCW_sbs_volume-${volumeId}`;
    }
    // Hetzner exposes volumes as /dev/disk/by-id/scsi-0HC_Volume_<id>
    return `/dev/disk/by-id/scsi-0HC_Volume_${volumeId}`;
  }

  private async runResizeFsJob(
    cluster: ClusterEntity,
    device: string,
  ): Promise<void> {
    if (!cluster.kubeconfigEncrypted) {
      throw new Error('No kubeconfig available for resize Job');
    }
    const master = (cluster.nodes ?? []).find((n) => n.nodeType === 'master');
    if (!master?.serverName) {
      throw new Error('Master node serverName not found on cluster');
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    const namespace = 'flui-system';
    const jobName = `flui-fs-resize-${Date.now()}`;
    const script =
      `set -e; apk add --no-cache e2fsprogs e2fsprogs-extra; ` +
      `RESOLVED=""; ` +
      `if [ -e ${device} ]; then RESOLVED=$(readlink -f ${device}); fi; ` +
      `if [ -z "$RESOLVED" ]; then ` +
      `RESOLVED=$(ls -1 /dev/disk/by-id/ 2>/dev/null | grep -F -- "${cluster.sharedStorageVolumeId}" | head -1 | xargs -I{} readlink -f /dev/disk/by-id/{}); ` +
      `fi; ` +
      `if [ -z "$RESOLVED" ]; then echo "Could not resolve device for volume ${cluster.sharedStorageVolumeId}"; ls -la /dev/disk/by-id/ 2>&1; exit 1; fi; ` +
      `echo "Resolved to $RESOLVED"; resize2fs "$RESOLVED"`;
    const escapedScript = script.replaceAll('"', String.raw`\"`);
    const manifest = [
      'apiVersion: batch/v1',
      'kind: Job',
      'metadata:',
      `  name: ${jobName}`,
      `  namespace: ${namespace}`,
      '  labels:',
      '    flui.cloud/managed-by: flui-cloud',
      '    flui-resource-type: fs-resize',
      `    flui-cluster-id: ${cluster.id}`,
      'spec:',
      '  ttlSecondsAfterFinished: 60',
      '  backoffLimit: 0',
      '  template:',
      '    metadata:',
      '      labels:',
      '        flui.cloud/managed-by: flui-cloud',
      '        flui-resource-type: fs-resize',
      '    spec:',
      '      restartPolicy: Never',
      '      nodeSelector:',
      `        kubernetes.io/hostname: ${master.serverName}`,
      '      tolerations:',
      '      - key: node-role.kubernetes.io/control-plane',
      '        operator: Exists',
      '        effect: NoSchedule',
      '      - key: node-role.kubernetes.io/master',
      '        operator: Exists',
      '        effect: NoSchedule',
      '      hostPID: true',
      '      containers:',
      '      - name: resize',
      '        image: alpine:3.20',
      '        securityContext:',
      '          privileged: true',
      '        command: ["sh","-c"]',
      `        args: ["${escapedScript}"]`,
      '        volumeMounts:',
      '        - name: dev',
      '          mountPath: /dev',
      '        - name: storage',
      '          mountPath: /var/lib/flui/storage',
      '      volumes:',
      '      - name: dev',
      '        hostPath:',
      '          path: /dev',
      '      - name: storage',
      '        hostPath:',
      '          path: /var/lib/flui/storage',
      '',
    ].join('\n');

    await this.kubernetesService.applyManifest(kubeconfig, manifest);
    const timeoutMs = 120_000;
    const pollMs = 3_000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const job = await this.kubernetesService.getResource(
        kubeconfig,
        'Job',
        jobName,
        namespace,
      );
      const succeeded = job?.status?.succeeded ?? 0;
      const failed = job?.status?.failed ?? 0;
      if (succeeded > 0) {
        this.logger.log(`resize2fs Job ${namespace}/${jobName} succeeded`);
        return;
      }
      if (failed > 0) {
        throw new Error(`resize2fs Job ${namespace}/${jobName} failed`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`resize2fs Job ${namespace}/${jobName} timed out`);
  }
}
