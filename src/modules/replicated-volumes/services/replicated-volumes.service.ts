import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { haCandidatesFrom } from '../../postgres-ha/utils/postgres-ha-feasibility.core';
import { EnableReplicatedVolumesDto } from '../dto/enable-replicated-volumes.dto';
import {
  LINSTOR_CONTROLLER_DEPLOYMENT,
  LINSTOR_CONTROLLER_SELECTOR,
  PIRAEUS_NAMESPACE,
  REPLICATED_POOL_DEFAULT_GIB,
  REPLICATED_STORAGE_CLASS,
  REPLICATED_STORAGE_NODE_LABEL,
  REPLICATED_VOLUMES_JOB_ENABLE,
  REPLICATED_VOLUMES_QUEUE,
} from '../replicated-volumes.constants';
import {
  ReplicatedVolumesFeasibility,
  replicatedVolumesFeasibility,
  staleCopyWarnings,
  voteZonesOf,
  storageNodeWarnings,
  volumeCopiesFrom,
} from '../utils/replicated-volumes.core';
import { missingVoteWarnings } from '../utils/replicated-votes.core';
import {
  ClusterHaService,
  notThreeLocations,
} from '../../cluster-ha/services/cluster-ha.service';
import { PiraeusInstallerService } from './piraeus-installer.service';

export interface EnableReplicatedVolumesJob {
  operationId: string;
  clusterId: string;
  storageNodes: string[];
  sizeGiB: number;
  /** Where the engine's single-copy components run; empty means anywhere away from copies. */
  voteZones?: string[];
  /** Nodes that hold the tie-breaking vote, with no data: they still need the engine's module. */
  tieBreakers?: string[];
}

export interface ReplicatedVolumesView {
  clusterId: string;
  enabled: boolean;
  storageClass: string;
  storageNodes: string[];
  warnings: string[];
  /** What enabling would do with the nodes the cluster has now. */
  plan: ReplicatedVolumesFeasibility;
  operation: { id: string; status: OperationStatus } | null;
}

const RUNNING = [OperationStatus.PENDING, OperationStatus.IN_PROGRESS];

function storageNodesOf(
  nodes: Array<{
    metadata?: { name?: string; labels?: Record<string, string> };
  }>,
): string[] {
  return nodes
    .filter(
      (n) => n.metadata?.labels?.[REPLICATED_STORAGE_NODE_LABEL] === 'true',
    )
    .map((n) => n.metadata!.name!);
}

@Injectable()
export class ReplicatedVolumesService {
  private readonly logger = new Logger(ReplicatedVolumesService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectQueue(REPLICATED_VOLUMES_QUEUE) private readonly queue: Queue,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly installer: PiraeusInstallerService,
    private readonly clusterHa: ClusterHaService,
  ) {}

  async view(clusterId: string): Promise<ReplicatedVolumesView> {
    const ha = await this.clusterHa.inspect(clusterId);
    const storageNodes = storageNodesOf(ha.nodes);
    const storageClass = await this.installer.readStorageClass(ha.kubeconfig);
    const candidates = haCandidatesFrom(ha.nodes);
    const plan: ReplicatedVolumesFeasibility =
      ha.state.level === 'three-locations' && ha.topology
        ? replicatedVolumesFeasibility(candidates, ha.topology, {
            prepared: storageNodes,
          })
        : {
            feasible: false,
            reason: notThreeLocations(ha.cluster.name, ha.state),
          };
    return {
      clusterId,
      enabled: !!storageClass,
      storageClass: REPLICATED_STORAGE_CLASS,
      storageNodes,
      warnings: [
        ...storageNodeWarnings(candidates, storageNodes),
        ...(storageClass ? await this.copyWarnings(ha.kubeconfig) : []),
        ...(storageClass && 'tieBreakers' in plan
          ? await this.voteWarnings(ha.kubeconfig, plan.tieBreakers)
          : []),
      ],
      plan,
      operation: await this.runningOperation(clusterId),
    };
  }

  private async voteWarnings(
    kubeconfig: string,
    tieBreakers: string[],
  ): Promise<string[]> {
    if (!tieBreakers.length) return [];
    try {
      return missingVoteWarnings(
        tieBreakers,
        await this.kubernetes.execInPod(
          kubeconfig,
          PIRAEUS_NAMESPACE,
          LINSTOR_CONTROLLER_SELECTOR,
          LINSTOR_CONTROLLER_DEPLOYMENT,
          ['linstor', '-m', '--output-version', 'v1', 'node', 'list'],
        ),
      );
    } catch (err: any) {
      this.logger.warn(
        `[replicated-volumes] engine nodes not read (${err?.message ?? err})`,
      );
      return [];
    }
  }

