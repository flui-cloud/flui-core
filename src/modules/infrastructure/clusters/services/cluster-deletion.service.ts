import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScalingGroupEntity } from '../../scaling/entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../../scaling/entities/scaling-decision.entity';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
} from '../entities/cluster.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
  DeleteClusterOperationMetadata,
} from '../../servers/entities/infrastructure-operations.entity';
import { ClusterFirewallIntegrationService } from './cluster-firewall-integration.service';
import { DeleteClusterJobData } from '../clusters.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { GrafanaDatasourceService } from 'src/modules/grafana/services/grafana-datasource.service';
import { ClusterDnsCleanupService } from 'src/modules/dns/services/cluster-dns-cleanup.service';

/**
 * Service responsible for cluster deletion logic
 */
@Injectable()
export class ClusterDeletionService {
  private readonly logger = new Logger(ClusterDeletionService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly clusterFirewallIntegrationService: ClusterFirewallIntegrationService,
    private readonly grafanaDatasourceService: GrafanaDatasourceService,
    private readonly clusterDnsCleanupService: ClusterDnsCleanupService,
    @InjectRepository(ScalingGroupEntity)
    private readonly scalingGroupRepository: Repository<ScalingGroupEntity>,
    @InjectRepository(ScalingDecisionEntity)
    private readonly scalingDecisionRepository: Repository<ScalingDecisionEntity>,
  ) {}

  /**
   * Delete a cluster
   */
  async deleteCluster(
    clusterId: string,
    force: boolean = false,
  ): Promise<InfrastructureOperationEntity> {
    this.logger.log(`Deleting cluster: ${clusterId} (force: ${force})`);

    // Check if cluster exists
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });

    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    // Check if cluster is already being deleted or deleted (allow retry from DELETION_FAILED)
    if (cluster.status === ClusterStatus.DELETING) {
      throw new BadRequestException(
        `Cluster ${clusterId} is currently being deleted. Please wait for the operation to complete.`,
      );
    }

    if (cluster.status === ClusterStatus.DELETED) {
      throw new BadRequestException(
        `Cluster ${clusterId} has already been deleted`,
      );
    }

    // Log retry attempt if status is DELETION_FAILED
    if (cluster.status === ClusterStatus.DELETION_FAILED) {
      this.logger.log(
        `Retrying deletion for cluster ${clusterId} (previous attempt failed: ${cluster.metadata?.deletionError || 'unknown error'})`,
      );
    }

    // Pre-deletion hook: Remove Grafana datasources if this is a workload cluster
    await this.removeClusterFromGrafana(cluster);

    // Update cluster status to DELETING
    cluster.status = ClusterStatus.DELETING;
    await this.clusterRepository.save(cluster);

    // Create operation record
    const operation = this.operationRepository.create({
      operationType: OperationType.DELETE_CLUSTER,
      status: OperationStatus.PENDING,
      resourceType: 'cluster',
      resourceName: cluster.name,
      resourceId: cluster.id,
      metadata: {
        clusterId: cluster.id,
        clusterName: cluster.name,
        nodeCount: cluster.nodes.length,
        force,
        estimatedDurationInSeconds: 80,
      } as DeleteClusterOperationMetadata,
    });

    const savedOperation = await this.operationRepository.save(operation);

    // Queue delete cluster job
    const jobData: DeleteClusterJobData = {
      operationId: savedOperation.id,
      clusterId: cluster.id,
      force,
    };

    await this.infrastructureQueue.add('delete-cluster', jobData, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      timeout: 600000, // 10 minutes
    });

    this.logger.log(
      `Cluster deletion job queued for cluster ${clusterId} with operation ${savedOperation.id}`,
    );

    return savedOperation;
  }

  /**
   * Cleanup cluster firewall during deletion
   * Called from the queue processor after nodes are deleted
   */
  async cleanupClusterFirewall(
    clusterId: string,
    provider: CloudProvider,
  ): Promise<void> {
    this.logger.log(`Cleaning up firewall for cluster ${clusterId}`);

    try {
      await this.clusterFirewallIntegrationService.deleteClusterFirewall(
        clusterId,
        provider,
      );
      this.logger.log(`Firewall cleanup completed for cluster ${clusterId}`);
    } catch (error) {
      // Log error but don't fail cluster deletion
      this.logger.error(
        `Failed to cleanup firewall for cluster ${clusterId}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * The scaling groups of a cluster that is going away, and their decisions.
   *
   * Neither carries a foreign key — the sibling tables do not either — so
   * nothing removes them on its own. A group whose cluster is gone is not
   * harmful: the loop skips it and the overview lists clusters, so it never
   * appears. That is exactly why it has to be swept here — it accumulates
   * where nobody looks.
   *
   * Decisions go with the group, as they already do when a group is deleted on
   * its own: a decision is a thing the group saw and chose, and it does not
   * outlive it.
   */
  async cleanupClusterScalingGroups(clusterId: string): Promise<void> {
    const decisions = await this.scalingDecisionRepository.delete({
      clusterId,
    });
    const groups = await this.scalingGroupRepository.delete({ clusterId });
    if (groups.affected || decisions.affected) {
      this.logger.log(
        `Removed ${groups.affected ?? 0} scaling group(s) and ${decisions.affected ?? 0} decision(s) of cluster ${clusterId}`,
      );
    }
  }

  async cleanupClusterDnsRecords(clusterId: string): Promise<void> {
    this.logger.log(`Cleaning up DNS records for cluster ${clusterId}`);

    try {
      const deleted =
        await this.clusterDnsCleanupService.deleteRecordsByClusterId(clusterId);
      this.logger.log(
        `DNS cleanup completed for cluster ${clusterId} (${deleted} record(s) removed)`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to cleanup DNS records for cluster ${clusterId}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Remove workload cluster datasources from Grafana control cluster
   * Called automatically before cluster deletion
   */
  private async removeClusterFromGrafana(
    cluster: ClusterEntity,
  ): Promise<void> {
    // Only remove datasources for WORKLOAD clusters (not control clusters)
    if (cluster.clusterType !== ClusterType.WORKLOAD) {
      this.logger.debug(
        `Skipping Grafana datasource removal for ${cluster.clusterType} cluster ${cluster.name}`,
      );
      return;
    }

    try {
      this.logger.log(
        `Removing cluster ${cluster.name} datasources from Grafana`,
      );

      // Remove datasources from Grafana
      await this.grafanaDatasourceService.removeClusterDatasources(cluster.id);

      this.logger.log(
        `✅ Cluster ${cluster.name} datasources removed from Grafana`,
      );
    } catch (error) {
      // Log error but don't fail cluster deletion
      this.logger.warn(
        `Failed to remove cluster ${cluster.name} from Grafana: ${error.message}`,
      );
      this.logger.warn(
        'Cluster deletion will proceed - Grafana datasources may need manual cleanup',
      );
    }
  }
}
