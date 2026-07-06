import { Processor, Process, InjectQueue } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CreateClusterJobData,
  DeleteClusterJobData,
  StopClusterJobData,
  StartClusterJobData,
} from '../clusters.service';
import { AttachClusterToVNetJobData } from '../services/cluster-vnet.service';
import {
  AddWorkerJobData,
  RemoveWorkerJobData,
} from '../services/cluster-scaling.service';
import { SubnetsService } from '../../vnets/services/subnets.service';
import { VNetsService } from '../../vnets/services/vnets.service';
import { NativeSSHConnectionService } from 'src/modules/terminal/services/native-ssh-connection.service';
import { AccessService } from 'src/modules/access/services/access.service';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeStatus } from '../entities/cluster-node.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
  CreateClusterOperationMetadata,
} from '../../servers/entities/infrastructure-operations.entity';
import { ClusterOrchestrationService } from '../services/cluster-orchestration.service';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { BillingIntervalsService } from '../services/billing-intervals.service';
import { ServersService } from '../../servers/services/servers.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { ProviderFactory } from 'src/modules/providers';
import {
  calculateOperationProgressFromSaved,
  getStepConfigFromSaved,
} from '../../operations/helpers/operation-steps.helper';
import { ClusterDeletionService } from '../services/cluster-deletion.service';
import { ClusterPowerManagementService } from '../services/cluster-power-management.service';
import { ClusterSshCleanupService } from '../services/cluster-ssh-cleanup.service';
import { GrafanaDatasourceService } from 'src/modules/grafana/services/grafana-datasource.service';
import { GrafanaConfigService } from 'src/modules/grafana/services/grafana-config.service';
import { InfrastructureOperationsGateway } from '../../operations/gateway/infrastructure-operations.gateway';
import { ClusterDnsZoneService } from '../../../dns/services/cluster-dns-zone.service';
import { HostnameMode } from '../../../dns/enums/hostname-mode.enum';
import {
  InfrastructureOperationProgressDto,
  InfrastructureOperationCompletedDto,
  InfrastructureOperationFailedDto,
} from '../../operations/dto/infrastructure-operation-events.dto';

