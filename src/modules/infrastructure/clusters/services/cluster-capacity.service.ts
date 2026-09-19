import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeType } from '../entities/cluster-node.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { ProviderFactory } from '../../../providers/services/provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { NodeSizeDto } from '../../../providers/dto/node-size.dto';
import {
  CapacityCandidateDto,
  CapacityMasterDto,
  CapacityStorageDto,
  ClusterCapacityPlanDto,
} from '../dto/cluster-capacity-plan.dto';
import { ClusterStorageService } from './cluster-storage.service';

@Injectable()
export class ClusterCapacityService {
  private readonly logger = new Logger(ClusterCapacityService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly providerFactory: ProviderFactory,
    private readonly clusterStorageService: ClusterStorageService,
  ) {}

  async getPlan(clusterId: string): Promise<ClusterCapacityPlanDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const masterNode = await this.nodeRepository.findOne({
      where: { clusterId, nodeType: NodeType.MASTER },
    });

    const provider = cluster.provider as CloudProvider;
    /**
     * A cluster whose machines were brought rather than bought has no adapter
     * here, and the factory says so by throwing. That is the right answer to
     * "sell me a bigger node" and the wrong one to "how much room is left",
     * which is the question this endpoint is actually asked — so the failure is
     * absorbed and the plan carries on without the half a provider would have
     * filled in.
     */
    let providerService: ReturnType<ProviderFactory['getProvider']> | null =
      null;
    try {
      providerService = this.providerFactory.getProvider(provider);
    } catch {
      this.logger.debug(
        `No provider adapter for ${provider} — capacity is read from the cluster alone`,
      );
    }

    let currentServerType: string | undefined;
    if (
      masterNode?.providerResourceId &&
      providerService?.getServerDetailsAsDto
    ) {
      try {
        const details = await providerService.getServerDetailsAsDto(
          masterNode.providerResourceId,
        );
        currentServerType = details?.server_type;
      } catch (err) {
        this.logger.warn(
          `Failed to fetch master server details for ${masterNode.providerResourceId}: ${(err as Error).message}`,
        );
      }
    }

    let sizes: NodeSizeDto[] = [];
    if (providerService?.getNodeSizes) {
      try {
        sizes = await providerService.getNodeSizes(false);
      } catch (err) {
        this.logger.warn(
          `Provider ${provider} getNodeSizes failed: ${(err as Error).message}`,
        );
      }
    }

    const currentSize = currentServerType
      ? sizes.find((s) => s.name === currentServerType)
      : undefined;

    let master: CapacityMasterDto | undefined;
    if (cluster.kubeconfigEncrypted) {
      const kubeconfig = this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted,
      );
      const cap =
        await this.kubernetesService.getMasterNodeCapacity(kubeconfig);
      if (cap) {
        master = {
          nodeName: cap.nodeName,
          serverType: currentServerType ?? 'unknown',
          allocatableCpuMillicores: cap.allocatable.cpu,
          allocatableMemoryMi: cap.allocatable.memory,
          usedCpuMillicores: cap.requested.cpu,
          usedMemoryMi: cap.requested.memory,
          freeCpuMillicores: cap.allocatable.cpu - cap.requested.cpu,
          freeMemoryMi: cap.allocatable.memory - cap.requested.memory,
          monthlyCostEur: this.pickFirstMonthlyPrice(currentSize),
        };
      }
    }

    const candidates = this.buildCandidates(sizes, currentSize);

    let storage: CapacityStorageDto | undefined;
    try {
      const storageStatus =
        await this.clusterStorageService.getStatus(clusterId);
      if (storageStatus.volume) {
        storage = {
          volumeId: storageStatus.volume.volumeId,
          sizeGb: storageStatus.volume.sizeGb,
          requestedGb: storageStatus.pvcs?.requestedGb,
          pricePerGbMonthlyEur: currentSize?.blockStoragePricePerGbMonthly,
        };
      }
    } catch (err) {
      this.logger.warn(`Storage status unavailable: ${(err as Error).message}`);
    }

    return {
      clusterId,
      provider,
      master,
      candidates,
      storage,
      message: this.buildMessage({
        currentServerType,
        sizesCount: sizes.length,
        hasProvider: !!providerService,
      }),
    };
  }

  private buildCandidates(
    sizes: NodeSizeDto[],
    currentSize: NodeSizeDto | undefined,
  ): CapacityCandidateDto[] {
    if (!sizes.length) return [];

    const currentMonthly = this.parseMonthly(currentSize);
    const candidates: CapacityCandidateDto[] = sizes
      .filter((s) => !s.deprecated)
      .map((s) => {
        const monthly = this.parseMonthly(s);
        let direction: 'upgrade' | 'downgrade' | 'current';
        if (s.name === currentSize?.name) {
          direction = 'current';
        } else if (
          s.cores >= (currentSize?.cores ?? 0) &&
          s.memory >= (currentSize?.memory ?? 0)
        ) {
          direction = 'upgrade';
        } else {
          direction = 'downgrade';
        }
        return {
          name: s.name,
          direction,
          cores: s.cores,
          memoryGb: s.memory,
          diskGb: s.disk,
          monthlyCostEur: monthly === null ? 'n/a' : monthly.toFixed(2),
          monthlyDeltaEur:
            monthly !== null && currentMonthly !== null
              ? (monthly - currentMonthly).toFixed(2)
              : 'n/a',
          cpuType: s.cpuType,
          deprecated: s.deprecated,
        };
      });

    candidates.sort((a, b) => {
      const da = Number.parseFloat(a.monthlyDeltaEur);
      const db = Number.parseFloat(b.monthlyDeltaEur);
      if (Number.isNaN(da) && Number.isNaN(db))
        return a.name.localeCompare(b.name);
      if (Number.isNaN(da)) return 1;
      if (Number.isNaN(db)) return -1;
      return da - db;
    });

    return candidates;
  }

  private pickFirstMonthlyPrice(
    size: NodeSizeDto | undefined,
  ): string | undefined {
    const price = size?.prices?.[0]?.priceMonthly?.net;
    if (!price) return undefined;
    const parsed = Number.parseFloat(price);
    return Number.isFinite(parsed) ? parsed.toFixed(2) : undefined;
  }

  private parseMonthly(size: NodeSizeDto | undefined): number | null {
    const raw = size?.prices?.[0]?.priceMonthly?.net;
    if (!raw) return null;
    const v = Number.parseFloat(raw);
    return Number.isFinite(v) ? v : null;
  }

  private buildMessage(ctx: {
    currentServerType?: string;
    sizesCount: number;
    hasProvider: boolean;
  }): string | undefined {
    if (!ctx.hasProvider) {
      return 'The machines of this cluster were brought rather than bought, so there is no size list and no price: what is shown is the room the cluster has now. Adding capacity means attaching another machine.';
    }
    if (!ctx.currentServerType) {
      return 'Could not resolve current master server type from provider — costs are shown as n/a.';
    }
    if (ctx.sizesCount === 0) {
      return 'Provider did not return any node sizes — upgrade/downgrade candidates unavailable.';
    }
    return undefined;
  }
}
