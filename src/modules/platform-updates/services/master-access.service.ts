import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  CONTROL_CLUSTER_TYPES,
  isControlClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { MasterKind } from './bootstrap-files.service';
import { MasterAccess } from '../interfaces/install-values.interface';

/** The kubeconfig and master node of a cluster, as the platform update reaches them. */
@Injectable()
export class MasterAccessService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly encryptionService: EncryptionService,
  ) {}

  async controlMaster(): Promise<MasterAccess> {
    const cluster = await this.clusterRepository.findOne({
      where: {
        clusterType: In([...CONTROL_CLUSTER_TYPES]),
      },
      relations: ['nodes'],
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new BadRequestException(
        'No control cluster with a kubeconfig is recorded.',
      );
    }
    return this.accessTo(cluster, 'control');
  }

  /** The master of one cluster; without an id, the control cluster's. */
  async masterAccess(clusterId?: string): Promise<MasterAccess> {
    if (!clusterId) return this.controlMaster();
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found.`);
    }
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${cluster.name ?? clusterId} has no kubeconfig recorded.`,
      );
    }
    return this.accessTo(
      cluster,
      isControlClusterType(cluster.clusterType) ? 'control' : 'workload',
    );
  }

  private accessTo(cluster: ClusterEntity, kind: MasterKind): MasterAccess {
    const master = (cluster.nodes ?? []).find((n) => n.nodeType === 'master');
    if (!master?.serverName) {
      throw new BadRequestException(
        `The ${kind} cluster has no master node recorded.`,
      );
    }
    return {
      cluster,
      kubeconfig: this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted as string,
      ),
      node: master.serverName,
      kind,
    };
  }
}