@Processor('infrastructure')
export class ClusterQueueProcessor {
  private readonly logger = new Logger(ClusterQueueProcessor.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly orchestrationService: ClusterOrchestrationService,
    private readonly serversService: ServersService,
    private readonly clusterDeletionService: ClusterDeletionService,
    private readonly clusterPowerManagementService: ClusterPowerManagementService,
    private readonly clusterSshCleanupService: ClusterSshCleanupService,
    private readonly grafanaDatasourceService: GrafanaDatasourceService,
    private readonly grafanaConfigService: GrafanaConfigService,
    private readonly infraGateway: InfrastructureOperationsGateway,
    private readonly subnetsService: SubnetsService,
    private readonly vnetsService: VNetsService,
    private readonly nativeSsh: NativeSSHConnectionService,
    private readonly accessService: AccessService,
    private readonly clusterDnsZoneService: ClusterDnsZoneService,
    private readonly billingIntervals: BillingIntervalsService,
    private readonly providerFactory: ProviderFactory,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  private formatVolumeRef(
    volumeId: string,
    provider: string,
    region: string,
  ): string {
    if (provider !== 'scaleway') return volumeId;
    if (volumeId.includes(':')) return volumeId;
    const zone = /^[a-z]{2}-[a-z]{3}$/.test(region) ? `${region}-1` : region;
    return `${zone}:${volumeId}`;
  }

  private async cleanupSharedVolume(
    cluster: ClusterEntity,
    force: boolean,
  ): Promise<void> {
    const rawId = cluster.sharedStorageVolumeId;
    if (!rawId) return;
    const volumeId = this.formatVolumeRef(
      rawId,
      cluster.provider,
      cluster.region,
    );
    try {
      const provider = this.providerFactory.getProvider(
        cluster.provider as CloudProvider,
      );
      if (provider.detachVolume) {
        try {
          await provider.detachVolume(volumeId);
        } catch (err) {
          this.logger.warn(
            `Detach failed for volume ${volumeId}: ${(err as Error).message}`,
          );
        }
      }
      if (provider.deleteVolume) {
        await provider.deleteVolume(volumeId);
        this.logger.log(
          `✅ Deleted shared storage volume ${volumeId} for cluster ${cluster.id}`,
        );
      } else {
        this.logger.warn(
          `Provider ${cluster.provider} has no deleteVolume — volume ${volumeId} left at provider`,
        );
      }
    } catch (err) {
      const msg = `Failed to delete shared storage volume ${volumeId}: ${(err as Error).message}`;
      if (force) {
        this.logger.warn(`${msg} (force mode, continuing)`);
      } else {
        this.logger.error(msg);
        throw new Error(msg);
      }
    }
  }

  private async bootstrapIpModeIssuers(cluster: ClusterEntity): Promise<void> {
    if (
      cluster.clusterType !== ClusterType.WORKLOAD ||
      cluster.endpointHostnameMode !== HostnameMode.IP
    ) {
      return;
    }
    const acmeEmail = process.env.ADMIN_EMAIL;
    if (!acmeEmail) {
      this.logger.warn(
        `Skipping HTTP ClusterIssuer bootstrap for cluster ${cluster.id}: ` +
          `ADMIN_EMAIL not set. Per-app TLS endpoints will fail until ` +
          `issuers are configured via POST /cluster-dns-zones/:id/issuer/http.`,
      );
      return;
    }
    try {
      await this.clusterDnsZoneService.bootstrapHttpIssuersForCluster(
        cluster.id,
        acmeEmail,
      );
      this.logger.log(
        `Bootstrapped HTTP ClusterIssuers for IP-mode cluster ${cluster.id}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Failed to bootstrap HTTP ClusterIssuers for cluster ${cluster.id}: ${message}`,
      );
    }
  }

  @Process('create-cluster')
  async handleCreateCluster(job: Job<CreateClusterJobData>): Promise<void> {
    const { operationId, clusterId } = job.data;
    this.logger.log(
      `Processing create cluster job: ${job.id} (cluster: ${clusterId})`,
    );

    try {
      // Load operation to get metadata and steps
      const operation = await this.operationRepository.findOne({
        where: { id: operationId },
      });

      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      const workerCount =
        (operation.metadata as CreateClusterOperationMetadata)?.workerCount ||
        0;
      const isSingleNode = workerCount === 0;

      // Updated: Use providerFirewallId (string) instead of providerFirewallIds (array)
      const providerFirewallId = (
        operation.metadata as CreateClusterOperationMetadata
      )?.providerFirewallId;

      const providerFirewallIds = providerFirewallId
        ? [providerFirewallId]
        : [];

      this.logger.log(
        `Creating cluster: 1 master + ${workerCount} workers (${isSingleNode ? 'single-node' : 'multi-node'})` +
          (providerFirewallIds.length > 0
            ? ` with firewall IDs: ${JSON.stringify(providerFirewallIds)}`
            : ' — NO firewall IDs (firewall may not have been created)'),
      );

      // Load cluster entity
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
      });

      if (!cluster) {
        throw new Error(`Cluster ${clusterId} not found`);
      }

      // Reset status to CREATING in case this is a Bull retry after a previous failed attempt
      if (cluster.status === ClusterStatus.ERROR) {
        cluster.status = ClusterStatus.CREATING;
        await this.clusterRepository.save(cluster);
      }

      const totalSteps = isSingleNode ? 4 : 5;
      const startedAt = Date.now();

      // === STEP 0: INIT (5%) ===
      await this.updateOperationStep(operationId, 0, 100, {
        status: OperationStatus.IN_PROGRESS,
        message: 'Cluster creation initialized',
        clusterId,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.CREATE_CLUSTER,
        resourceType: 'cluster',
        percentage: 5,
        currentStepIndex: 0,
        totalSteps,
        message: 'Cluster creation initialized',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      // === STEP 1: CREATE MASTER (includes K3s wait) ===
      await this.updateOperationStep(operationId, 1, 0, {
        message: 'Creating master node and waiting for K3s',
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.CREATE_CLUSTER,
        resourceType: 'cluster',
        percentage: 5,
        currentStepIndex: 1,
        totalSteps,
        message: 'Creating master node and waiting for K3s...',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      const masterNode = await this.orchestrationService.createMasterNode(
        cluster,
        operationId,
        providerFirewallIds,
      );

      await this.updateOperationStep(operationId, 1, 100, {
        message: 'Master node created and K3s ready',
        masterIp: masterNode.ipAddress,
        masterNodeId: masterNode.id,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.CREATE_CLUSTER,
        resourceType: 'cluster',
        percentage: isSingleNode ? 60 : 25,
        currentStepIndex: 1,
        totalSteps,
        message: 'Master node ready',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      cluster.nodeCount = 1;
      await this.clusterRepository.save(cluster);

      // === STEP 2 (all topologies): KUBECONFIG ===
      await this.updateOperationStep(operationId, 2, 50, {
        message: 'Fetching kubeconfig from master node',
        masterIp: masterNode.ipAddress,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.CREATE_CLUSTER,
        resourceType: 'cluster',
        percentage: isSingleNode ? 73 : 33,
        currentStepIndex: 2,
        totalSteps,
        message: 'Fetching kubeconfig...',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      // kubeconfig was already fetched inside createMasterNode — just mark step complete
      await this.updateOperationStep(operationId, 2, 100, {
        message: 'Kubeconfig fetched and stored',
        kubeconfigStored: true,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.CREATE_CLUSTER,
        resourceType: 'cluster',
        percentage: isSingleNode ? 90 : 55,
        currentStepIndex: 2,
        totalSteps,
        message: 'Kubeconfig stored',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      if (isSingleNode) {
        // === SINGLE-NODE: STEP 3 = FINALIZE ===
        await this.updateOperationStep(operationId, 3, 50, {
          message: 'Finalizing single-node cluster',
        });

        cluster.status = ClusterStatus.READY;
        await this.clusterRepository.save(cluster);

        if (cluster.metadata?.vnetConfig?.vnetId) {
          await this.vnetsService.ensureClusterIdLabel(
            cluster.metadata.vnetConfig.vnetId,
            clusterId,
          );
        }

        await this.bootstrapIpModeIssuers(cluster);

        // Post-creation hook: Register in Grafana if this is a workload cluster
        await this.registerClusterInGrafana(cluster);

        await this.updateOperationStep(operationId, 3, 100, {
          status: OperationStatus.COMPLETED,
          message: 'Single-node cluster ready',
          clusterName: cluster.name,
          masterIp: cluster.masterIpAddress,
          nodeCount: 1,
          completedAt: new Date().toISOString(),
        });
        this.infraGateway.emitCompleted(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.CREATE_CLUSTER,
          resourceType: 'cluster',
          duration: Date.now() - startedAt,
          timestamp: new Date(),
        } as InfrastructureOperationCompletedDto);

        this.logger.log(
          `✅ Single-node cluster ${cluster.name} created successfully`,
        );
      } else {
        // === MULTI-NODE: STEP 3 = CREATE WORKERS ===
        await this.updateOperationStep(operationId, 3, 0, {
          message: `Creating ${workerCount} worker nodes`,
          targetWorkerCount: workerCount,
        });
        this.infraGateway.emitProgress(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.CREATE_CLUSTER,
          resourceType: 'cluster',
          percentage: 55,
          currentStepIndex: 3,
          totalSteps,
          message: `Creating ${workerCount} worker node${workerCount > 1 ? 's' : ''}...`,
          timestamp: new Date(),
        } as InfrastructureOperationProgressDto);

        await this.orchestrationService.createWorkerNodes(
          cluster,
          workerCount,
          operationId,
          providerFirewallIds,
        );

        await this.updateOperationStep(operationId, 3, 100, {
          message: `All ${workerCount} worker nodes created`,
        });
        this.infraGateway.emitProgress(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.CREATE_CLUSTER,
          resourceType: 'cluster',
          percentage: 90,
          currentStepIndex: 3,
          totalSteps,
          message: `All ${workerCount} worker node${workerCount > 1 ? 's' : ''} ready`,
          timestamp: new Date(),
        } as InfrastructureOperationProgressDto);

        cluster.nodeCount = 1 + workerCount;
        await this.clusterRepository.save(cluster);

        // === MULTI-NODE: STEP 4 = FINALIZE ===
        await this.updateOperationStep(operationId, 4, 50, {
          message: 'Finalizing multi-node cluster',
        });

        cluster.status = ClusterStatus.READY;
        await this.clusterRepository.save(cluster);

        if (cluster.metadata?.vnetConfig?.vnetId) {
          await this.vnetsService.ensureClusterIdLabel(
            cluster.metadata.vnetConfig.vnetId,
            clusterId,
          );
        }

        await this.bootstrapIpModeIssuers(cluster);

        // Post-creation hook: Register in Grafana if this is a workload cluster
        await this.registerClusterInGrafana(cluster);

        // Master-protection: a control cluster created multi-node starts protected.
        await this.maybeProtectMasterOnScaleOut(cluster, 1, workerCount);

        await this.updateOperationStep(operationId, 4, 100, {
          status: OperationStatus.COMPLETED,
          message: 'Multi-node cluster ready',
          clusterName: cluster.name,
          masterIp: cluster.masterIpAddress,
          nodeCount: cluster.nodeCount,
          workerCount,
          completedAt: new Date().toISOString(),
        });
        this.infraGateway.emitCompleted(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.CREATE_CLUSTER,
          resourceType: 'cluster',
          duration: Date.now() - startedAt,
          timestamp: new Date(),
        } as InfrastructureOperationCompletedDto);

        this.logger.log(
          `✅ Multi-node cluster ${cluster.name} created successfully with ${cluster.nodeCount} nodes`,
        );
      }
    } catch (error) {
      this.logger.error(
        `❌ Cluster creation failed for ${clusterId}: ${error.message}`,
        error.stack,
      );

      // Update operation as failed
      const failedOp = await this.operationRepository.findOne({
        where: { id: operationId },
      });
      if (failedOp) {
        failedOp.status = OperationStatus.FAILED;
        failedOp.errorMessage = error.message;
        failedOp.completedAt = new Date();
        failedOp.metadata = {
          ...failedOp.metadata,
          error: error.message,
          stack: error.stack,
          clusterId,
          failedAt: new Date().toISOString(),
        };
        await this.operationRepository.save(failedOp);
      }

      this.infraGateway.emitFailed(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.CREATE_CLUSTER,
        resourceType: 'cluster',
        error: error.message,
        timestamp: new Date(),
      } as InfrastructureOperationFailedDto);

      // Update cluster status to error
      const errorCluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
      });
      if (errorCluster) {
        errorCluster.status = ClusterStatus.ERROR;
        errorCluster.metadata = {
          ...errorCluster.metadata,
          error: error.message,
          failedAt: new Date().toISOString(),
        };
        await this.clusterRepository.save(errorCluster);
      }

      throw error; // Re-throw for Bull to handle retries
    }
  }

  /**
   * Process delete cluster job
   */
  @Process('delete-cluster')
  async handleDeleteCluster(job: Job<DeleteClusterJobData>): Promise<void> {
    const { operationId, clusterId, force } = job.data;

    this.logger.log(
      `Processing delete cluster job for cluster ${clusterId}, operation ${operationId}`,
    );

    const startedAt = Date.now();

    try {
      // Update operation to IN_PROGRESS
      await this.updateOperationStatus(
        operationId,
        OperationStatus.IN_PROGRESS,
        {
          message: 'Starting cluster deletion...',
          progress: 0,
        },
      );
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.DELETE_CLUSTER,
        resourceType: 'cluster',
        percentage: 0,
        currentStepIndex: 0,
        totalSteps: 4,
        message: 'Starting cluster deletion...',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      // Load cluster with nodes
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
        relations: ['nodes'],
      });

      if (!cluster) {
        throw new Error(`Cluster ${clusterId} not found`);
      }

      this.logger.log(
        `Deleting cluster ${cluster.name} with ${cluster.nodes.length} nodes`,
      );

      await this.updateOperationStatus(
        operationId,
        OperationStatus.IN_PROGRESS,
        {
          message: `Deleting ${cluster.nodes.length} cluster nodes...`,
          progress: 10,
        },
      );
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.DELETE_CLUSTER,
        resourceType: 'cluster',
        percentage: 10,
        currentStepIndex: 1,
        totalSteps: 4,
        message: `Deleting ${cluster.nodes.length} cluster nodes...`,
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      // Delete all nodes in parallel
      const deleteOperations = await this.deleteClusterNodes(
        cluster,
        operationId,
        force,
      );

      // Check if there are any operations to wait for
      if (deleteOperations.length > 0) {
        await this.updateOperationStatus(
          operationId,
          OperationStatus.IN_PROGRESS,
          {
            message: 'All node deletions queued, waiting for completion...',
            progress: 50,
            deleteOperations: deleteOperations.map((op) => ({
              nodeId: op.nodeId,
              nodeName: op.nodeName,
              operationId: op.operationId,
            })),
          },
        );
        this.infraGateway.emitProgress(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.DELETE_CLUSTER,
          resourceType: 'cluster',
          percentage: 50,
          currentStepIndex: 2,
          totalSteps: 4,
          message: 'All node deletions queued, waiting for completion...',
          timestamp: new Date(),
        } as InfrastructureOperationProgressDto);

        // Wait for all delete operations to complete
        await this.waitForAllDeletions(
          deleteOperations,
          operationId,
          600000,
          force,
        );

        this.infraGateway.emitProgress(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.DELETE_CLUSTER,
          resourceType: 'cluster',
          percentage: 75,
          currentStepIndex: 2,
          totalSteps: 4,
          message: 'All nodes deleted, running cleanup...',
          timestamp: new Date(),
        } as InfrastructureOperationProgressDto);
      } else {
        // No operations to wait for (all nodes were DB-only or deleted in force mode)
        this.logger.log(
          'No provider resources to delete (all nodes were database-only or force deleted)',
        );

        await this.updateOperationStatus(
          operationId,
          OperationStatus.IN_PROGRESS,
          {
            message:
              'No provider resources to delete, proceeding to cleanup...',
            progress: 80,
          },
        );
        this.infraGateway.emitProgress(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.DELETE_CLUSTER,
          resourceType: 'cluster',
          percentage: 80,
          currentStepIndex: 2,
          totalSteps: 4,
          message: 'No provider resources to delete, proceeding to cleanup...',
          timestamp: new Date(),
        } as InfrastructureOperationProgressDto);
      }

      await this.updateOperationStatus(
        operationId,
        OperationStatus.IN_PROGRESS,
        {
          message: 'All nodes deleted, cleaning up cluster record...',
          progress: 90,
        },
      );
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.DELETE_CLUSTER,
        resourceType: 'cluster',
        percentage: 90,
        currentStepIndex: 3,
        totalSteps: 4,
        message: 'All nodes deleted, cleaning up cluster record...',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      // Reload cluster to get fresh node list (some might have been deleted during force mode)
      const clusterToDelete = await this.clusterRepository.findOne({
        where: { id: clusterId },
        relations: ['nodes'],
      });

      if (clusterToDelete) {
        // If force mode and nodes still exist, delete them from DB
        if (force && clusterToDelete.nodes.length > 0) {
          this.logger.warn(
            `Force mode: Deleting ${clusterToDelete.nodes.length} remaining nodes from database`,
          );
          for (const node of clusterToDelete.nodes) {
            try {
              await this.billingIntervals.closeNodeIntervals(node.id);
              await this.nodeRepository.remove(node);
            } catch (error) {
              this.logger.error(
                `Failed to remove node ${node.id} from DB: ${error.message}`,
              );
            }
          }
        }

        // Verify all servers are deleted from provider before removing firewalls
        if (!force) {
          this.logger.log(
            `Verifying servers deleted from provider before removing firewalls`,
          );
          try {
            await this.verifyServersDeleted(clusterToDelete, operationId);
          } catch (error) {
            this.logger.error(
              `Failed to verify servers deleted: ${error.message}`,
            );
            throw error; // Stop cluster deletion if verification fails
          }
        }

        if (clusterToDelete.sharedStorageVolumeId) {
          await this.cleanupSharedVolume(clusterToDelete, force);
          await this.billingIntervals.closeVolumeIntervals(
            clusterToDelete.sharedStorageVolumeId,
          );
        }

        // Clean up SSH keys (bootstrap keys for cluster and nodes)
        this.logger.log(`Cleaning up SSH keys for cluster ${clusterId}`);
        await this.updateOperationStatus(
          operationId,
          OperationStatus.IN_PROGRESS,
          {
            message: 'Cleaning up SSH bootstrap keys...',
            progress: 85,
          },
        );

        try {
          await this.clusterSshCleanupService.cleanupClusterSSHKeys(
            clusterId,
            force,
          );
          this.logger.log(`SSH keys cleaned up for cluster ${clusterId}`);
        } catch (error) {
          // Log error but don't fail cluster deletion
          this.logger.error(
            `Failed to cleanup SSH keys for cluster ${clusterId}: ${error.message}`,
            error.stack,
          );
          if (!force) {
            // In non-force mode, this is a critical error
            throw error;
          }
          this.logger.warn(
            'Force mode: Continuing cluster deletion despite SSH key cleanup failure',
          );
        }

        // Delete cluster firewall using new deletion service
        this.logger.log(`Deleting firewall for cluster ${clusterId}`);
        await this.clusterDeletionService.cleanupClusterFirewall(
          clusterId,
          clusterToDelete.provider as CloudProvider,
        );

        // Delete DNS records tagged with this cluster's ID
        await this.clusterDeletionService.cleanupClusterDnsRecords(clusterId);

        // Update cluster status to DELETED
        clusterToDelete.status = ClusterStatus.DELETED;
        clusterToDelete.deletedAt = new Date();
        await this.clusterRepository.save(clusterToDelete);
      }

      // Mark operation as completed
      await this.updateOperationStatus(operationId, OperationStatus.COMPLETED, {
        message: 'Cluster deleted successfully',
        progress: 100,
        deletedAt: new Date().toISOString(),
        forcedDeletion: force,
      });
      this.infraGateway.emitCompleted(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.DELETE_CLUSTER,
        resourceType: 'cluster',
        duration: Date.now() - startedAt,
        timestamp: new Date(),
      } as InfrastructureOperationCompletedDto);

      this.logger.log(`Cluster ${cluster.name} deleted successfully`);
    } catch (error) {
      this.logger.error(
        `Failed to delete cluster ${clusterId}:`,
        error.stack || error.message,
      );

      // Update operation status to failed
      await this.updateOperationStatus(operationId, OperationStatus.FAILED, {
        message: `Cluster deletion failed: ${error.message}`,
        error: error.message,
        failedAt: new Date().toISOString(),
      });
      this.infraGateway.emitFailed(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.DELETE_CLUSTER,
        resourceType: 'cluster',
        error: error.message,
        timestamp: new Date(),
      } as InfrastructureOperationFailedDto);

      // Update cluster status to DELETION_FAILED (allows retry)
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
      });
      if (cluster) {
        cluster.status = ClusterStatus.DELETION_FAILED;
        cluster.metadata = {
          ...cluster.metadata,
          deletionError: error.message,
          deletionFailedAt: new Date().toISOString(),
        };
        await this.clusterRepository.save(cluster);
      }

      throw error;
    }
  }

  /**
   * Delete all cluster nodes in parallel
   */
  private async deleteClusterNodes(
    cluster: ClusterEntity,
    operationId: string,
    force: boolean,
  ): Promise<Array<{ nodeId: string; nodeName: string; operationId: string }>> {
    const deleteOperations: Array<{
      nodeId: string;
      nodeName: string;
      operationId: string;
    }> = [];

    for (const node of cluster.nodes) {
      try {
        // If node has no providerResourceId, it was never created - just delete from DB
        if (!node.providerResourceId) {
          this.logger.warn(
            `Node ${node.serverName} has no providerResourceId (never created), deleting from database only`,
          );

          // Delete node from database immediately
          await this.billingIntervals.closeNodeIntervals(node.id);
          await this.nodeRepository.remove(node);

          this.logger.log(`Node ${node.serverName} removed from database`);
          continue; // Skip to next node
        }

        // Validate node ownership before deletion (unless force=true)
        if (!force) {
          this.logger.log(
            `Validating ownership for node ${node.serverName} (${node.providerResourceId})`,
          );

          await this.serversService.validateServerOwnership(
            node.providerResourceId,
            cluster.provider as CloudProvider,
            `Cannot delete cluster node ${node.serverName}. Node is not managed by Flui.`,
          );
        }

        // Update node status to DELETING
        node.status = NodeStatus.DELETING;
        await this.nodeRepository.save(node);

        // Queue delete-server job for nodes that exist on provider.
        // Use serversService.deleteServer() so that an InfrastructureOperationEntity
        // is created in the database before the job is enqueued. Without the DB record,
        // waitForAllDeletions() cannot observe the job result and silently treats the
        // node as deleted (operation-not-found → assuming completed).
        const savedOperation = await this.serversService.deleteServer({
          server_id: node.providerResourceId,
          provider: cluster.provider as CloudProvider,
          force,
        });

        deleteOperations.push({
          nodeId: node.id,
          nodeName: node.serverName,
          operationId: savedOperation.id,
        });

        this.logger.log(
          `Queued deletion for node ${node.serverName} (operation: ${savedOperation.id})`,
        );
      } catch (error) {
        // With force=true, log error but continue
        if (force) {
          this.logger.warn(
            `Failed to delete node ${node.serverName} (force mode, continuing): ${error.message}`,
          );

          // Delete from database anyway in force mode
          try {
            await this.billingIntervals.closeNodeIntervals(node.id);
            await this.nodeRepository.remove(node);
            this.logger.log(
              `Node ${node.serverName} forcefully removed from database`,
            );
          } catch (dbError) {
            this.logger.error(
              `Failed to remove node from DB: ${dbError.message}`,
            );
          }

          continue; // Continue to next node
        }

        // Without force, fail the entire operation
        this.logger.error(
          `Failed to queue deletion for node ${node.serverName}:`,
          error.message,
        );
        throw new Error(
          `Failed to delete node ${node.serverName}: ${error.message}`,
        );
      }
    }

    // Orphan sweep: a server can exist on the provider without a usable node
    // record — e.g. creation crashed after the provider made the server but
    // before its id was persisted. Node-based deletion can't see those, so match
    // by Flui's cluster-id label to guarantee nothing of THIS cluster survives.
    await this.sweepOrphanedProviderServers(cluster, deleteOperations);

    return deleteOperations;
  }

  /**
   * Delete provider servers that belong to this cluster (by Flui labels) but are
   * not tracked as deletable nodes, so a failed/partial create can't leave an
   * orphan the user must clean up by hand.
   */
  private async sweepOrphanedProviderServers(
    cluster: ClusterEntity,
    deleteOperations: Array<{
      nodeId: string;
      nodeName: string;
      operationId: string;
    }>,
  ): Promise<void> {
    try {
      const provider = cluster.provider as CloudProvider;
      const handledIds = new Set(
        cluster.nodes
          .map((n) => n.providerResourceId)
          .filter((id): id is string => !!id),
      );

      const servers = await this.serversService.getServersByProvider(provider);
      const orphans = servers.filter((s) => {
        if (!s.id || handledIds.has(s.id)) return false;
        const labels = s.labels ?? [];
        const managed =
          labels.find((l) => l.key === 'managed-by')?.value === 'flui-cloud';
        if (!managed) return false;
        // Match STRICTLY by cluster-id (UUID). Never by name: names are reused
        // across retries AND across separate Flui installations sharing the same
        // provider account (flui-environment is a constant), so a name match
        // could force-delete another installation's servers.
        const cid = labels.find((l) => l.key === 'flui-cluster-id')?.value;
        return cid === cluster.id;
      });

      for (const orphan of orphans) {
        this.logger.warn(
          `Sweeping orphaned ${provider} server ${orphan.name} (${orphan.id}) — belongs to cluster ${cluster.name} but is not tracked as a node`,
        );
        try {
          const op = await this.serversService.deleteServer({
            server_id: orphan.id,
            provider,
            force: true,
          });
          deleteOperations.push({
            nodeId: `orphan:${orphan.id}`,
            nodeName: orphan.name,
            operationId: op.id,
          });
        } catch (err: any) {
          this.logger.error(
            `Failed to sweep orphaned server ${orphan.name} (${orphan.id}): ${err?.message ?? err}`,
          );
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Orphan server sweep skipped for cluster ${cluster.name}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Wait for all delete operations to complete
   */
  private async waitForAllDeletions(
    deleteOperations: Array<{
      nodeId: string;
      nodeName: string;
      operationId: string;
    }>,
    parentOperationId: string,
    maxWaitTime: number = 600000, // 10 minutes
    force: boolean = false,
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 10000; // 10 seconds
    const pendingOps = new Set(deleteOperations.map((op) => op.operationId));
    const failedOps: string[] = [];

    this.logger.log(
      `Waiting for ${deleteOperations.length} delete operations to complete...`,
    );

    while (pendingOps.size > 0 && Date.now() - startTime < maxWaitTime) {
      for (const opId of Array.from(pendingOps)) {
        try {
          const operation = await this.operationRepository.findOne({
            where: { id: opId },
          });

          if (!operation) {
            // Operation record not found in DB — treat as failure rather than silently
            // assuming success. If force=true we log and continue; otherwise we stop.
            const opInfo = deleteOperations.find(
              (op) => op.operationId === opId,
            );
            if (force) {
              this.logger.warn(
                `Operation ${opId} not found in DB for node ${opInfo?.nodeName} (force mode, treating as failed)`,
              );
              pendingOps.delete(opId);
              failedOps.push(opId);
            } else {
              throw new Error(
                `Operation ${opId} not found in DB for node ${opInfo?.nodeName}. Cannot verify server deletion.`,
              );
            }
            continue;
          }

          if (
            operation.status === OperationStatus.COMPLETED ||
            operation.status === OperationStatus.FAILED
          ) {
            const opInfo = deleteOperations.find(
              (op) => op.operationId === opId,
            );
            this.logger.log(
              `Node deletion ${opInfo?.nodeName} ${operation.status} (${opId})`,
            );
            pendingOps.delete(opId);

            if (operation.status === OperationStatus.FAILED) {
              failedOps.push(opId);

              // With force=true, log but continue
              if (force) {
                this.logger.warn(
                  `Node deletion failed for ${opInfo?.nodeName} (force mode, continuing): ${operation.metadata?.error || 'Unknown error'}`,
                );
              } else {
                // Without force, throw error
                throw new Error(
                  `Node deletion failed for ${opInfo?.nodeName}: ${operation.metadata?.error || 'Unknown error'}`,
                );
              }
            }
          }
        } catch (error) {
          // With force, log and continue
          if (force) {
            this.logger.error(
              `Error checking operation ${opId} (force mode, continuing):`,
              error.message,
            );
            pendingOps.delete(opId); // Remove from pending to avoid infinite loop
            failedOps.push(opId);
          } else {
            this.logger.error(
              `Error checking operation ${opId}:`,
              error.message,
            );
            throw error;
          }
        }
      }

      if (pendingOps.size > 0) {
        const progress = Math.floor(
          50 +
            ((deleteOperations.length - pendingOps.size) /
              deleteOperations.length) *
              40,
        );
        await this.updateOperationStatus(
          parentOperationId,
          OperationStatus.IN_PROGRESS,
          {
            message: `Waiting for node deletions... (${deleteOperations.length - pendingOps.size}/${deleteOperations.length} completed)`,
            progress,
          },
        );

        this.logger.debug(
          `Still waiting for ${pendingOps.size} operations to complete...`,
        );
        await this.sleep(checkInterval);
      }
    }

    if (pendingOps.size > 0) {
      // With force, log warning but continue
      if (force) {
        this.logger.warn(
          `Timeout waiting for node deletions (force mode, continuing). ${pendingOps.size} operations still pending.`,
        );
      } else {
        throw new Error(
          `Timeout waiting for node deletions. ${pendingOps.size} operations still pending.`,
        );
      }
    }

    if (failedOps.length > 0 && force) {
      this.logger.warn(
        `${failedOps.length} operations failed but continuing due to force mode`,
      );
    }

    this.logger.log('All delete operations completed or skipped (force mode)');
  }

  /**
   * Update operation step helper
   */
  private async updateOperationStep(
    operationId: string,
    stepIndex: number,
    stepProgress: number,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });

    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    // Get saved steps from metadata
    const savedSteps = operation.metadata?.operationSteps || [];

    const stepConfig = getStepConfigFromSaved(savedSteps, stepIndex);
    if (!stepConfig) {
      throw new Error(
        `Invalid step index ${stepIndex} for operation ${operationId}`,
      );
    }

    const overallProgress = calculateOperationProgressFromSaved(
      savedSteps,
      stepIndex,
      stepProgress,
    );

    operation.currentStep = stepConfig.step;
    operation.currentStepIndex = stepIndex;
    operation.totalSteps = savedSteps.length;
    operation.currentStepProgress = stepProgress;
    operation.progress = overallProgress;

    // Update status if provided in metadata
    if (metadata.status) {
      operation.status = metadata.status;
      if (
        metadata.status === OperationStatus.IN_PROGRESS &&
        !operation.startedAt
      ) {
        operation.startedAt = new Date();
      }
      if (metadata.status === OperationStatus.COMPLETED) {
        operation.completedAt = new Date();
      }
    }

    operation.metadata = {
      ...operation.metadata,
      ...metadata,
      stepDescription: stepConfig.description,
      stepWeight: stepConfig.weight,
    };

    await this.operationRepository.save(operation);
  }

  /**
   * Update operation status helper (legacy, kept for delete operations)
   */
  private async updateOperationStatus(
    operationId: string,
    status: OperationStatus,
    metadata: Record<string, any> = {},
  ): Promise<void> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (operation) {
      operation.status = status;
      operation.metadata = { ...operation.metadata, ...metadata };
      operation.updatedAt = new Date();
      await this.operationRepository.save(operation);
    }
  }

  /**
   * Verify all cluster servers are deleted from provider (404 status)
   * This ensures firewalls can be safely deleted without "resource_in_use" errors
   */
  private async verifyServersDeleted(
    cluster: ClusterEntity,
    operationId: string,
    maxWaitTime: number = 120000, // 2 minutes
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 10000; // 10 seconds

    this.logger.log(
      `Verifying ${cluster.nodes.length} servers deleted from provider`,
    );

    while (Date.now() - startTime < maxWaitTime) {
      let allDeleted = true;

      for (const node of cluster.nodes) {
        if (!node.providerResourceId) {
          continue; // Skip DB-only nodes
        }

        try {
          const status = await this.serversService.checkServerStatus(
            node.providerResourceId,
            cluster.provider as CloudProvider,
          );

          if (status !== 'not-found') {
            allDeleted = false;
            this.logger.debug(
              `Server ${node.serverName} (${node.providerResourceId}) still exists: ${status}`,
            );
            break; // Exit node loop, wait and retry
          }
        } catch (error) {
          this.logger.warn(`Error checking server status: ${error.message}`);
          allDeleted = false;
          break;
        }
      }

      if (allDeleted) {
        this.logger.log('All servers verified as deleted from provider');
        return;
      }

      await this.updateOperationStatus(
        operationId,
        OperationStatus.IN_PROGRESS,
        {
          message:
            'Waiting for provider to complete server deletions before removing firewalls...',
          progress: 85,
        },
      );

      await this.sleep(checkInterval);
    }

    throw new Error(
      `Timeout waiting for servers to be deleted from provider. Cannot safely delete firewalls.`,
    );
  }

  /**
   * Process stop-cluster job
   */
  @Process('stop-cluster')
  async handleStopCluster(job: Job<StopClusterJobData>): Promise<void> {
    const { operationId, clusterId } = job.data;

    this.logger.log(
      `Processing stop-cluster job for cluster ${clusterId}, operation: ${operationId}`,
    );

    try {
      // Load operation
      const operation = await this.operationRepository.findOne({
        where: { id: operationId },
      });

      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      // Update status to IN_PROGRESS
      operation.status = OperationStatus.IN_PROGRESS;
      operation.startedAt = new Date();
      await this.operationRepository.save(operation);

      // Execute the stop operation
      await this.clusterPowerManagementService.executeStopCluster(
        clusterId,
        operationId,
      );

      this.logger.log(
        `Stop-cluster job completed for cluster ${clusterId}, operation: ${operationId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to process stop-cluster job for cluster ${clusterId}:`,
        error.stack || error.message,
      );

      // Update operation status to failed
      const operation = await this.operationRepository.findOne({
        where: { id: operationId },
      });

      if (operation) {
        operation.status = OperationStatus.FAILED;
        operation.metadata = {
          ...operation.metadata,
          error: error.message,
          failedAt: new Date().toISOString(),
        };
        await this.operationRepository.save(operation);
      }

      throw error;
    }
  }

  /**
   * Process start-cluster job
   */
  @Process('start-cluster')
  async handleStartCluster(job: Job<StartClusterJobData>): Promise<void> {
    const { operationId, clusterId } = job.data;

    this.logger.log(
      `Processing start-cluster job for cluster ${clusterId}, operation: ${operationId}`,
    );

    try {
      // Load operation
      const operation = await this.operationRepository.findOne({
        where: { id: operationId },
      });

      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      // Update status to IN_PROGRESS
      operation.status = OperationStatus.IN_PROGRESS;
      operation.startedAt = new Date();
      await this.operationRepository.save(operation);

      // Execute the start operation
      await this.clusterPowerManagementService.executeStartCluster(
        clusterId,
        operationId,
      );

      this.logger.log(
        `Start-cluster job completed for cluster ${clusterId}, operation: ${operationId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to process start-cluster job for cluster ${clusterId}:`,
        error.stack || error.message,
      );

      // Update operation status to failed
      const operation = await this.operationRepository.findOne({
        where: { id: operationId },
      });

      if (operation) {
        operation.status = OperationStatus.FAILED;
        operation.metadata = {
          ...operation.metadata,
          error: error.message,
          failedAt: new Date().toISOString(),
        };
        await this.operationRepository.save(operation);
      }

      throw error;
    }
  }

  @Process('attach-cluster-to-vnet')
  async handleAttachClusterToVNet(
    job: Job<AttachClusterToVNetJobData>,
  ): Promise<void> {
    const { operationId, clusterId, vnetConfig } = job.data;
    const startedAt = Date.now();

    this.logger.log(
      `Processing attach-cluster-to-vnet for cluster ${clusterId} (operation ${operationId})`,
    );

    try {
      // === STEP 0: VALIDATE ===
      await this.updateOperationStep(operationId, 0, 0, {
        status: OperationStatus.IN_PROGRESS,
        message: 'Validating VNet/subnet and provider capability',
        clusterId,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.ATTACH_CLUSTER_TO_VNET,
        resourceType: 'cluster',
        percentage: 0,
        currentStepIndex: 0,
        totalSteps: 3,
        message: 'Validating VNet/subnet...',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
        relations: ['nodes'],
      });
      if (!cluster) {
        throw new Error(`Cluster ${clusterId} not found`);
      }

      // Resolve subnet (auto-pick first if not specified)
      let subnetId = vnetConfig.subnetId;
      if (!subnetId) {
        const subnetsResponse = await this.subnetsService.listSubnets({
          vnetId: vnetConfig.vnetId,
        });
        if (!subnetsResponse.subnets || subnetsResponse.subnets.length === 0) {
          throw new Error(`No subnets found in VNet ${vnetConfig.vnetId}`);
        }
        subnetId = subnetsResponse.subnets[0].id;
        this.logger.log(`Auto-selected subnet ${subnetId}`);
      }

      await this.updateOperationStep(operationId, 0, 100, {
        message: 'VNet/subnet validated',
        resolvedSubnetId: subnetId,
      });

      // === STEP 1: ATTACH NODES ===
      const totalNodes = cluster.nodes.length;
      await this.updateOperationStep(operationId, 1, 0, {
        message: `Attaching ${totalNodes} node${totalNodes > 1 ? 's' : ''} to VNet`,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.ATTACH_CLUSTER_TO_VNET,
        resourceType: 'cluster',
        percentage: 10,
        currentStepIndex: 1,
        totalSteps: 3,
        message: `Attaching ${totalNodes} node${totalNodes > 1 ? 's' : ''}...`,
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      for (let i = 0; i < cluster.nodes.length; i++) {
        const node = cluster.nodes[i];
        if (!node.providerResourceId) {
          throw new Error(
            `Node ${node.serverName} has no providerResourceId — cannot attach to VNet`,
          );
        }

        // Skip if already attached to this exact subnet (idempotent)
        const existingAttachment = node.metadata?.vnetAttachment;
        if (
          existingAttachment?.vnetId === vnetConfig.vnetId &&
          existingAttachment?.subnetId === subnetId
        ) {
          this.logger.log(
            `Node ${node.serverName} already attached to subnet ${subnetId} — skipping`,
          );
        } else {
          this.logger.log(
            `Attaching node ${node.serverName} (${node.providerResourceId}) to subnet ${subnetId}`,
          );
          await this.subnetsService.attachServerToSubnet(subnetId, {
            serverId: node.providerResourceId,
            ip:
              vnetConfig.autoAssignIp === false
                ? (vnetConfig as { ip?: string }).ip
                : undefined,
          });

          node.metadata = {
            ...node.metadata,
            vnetAttachment: {
              vnetId: vnetConfig.vnetId,
              subnetId,
              attachedAt: new Date().toISOString(),
              autoAssignedIp: vnetConfig.autoAssignIp !== false,
            },
          };
          await this.nodeRepository.save(node);
        }

        const stepProgress = Math.round(((i + 1) / totalNodes) * 100);
        await this.updateOperationStep(operationId, 1, stepProgress, {
          message: `Attached ${i + 1}/${totalNodes} nodes`,
          attachedNode: node.serverName,
        });
        this.infraGateway.emitProgress(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.ATTACH_CLUSTER_TO_VNET,
          resourceType: 'cluster',
          percentage: 10 + Math.round(((i + 1) / totalNodes) * 80),
          currentStepIndex: 1,
          totalSteps: 3,
          message: `Attached node ${node.serverName} (${i + 1}/${totalNodes})`,
          timestamp: new Date(),
        } as InfrastructureOperationProgressDto);
      }

      // === STEP 2: PERSIST CLUSTER VNET CONFIG ===
      await this.updateOperationStep(operationId, 2, 50, {
        message: 'Persisting cluster VNet configuration',
      });

      cluster.metadata = {
        ...cluster.metadata,
        vnetConfig: {
          vnetId: vnetConfig.vnetId,
          subnetId,
          autoAssignIp: vnetConfig.autoAssignIp !== false,
        },
      };
      await this.clusterRepository.save(cluster);
      await this.vnetsService.ensureClusterIdLabel(
        vnetConfig.vnetId,
        clusterId,
      );

      await this.updateOperationStep(operationId, 2, 100, {
        status: OperationStatus.COMPLETED,
        message: 'Cluster attached to VNet',
        completedAt: new Date().toISOString(),
        nodeCount: totalNodes,
        vnetId: vnetConfig.vnetId,
        subnetId,
      });
      this.infraGateway.emitCompleted(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.ATTACH_CLUSTER_TO_VNET,
        resourceType: 'cluster',
        duration: Date.now() - startedAt,
        timestamp: new Date(),
      } as InfrastructureOperationCompletedDto);

      this.logger.log(
        `✅ Cluster ${cluster.name} attached to VNet ${vnetConfig.vnetId} (${totalNodes} nodes)`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Attach cluster ${clusterId} to VNet failed: ${error.message}`,
        error.stack,
      );

      const failedOp = await this.operationRepository.findOne({
        where: { id: operationId },
      });
      if (failedOp) {
        failedOp.status = OperationStatus.FAILED;
        failedOp.errorMessage = error.message;
        failedOp.completedAt = new Date();
        failedOp.metadata = {
          ...failedOp.metadata,
          error: error.message,
          stack: error.stack,
          clusterId,
          failedAt: new Date().toISOString(),
        };
        await this.operationRepository.save(failedOp);
      }

      this.infraGateway.emitFailed(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.ATTACH_CLUSTER_TO_VNET,
        resourceType: 'cluster',
        error: error.message,
        timestamp: new Date(),
      } as InfrastructureOperationFailedDto);

      throw error;
    }
  }

  @Process('add-worker')
  async handleAddWorker(job: Job<AddWorkerJobData>): Promise<void> {
    const { operationId, clusterId, count, providerFirewallIds } = job.data;
    const startedAt = Date.now();
    this.logger.log(
      `Processing add-worker: cluster=${clusterId} count=${count} (operation ${operationId})`,
    );

    const preExistingNodeIds = new Set<string>();
    const preCluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    preCluster?.nodes?.forEach((n) => preExistingNodeIds.add(n.id));

    try {
      // STEP 0 - VALIDATE
      await this.updateOperationStep(operationId, 0, 0, {
        status: OperationStatus.IN_PROGRESS,
        message: 'Validating cluster + VNet',
        clusterId,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.ADD_WORKER,
        resourceType: 'cluster',
        percentage: 0,
        currentStepIndex: 0,
        totalSteps: 4,
        message: 'Validating cluster',
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
        relations: ['nodes'],
      });
      if (!cluster) {
        throw new Error(`Cluster ${clusterId} not found`);
      }
      if (!cluster.metadata?.vnetConfig?.vnetId) {
        throw new Error('Cluster has no VNet attached');
      }

      await this.updateOperationStep(operationId, 0, 100, {
        message: 'Cluster ready for worker addition',
      });

      // STEP 1 - PROVISION
      await this.updateOperationStep(operationId, 1, 0, {
        message: `Provisioning ${count} worker${count > 1 ? 's' : ''}`,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.ADD_WORKER,
        resourceType: 'cluster',
        percentage: 5,
        currentStepIndex: 1,
        totalSteps: 4,
        message: `Provisioning ${count} worker${count > 1 ? 's' : ''}...`,
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      const created = await this.orchestrationService.createWorkerNodes(
        cluster,
        count,
        operationId,
        providerFirewallIds,
      );

      await this.updateOperationStep(operationId, 1, 100, {
        message: `${created.length} worker${created.length > 1 ? 's' : ''} provisioned`,
      });

      // STEP 2 - JOIN (already handled inside createWorkerNodes; report)
      await this.updateOperationStep(operationId, 2, 100, {
        message: 'Workers joined K3s cluster',
      });

      // Master-protection: a control cluster crossing single-node → multi-node
      // gets its master tainted so new pods land on the fresh worker(s).
      await this.maybeProtectMasterOnScaleOut(
        cluster,
        preCluster?.nodes?.length ?? 1,
        created.length,
      );

      // STEP 3 - FINALIZE
      await this.clusterRepository.update(clusterId, {
        nodeCount: (cluster.nodeCount || 0) + created.length,
      });

      const refreshedCluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
      });
      if (refreshedCluster) {
        await this.registerClusterInGrafana(refreshedCluster);
      }

      await this.updateOperationStep(operationId, 3, 100, {
        status: OperationStatus.COMPLETED,
        message: `Added ${created.length} worker${created.length > 1 ? 's' : ''}`,
        addedNodeIds: created.map((n) => n.id),
        completedAt: new Date().toISOString(),
      });
      this.infraGateway.emitCompleted(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.ADD_WORKER,
        resourceType: 'cluster',
        duration: Date.now() - startedAt,
        timestamp: new Date(),
      } as InfrastructureOperationCompletedDto);

      this.logger.log(
        `add-worker completed: cluster=${clusterId} added=${created.length}`,
      );
    } catch (error) {
      this.logger.error(
        `add-worker failed for cluster ${clusterId}: ${error.message}`,
        error.stack,
      );

      let orphansRemoved = 0;
      try {
        const currentNodes = await this.nodeRepository.find({
          where: { clusterId },
        });
        const orphans = currentNodes.filter(
          (n) =>
            !preExistingNodeIds.has(n.id) &&
            (!n.providerResourceId || n.status === NodeStatus.CREATING),
        );
        for (const o of orphans) {
          await this.billingIntervals.closeNodeIntervals(o.id);
          await this.nodeRepository.delete({ id: o.id });
          orphansRemoved++;
        }
        const surviving = currentNodes.length - orphansRemoved;
        await this.clusterRepository.update(clusterId, {
          nodeCount: surviving,
        });
        if (orphansRemoved > 0) {
          this.logger.log(
            `add-worker cleanup: removed ${orphansRemoved} orphan node row(s) for cluster ${clusterId}`,
          );
        }
      } catch (cleanupErr) {
        this.logger.warn(
          `add-worker orphan cleanup failed for cluster ${clusterId}: ${cleanupErr.message}`,
        );
      }

      await this.markOperationFailed(operationId, error, { orphansRemoved });
      this.infraGateway.emitFailed(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.ADD_WORKER,
        resourceType: 'cluster',
        error: error.message,
        timestamp: new Date(),
      } as InfrastructureOperationFailedDto);
      throw error;
    }
  }

  @Process('remove-worker')
  async handleRemoveWorker(job: Job<RemoveWorkerJobData>): Promise<void> {
    const { operationId, clusterId, nodeId } = job.data;
    const startedAt = Date.now();
    this.logger.log(
      `Processing remove-worker: cluster=${clusterId} node=${nodeId} (operation ${operationId})`,
    );

    const warnings: Array<{
      code: string;
      reason: string;
      details?: Record<string, any>;
    }> = [];

    try {
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
        relations: ['nodes'],
      });
      if (!cluster) throw new Error(`Cluster ${clusterId} not found`);

      const node = cluster.nodes?.find((n) => n.id === nodeId);
      if (!node) throw new Error(`Node ${nodeId} not in cluster ${clusterId}`);

      // STEP 0 - CORDON
      await this.updateOperationStep(operationId, 0, 0, {
        status: OperationStatus.IN_PROGRESS,
        message: 'Cordoning worker node',
        clusterId,
        nodeId,
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.REMOVE_WORKER,
        resourceType: 'cluster',
        percentage: 0,
        currentStepIndex: 0,
        totalSteps: 5,
        message: `Cordoning ${node.serverName}`,
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      const masterIp = cluster.masterIpAddress;
      const bootstrapPrivateKey = await this.loadBootstrapPrivateKey(
        cluster.bootstrapKeyId,
        masterIp,
      );

      const nodeName = node.serverName;
      await this.cordonNode(masterIp, bootstrapPrivateKey, nodeName, warnings);
      await this.updateOperationStep(operationId, 0, 100, {
        message: 'Cordon step done',
      });

      // STEP 1 - DRAIN
      await this.updateOperationStep(operationId, 1, 0, {
        message: 'Draining workloads',
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.REMOVE_WORKER,
        resourceType: 'cluster',
        percentage: 10,
        currentStepIndex: 1,
        totalSteps: 5,
        message: `Draining ${nodeName}`,
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      if (bootstrapPrivateKey && masterIp) {
        try {
          await this.nativeSsh.execCommand(
            masterIp,
            'root',
            bootstrapPrivateKey,
            `kubectl drain ${nodeName} --ignore-daemonsets --delete-emptydir-data --timeout=120s`,
            150000,
          );
        } catch (e) {
          warnings.push({
            code: 'DRAIN_FAILED',
            reason: e.message,
            details: { nodeName },
          });
          this.logger.warn(
            `Drain failed for ${nodeName}: ${e.message} — proceeding with delete`,
          );
          this.infraGateway.emitProgress(operationId, clusterId, {
            operationId,
            resourceId: clusterId,
            operationType: OperationType.REMOVE_WORKER,
            resourceType: 'cluster',
            percentage: 30,
            currentStepIndex: 1,
            totalSteps: 5,
            message: `Drain failed (continuing): ${e.message}`,
            timestamp: new Date(),
          } as InfrastructureOperationProgressDto);
        }
      } else {
        warnings.push({
          code: 'DRAIN_SKIPPED',
          reason: 'Master IP or bootstrap key unavailable',
        });
      }
      await this.updateOperationStep(operationId, 1, 100, {
        message: 'Drain step done',
        warnings,
      });

      // STEP 2 - DELETE SERVER
      await this.updateOperationStep(operationId, 2, 0, {
        message: 'Deleting worker server from provider',
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.REMOVE_WORKER,
        resourceType: 'cluster',
        percentage: 40,
        currentStepIndex: 2,
        totalSteps: 5,
        message: `Deleting server ${nodeName}`,
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      if (node.providerResourceId) {
        node.status = NodeStatus.DELETING;
        await this.nodeRepository.save(node);

        const probeStatus = async (label: string) => {
          try {
            const s = await this.serversService.checkServerStatus(
              node.providerResourceId,
              cluster.provider as CloudProvider,
            );
            this.logger.log(
              `[remove-worker probe] ${label} server=${node.providerResourceId} providerStatus=${s}`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            this.logger.log(
              `[remove-worker probe] ${label} server=${node.providerResourceId} status=UNAVAILABLE (${msg})`,
            );
          }
        };

        await probeStatus('before-delete');

        const deleteOp = await this.serversService.deleteServer({
          server_id: node.providerResourceId,
          provider: cluster.provider as CloudProvider,
          force: true,
        });

        await probeStatus('right-after-delete-action');

        await this.waitForAllDeletions(
          [
            {
              nodeId: node.id,
              nodeName: node.serverName,
              operationId: deleteOp.id,
            },
          ],
          operationId,
          600000,
          false,
        );

        await probeStatus('after-action-completed');
        setTimeout(() => probeStatus('+5s'), 5000);
        setTimeout(() => probeStatus('+15s'), 15000);
        setTimeout(() => probeStatus('+30s'), 30000);
      } else {
        this.logger.warn(
          `Node ${nodeName} has no providerResourceId — DB-only removal`,
        );
      }

      await this.billingIntervals.closeNodeIntervals(node.id);
      await this.nodeRepository.delete({ id: node.id });
      await this.clusterRepository.update(clusterId, {
        nodeCount: Math.max((cluster.nodeCount || 1) - 1, 0),
      });

      await this.updateOperationStep(operationId, 2, 100, {
        message: 'Worker server deleted',
      });

      // STEP 3 - DELETE NODE FROM K3S CONTROL PLANE
      await this.updateOperationStep(operationId, 3, 0, {
        message: 'Removing node from K3s control plane',
      });
      this.infraGateway.emitProgress(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.REMOVE_WORKER,
        resourceType: 'cluster',
        percentage: 90,
        currentStepIndex: 3,
        totalSteps: 5,
        message: `Removing ${nodeName} from K3s`,
        timestamp: new Date(),
      } as InfrastructureOperationProgressDto);

      if (bootstrapPrivateKey && masterIp) {
        try {
          await this.nativeSsh.execCommand(
            masterIp,
            'root',
            bootstrapPrivateKey,
            `kubectl delete node ${nodeName} --ignore-not-found=true --timeout=60s && ` +
              `kubectl delete secret -n kube-system ${nodeName}.node-password.k3s --ignore-not-found=true --timeout=30s`,
            90000,
          );
        } catch (e) {
          warnings.push({
            code: 'K3S_NODE_DELETE_FAILED',
            reason: e.message,
            details: { nodeName },
          });
          this.logger.warn(
            `kubectl delete node failed for ${nodeName}: ${e.message} — node may remain in K3s as ghost`,
          );
        }
      } else {
        warnings.push({
          code: 'K3S_NODE_DELETE_SKIPPED',
          reason: 'Master IP or bootstrap key unavailable',
        });
      }
      await this.updateOperationStep(operationId, 3, 100, {
        message: 'K3s node removal step done',
      });

      // Master-protection: if this was the last worker, the control cluster is
      // single-node again — untaint the master so workloads can schedule on it.
      await this.maybeUntaintMasterOnScaleIn(
        cluster,
        (cluster.nodes?.length ?? 1) - 1,
      );

      // STEP 4 - FINALIZE
      await this.updateOperationStep(operationId, 4, 100, {
        status: OperationStatus.COMPLETED,
        message:
          warnings.length > 0
            ? `Worker removed with ${warnings.length} warning(s)`
            : 'Worker removed cleanly',
        warnings,
        completedAt: new Date().toISOString(),
      });

      // Emit dedicated drain-failed event so the frontend can surface a persistent toast
      const drainWarning = warnings.find((w) => w.code === 'DRAIN_FAILED');
      if (drainWarning) {
        this.infraGateway.emitProgress(operationId, clusterId, {
          operationId,
          resourceId: clusterId,
          operationType: OperationType.REMOVE_WORKER,
          resourceType: 'cluster',
          percentage: 100,
          currentStepIndex: 4,
          totalSteps: 5,
          message: `worker:drain_failed: ${drainWarning.reason}`,
          timestamp: new Date(),
        } as InfrastructureOperationProgressDto);
      }

      this.infraGateway.emitCompleted(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.REMOVE_WORKER,
        resourceType: 'cluster',
        duration: Date.now() - startedAt,
        timestamp: new Date(),
      } as InfrastructureOperationCompletedDto);

      this.logger.log(
        `remove-worker completed: cluster=${clusterId} node=${nodeId} warnings=${warnings.length}`,
      );
    } catch (error) {
      this.logger.error(
        `remove-worker failed for cluster ${clusterId} node ${nodeId}: ${error.message}`,
        error.stack,
      );
      await this.markOperationFailed(operationId, error, { warnings });
      this.infraGateway.emitFailed(operationId, clusterId, {
        operationId,
        resourceId: clusterId,
        operationType: OperationType.REMOVE_WORKER,
        resourceType: 'cluster',
        error: error.message,
        timestamp: new Date(),
      } as InfrastructureOperationFailedDto);
      throw error;
    }
  }

  private async loadBootstrapPrivateKey(
    bootstrapKeyId: string | null | undefined,
    masterIp: string | null | undefined,
  ): Promise<string | null> {
    if (!masterIp || !bootstrapKeyId) return null;
    try {
      return await this.accessService.getPrivateKey('system', bootstrapKeyId);
    } catch (e) {
      this.logger.warn(
        `Could not load cluster bootstrap key ${bootstrapKeyId}: ${(e as Error).message}`,
      );
      return null;
    }
  }

  private async cordonNode(
    masterIp: string | null | undefined,
    bootstrapPrivateKey: string | null,
    nodeName: string,
    warnings: Array<{
      code: string;
      reason: string;
      details?: Record<string, any>;
    }>,
  ): Promise<void> {
    if (!bootstrapPrivateKey || !masterIp) {
      warnings.push({
        code: 'CORDON_SKIPPED',
        reason: 'Master IP or bootstrap key unavailable',
      });
      return;
    }
    try {
      await this.nativeSsh.execCommand(
        masterIp,
        'root',
        bootstrapPrivateKey,
        `kubectl cordon ${nodeName}`,
        30000,
      );
    } catch (e) {
      warnings.push({ code: 'CORDON_FAILED', reason: (e as Error).message });
      this.logger.warn(
        `Cordon failed for ${nodeName}: ${(e as Error).message} — continuing`,
      );
    }
  }

  /**
   * Applies or removes the standard control-plane taint on the master(s) of a
   * control cluster, so new pods land on workers once the cluster scales out.
   * Best-effort: a failed taint must not fail the scaling operation.
   */
  /**
   * Taint the master on scale-out / untaint on scale-in for a control cluster,
   * persist the flag, and log loudly. Applied via the k8s API (not SSH).
   */
  private async applyMasterProtection(
    cluster: ClusterEntity,
    apply: boolean,
  ): Promise<void> {
    const encrypted =
      cluster.kubeconfigEncrypted ??
      (await this.clusterRepository.findOne({ where: { id: cluster.id } }))
        ?.kubeconfigEncrypted;
    if (!encrypted) {
      this.logger.warn(
        '[master-protection] skipped: cluster kubeconfig unavailable',
      );
      return;
    }
    const kubeconfig = this.encryptionService.decrypt(encrypted);
    const ok = await this.kubernetesService.setControlPlaneTaint(
      kubeconfig,
      apply,
    );
    if (!ok) return;

    // Re-fetch without relations so save() doesn't cascade the (possibly stale) nodes.
    const fresh = await this.clusterRepository.findOne({
      where: { id: cluster.id },
    });
    if (fresh) {
      fresh.metadata = { ...fresh.metadata, masterProtection: apply };
      await this.clusterRepository.save(fresh);
    }

    if (apply) {
      this.logger.warn(
        `[master-protection] Master of control cluster ${cluster.name} tainted ` +
          `(control-plane:NoSchedule). New pods will schedule on workers. ` +
          `Disable with 'flui env set-master-protection off'.`,
      );
    } else {
      this.logger.warn(
        `[master-protection] Master of control cluster ${cluster.name} untainted ` +
          `— cluster is single-node again, workloads can schedule on the master.`,
      );
    }
  }

  /** Taints the master when a control cluster crosses single-node → multi-node. */
  private async maybeProtectMasterOnScaleOut(
    cluster: ClusterEntity,
    preNodeCount: number,
    addedCount: number,
  ): Promise<void> {
    if (!isControlClusterType(cluster.clusterType)) return;
    if (preNodeCount > 1 || addedCount <= 0) return;
    await this.applyMasterProtection(cluster, true);
  }

  /** Untaints the master when a control cluster returns to single-node. */
  private async maybeUntaintMasterOnScaleIn(
    cluster: ClusterEntity,
    remainingNodeCount: number,
  ): Promise<void> {
    if (!isControlClusterType(cluster.clusterType)) return;
    if (remainingNodeCount > 1) return;
    await this.applyMasterProtection(cluster, false);
  }

  private async markOperationFailed(
    operationId: string,
    error: Error,
    extraMetadata: Record<string, any> = {},
  ): Promise<void> {
    const op = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (!op) return;
    op.status = OperationStatus.FAILED;
    op.errorMessage = error.message;
    op.completedAt = new Date();
    op.metadata = {
      ...op.metadata,
      ...extraMetadata,
      error: error.message,
      stack: error.stack,
      failedAt: new Date().toISOString(),
    };
    await this.operationRepository.save(op);
  }

  /**
   * Helper to sleep
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Register workload cluster in Grafana control cluster
   * Called automatically after cluster becomes READY
   */
  private async registerClusterInGrafana(
    cluster: ClusterEntity,
  ): Promise<void> {
    // Only register WORKLOAD clusters (not control clusters)
    if (cluster.clusterType !== ClusterType.WORKLOAD) {
      this.logger.debug(
        `Skipping Grafana registration for ${cluster.clusterType} cluster ${cluster.name}`,
      );
      return;
    }

    try {
      this.logger.log(
        `Registering cluster ${cluster.name} in Grafana control cluster`,
      );

      // Check if control cluster exists
      const obsCluster = await this.grafanaConfigService.getControlCluster();
      if (!obsCluster) {
        this.logger.warn(
          'No control cluster found - skipping Grafana registration',
        );
        return;
      }

      // Add datasources to Grafana
      await this.grafanaDatasourceService.addClusterDatasources(cluster);

      this.logger.log(
        `✅ Cluster ${cluster.name} successfully registered in Grafana`,
      );
    } catch (error) {
      // Log error but don't fail cluster creation
      this.logger.error(
        `Failed to register cluster ${cluster.name} in Grafana: ${error.message}`,
        error.stack,
      );
      this.logger.warn(
        'Cluster creation succeeded but Grafana registration failed - datasources can be added manually',
      );
    }
  }
}