  private async copyWarnings(kubeconfig: string): Promise<string[]> {
    try {
      const copies = volumeCopiesFrom(
        await this.kubernetes.execInPod(
          kubeconfig,
          PIRAEUS_NAMESPACE,
          LINSTOR_CONTROLLER_SELECTOR,
          LINSTOR_CONTROLLER_DEPLOYMENT,
          ['linstor', '-m', '--output-version', 'v1', 'resource', 'list'],
        ),
      );
      const claimOf = new Map<string, string>();
      for (const volume of new Set(
        copies.filter((c) => c.disk !== 'UpToDate').map((c) => c.volume),
      )) {
        const pv = await this.kubernetes
          .readObject(kubeconfig, 'v1', 'PersistentVolume', volume)
          .catch(() => null);
        const claim = pv?.spec?.claimRef;
        if (claim?.name)
          claimOf.set(volume, `${claim.namespace}/${claim.name}`);
      }
      return staleCopyWarnings(copies, claimOf);
    } catch (err: any) {
      this.logger.warn(
        `[replicated-volumes] copy states not read (${err?.message ?? err})`,
      );
      return [];
    }
  }

  /** Null when the cluster could not be asked. */
  async isEnabled(clusterId: string): Promise<boolean | null> {
    try {
      return await this.installer.hasStorageClass(
        await this.kubeconfigOf(clusterId),
      );
    } catch {
      return null;
    }
  }

  /**
   * Checks what can be checked before anything is installed, so a cluster
   * that cannot hold a copy in each location for data is refused with the reason,
   * then hands the work to the queue.
   */
  async enable(
    clusterId: string,
    dto: EnableReplicatedVolumesDto,
    userId?: string,
  ): Promise<{ operationId: string; storageNodes: string[]; sizeGiB: number }> {
    if (await this.runningOperation(clusterId)) {
      throw new BadRequestException(
        'Replicated volumes are already being enabled on this cluster.',
      );
    }
    const ha = await this.clusterHa.requireThreeLocations(clusterId, dto.force);
    const prepared = storageNodesOf(ha.nodes);
    const plan = replicatedVolumesFeasibility(
      haCandidatesFrom(ha.nodes),
      ha.topology,
      { requested: dto.nodes, prepared },
    );
    if (!plan.feasible) {
      throw new BadRequestException((plan as { reason: string }).reason);
    }
    const left = prepared.filter((n) => !plan.storageNodes.includes(n));
    if (left.length) {
      throw new BadRequestException(
        `${left.join(', ')} already set aside space for copies, and new volumes could be placed there. Name the nodes that hold copies today, or take ${left.length === 1 ? 'that node' : 'those nodes'} out of replicated volumes first.`,
      );
    }
    const sizeGiB = dto.sizeGiB ?? REPLICATED_POOL_DEFAULT_GIB;

    const operation = await this.operations.save(
      this.operations.create({
        operationType: OperationType.ENABLE_REPLICATED_VOLUMES,
        status: OperationStatus.PENDING,
        resourceType: 'cluster',
        resourceId: clusterId,
        resourceName: ha.cluster.name,
        userId,
        metadata: {
          storageNodes: plan.storageNodes,
          sizeGiB,
          zones: plan.zones,
          ...(!ha.topology.validated && { forced: true }),
        } as InfrastructureOperationEntity['metadata'],
        totalSteps: 3,
      }),
    );
    const job: EnableReplicatedVolumesJob = {
      operationId: operation.id,
      clusterId,
      storageNodes: plan.storageNodes,
      sizeGiB,
      voteZones: voteZonesOf(ha.topology),
      tieBreakers: 'tieBreakers' in plan ? plan.tieBreakers : [],
    };
    await this.queue.add(REPLICATED_VOLUMES_JOB_ENABLE, job, { attempts: 1 });
    this.logger.log(
      `[replicated-volumes] ${ha.cluster.name}: enabling on ${plan.storageNodes.join(', ')} (${plan.zones.join(', ')}, ${sizeGiB} GiB each)`,
    );
    return {
      operationId: operation.id,
      storageNodes: plan.storageNodes,
      sizeGiB,
    };
  }

  private async runningOperation(
    clusterId: string,
  ): Promise<{ id: string; status: OperationStatus } | null> {
    const op = await this.operations.findOne({
      where: {
        operationType: OperationType.ENABLE_REPLICATED_VOLUMES,
        resourceId: clusterId,
        status: In(RUNNING),
      },
      order: { createdAt: 'DESC' },
    });
    return op ? { id: op.id, status: op.status } : null;
  }

  private async kubeconfigOf(clusterId: string): Promise<string> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException('This cluster cannot be reached.');
    }
    return this.encryption.decrypt(cluster.kubeconfigEncrypted);
  }
}
