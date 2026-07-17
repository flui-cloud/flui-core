import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { ConfigService } from '@nestjs/config';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from '../entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeType,
  NodeStatus,
} from '../entities/cluster-node.entity';
import { K3sScriptService } from './k3s-script.service';
import { calculateOperationProgressFromSaved } from '../../operations/helpers/operation-steps.helper';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { ProviderFactory } from 'src/modules/providers';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
  CreateServerOperationMetadata,
} from '../../servers/entities/infrastructure-operations.entity';
import { CreateServerJobData } from '../../servers/services/servers.service';
import { CreateServerDto } from '../../servers/dto/create-server.dto';
import { LabelService } from '../../../common/services/label.service';
import { AccessService } from 'src/modules/access/services/access.service';
import { SSHKeyGeneratorService } from 'src/modules/access/services/ssh-key-generator.service';
import { CAManagerService } from 'src/modules/access/services/ca-manager.service';
import { SubnetsService } from '../../vnets/services/subnets.service';
import { VNetsService } from '../../vnets/services/vnets.service';
import { NativeSSHConnectionService } from 'src/modules/terminal/services/native-ssh-connection.service';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { BillingIntervalsService } from './billing-intervals.service';
import { VolumeBillableKind } from '../entities/volume-billable-interval.entity';
import * as crypto from 'node:crypto';

@Injectable()
export class ClusterOrchestrationService {
  private readonly logger = new Logger(ClusterOrchestrationService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly infrastructureQueue: Queue,
    private readonly k3sScriptService: K3sScriptService,
    private readonly encryptionService: EncryptionService,
    private readonly providerFactory: ProviderFactory,
    private readonly labelService: LabelService,
    private readonly accessService: AccessService,
    private readonly keyGenerator: SSHKeyGeneratorService,
    private readonly caManager: CAManagerService,
    private readonly subnetsService: SubnetsService,
    private readonly vnetsService: VNetsService,
    private readonly configService: ConfigService,
    private readonly nativeSsh: NativeSSHConnectionService,
    private readonly kubernetesService: KubernetesService,
    private readonly billingIntervals: BillingIntervalsService,
  ) {}

  /**
   * Create master node for the cluster
   */
  async createMasterNode(
    cluster: ClusterEntity,
    operationId: string,
    providerFirewallIds?: string[],
  ): Promise<ClusterNodeEntity> {
    this.logger.log(`Creating master node for cluster ${cluster.name}`);

    await this.updateOperationProgress(
      operationId,
      5,
      'Creating master node...',
    );

    // Decrypt K3s token
    const k3sToken = this.encryptionService.decrypt(cluster.k3sTokenEncrypted);

    const { caPublicKey, caPrivateKey } = await this.loadCaKeyPair();

    const controlClusterIp = await this.resolveControlClusterIp(cluster);

    // Create node record FIRST so we have the node.id for SERVER_ID in cloud-init
    const serverName = `${cluster.name}-master`;
    const node = await this.ensureNodeRecord(
      cluster.id,
      serverName,
      NodeType.MASTER,
    );

    // Resolve Flui shared storage config (NFS+fscache, see scaling doc §14).
    // Default: enabled for all cluster types. Volume attached to the master
    // hosts the NFS export; workers mount it via NFSv4 + fscache.
    const sharedStorageEnabled = cluster.sharedStorageEnabled !== false;
    const sharedStorageVolumeSizeGb = cluster.sharedStorageVolumeSizeGb ?? 20;

    // Generate master init script WITH serverId (node.id from database)
    const masterScript = await this.k3sScriptService.generateMasterScript({
      serverId: node.id, // IMPORTANT: Pass database node ID for observability metrics
      clusterId: cluster.id,
      clusterName: cluster.name,
      k3sToken,
      k3sVersion: cluster.k3sVersion,
      instanceId: serverName,
      instanceName: serverName,
      provider: cluster.provider,
      caPublicKey,
      caPrivateKey,
      deployObservabilityStack: isControlClusterType(cluster.clusterType),
      // Multi-cluster observability
      controlClusterIp,
      deployMonitoringAgent:
        cluster.clusterType === ClusterType.WORKLOAD && !!controlClusterIp,
      sharedStorage: sharedStorageEnabled
        ? {
            enabled: true,
            volumeSizeGb: sharedStorageVolumeSizeGb,
          }
        : undefined,
    });

    // Bootstrap key for CA enrollment: used only for initial server access to
    // install the CA public key.
    const bootstrapKey = await this.ensureBootstrapKey(cluster, 'master');
    const savedBootstrapKey = { id: bootstrapKey.id };

    // Sync bootstrap key with provider — or inject via cloud-init if provider has no SSH registry
    const masterProviderService = this.providerFactory.getProvider(
      cluster.provider as CloudProvider,
    );
    const supportsSSHRegistry =
      typeof masterProviderService.createSSHKey === 'function';

    // Inject the bootstrap key via cloud-init on EVERY provider — it appends to
    // authorized_keys before the downstream script runs, so SSH access never
    // depends on the provider's key registry landing correctly. Registry
    // providers (Hetzner) ALSO get the key attached at boot (redundant, harmless):
    // relying on the registry alone was fragile — a single hiccup left the master
    // with no accepted key ("Permission denied (publickey)") while Scaleway's
    // cloud-init path always worked.
    let localSSHKeyIds: string[] = [];
    const bootstrapPublicKeyForCloudInit: string = bootstrapKey.publicKey;

    if (supportsSSHRegistry) {
      localSSHKeyIds = [savedBootstrapKey.id];
      this.logger.log(
        `Bootstrap key ${savedBootstrapKey.id} will be synced with ${cluster.provider} and also injected via cloud-init`,
      );
    } else {
      this.logger.log(
        `Provider ${cluster.provider} has no SSH key registry — bootstrap key injected via cloud-init only`,
      );
    }

    // Re-generate master script with bootstrap key if needed (cloud-init injection)
    const finalMasterScript = bootstrapPublicKeyForCloudInit
      ? await this.k3sScriptService.generateMasterScript({
          serverId: node.id,
          clusterId: cluster.id,
          clusterName: cluster.name,
          k3sToken,
          k3sVersion: cluster.k3sVersion,
          instanceId: serverName,
          instanceName: serverName,
          provider: cluster.provider,
          caPublicKey,
          caPrivateKey,
          deployObservabilityStack: isControlClusterType(cluster.clusterType),
          controlClusterIp,
          deployMonitoringAgent:
            cluster.clusterType === ClusterType.WORKLOAD && !!controlClusterIp,
          bootstrapPublicKey: bootstrapPublicKeyForCloudInit,
          sharedStorage: sharedStorageEnabled
            ? {
                enabled: true,
                volumeSizeGb: sharedStorageVolumeSizeGb,
              }
            : undefined,
        })
      : masterScript;

    // Generate labels for cluster master node
    const labels = this.labelService.generateServerLabels({
      resourceType: 'cluster-node',
      clusterId: cluster.id,
      clusterName: cluster.name,
      nodeId: node.id,
      nodeType: 'master',
      environment: 'production',
    });

    // Create server via queue (same pattern as ServersService)
    const serverUuid = crypto.randomUUID();

    // Create operation record for server creation
    const serverOperation = this.operationRepository.create({
      operationType: OperationType.CREATE_SERVER,
      resourceType: 'server',
      resourceName: serverName,
      resourceId: serverName,
      status: OperationStatus.PENDING,
      progress: 0,
      provider: cluster.provider as CloudProvider,
      metadata: {
        serverConfig: {
          name: serverName,
          provider: cluster.provider as CloudProvider,
          server_type: cluster.nodeSize,
          location: cluster.region,
          region: cluster.region,
          size: cluster.nodeSize,
          image: cluster.image || 'ubuntu-22.04',
          sshKeys: [savedBootstrapKey.id],
          labels: labels,
        } as CreateServerDto,
        serverName,
        clusterId: cluster.id,
        clusterName: cluster.name,
        nodeType: 'master',
      } as CreateServerOperationMetadata,
    });
    const savedServerOperation =
      await this.operationRepository.save(serverOperation);

    const providerNetworkIds = await this.resolveProviderNetworkIds(cluster);

    const createServerJobData: CreateServerJobData = {
      operationId: savedServerOperation.id,
      config: {
        name: serverName,
        provider: cluster.provider as CloudProvider,
        server_type: cluster.nodeSize,
        image: cluster.image || 'ubuntu-24.04',
        location: cluster.region,
        ssh_keys: localSSHKeyIds.length > 0 ? localSSHKeyIds : undefined,
        user_data: finalMasterScript,
        cluster_name: cluster.name,
        environment: 'production',
        uuid: serverUuid,
        labels: labels,
        firewalls:
          providerFirewallIds && providerFirewallIds.length > 0
            ? providerFirewallIds
            : undefined, // Attach firewalls if provided
        diskSizeGb: cluster.diskSizeGb,
        networks: providerNetworkIds,
        attachedVolumes: sharedStorageEnabled
          ? [
              {
                name: `${cluster.name}-flui-shared`,
                sizeGb: sharedStorageVolumeSizeGb,
                labels,
              },
            ]
          : undefined,
      },
    };

    if (providerFirewallIds && providerFirewallIds.length > 0) {
      this.logger.log(
        `Attaching ${providerFirewallIds.length} firewall(s) to master node ${serverName}`,
      );
    }
    if (providerNetworkIds && providerNetworkIds.length > 0) {
      this.logger.log(
        `Attaching master node ${serverName} to provider network(s) ${providerNetworkIds.join(', ')} at creation`,
      );
    }

    await this.infrastructureQueue.add('create-server', createServerJobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    // Wait for server creation to complete
    this.logger.log(
      `[createMasterNode] Queued create-server job for ${serverName} (operationId: ${createServerJobData.operationId}), waiting...`,
    );
    await this.waitForOperation(createServerJobData.operationId, 600000); // 10 min timeout
    this.logger.log(
      `[createMasterNode] Server operation completed for ${serverName}`,
    );

    if (sharedStorageEnabled) {
      const completedOp = await this.operationRepository.findOne({
        where: { id: createServerJobData.operationId },
      });
      const attachedVolumes = (completedOp?.metadata as any)
        ?.attachedVolumes as
        | Array<{ volumeId: string; sizeGb?: number }>
        | undefined;
      const sharedVolume = attachedVolumes?.[0];
      if (sharedVolume?.volumeId) {
        cluster.sharedStorageVolumeId = sharedVolume.volumeId;
        cluster.sharedStorageVolumeSizeGb =
          sharedVolume.sizeGb ?? sharedStorageVolumeSizeGb;
        await this.clusterRepository.save(cluster);
        this.logger.log(
          `[createMasterNode] Persisted sharedStorageVolumeId=${sharedVolume.volumeId} (${cluster.sharedStorageVolumeSizeGb} GB) on cluster ${cluster.id}`,
        );
        await this.billingIntervals.openVolumeInterval({
          clusterId: cluster.id,
          volumeProviderId: sharedVolume.volumeId,
          provider: cluster.provider,
          region: cluster.region,
          kind: VolumeBillableKind.SHARED_STORAGE,
          sizeGb: cluster.sharedStorageVolumeSizeGb,
        });
      } else {
        this.logger.warn(
          `[createMasterNode] sharedStorageEnabled but no attachedVolumes in operation ${createServerJobData.operationId} metadata — sharedStorageVolumeId left empty`,
        );
      }
    }

    // Get server details from provider
    const providerService = this.providerFactory.getProvider(
      cluster.provider as CloudProvider,
    );
    this.logger.log(
      `[createMasterNode] Listing servers to find ${serverName}...`,
    );
    const servers = await providerService.listServersAsDto();
    this.logger.log(
      `[createMasterNode] Provider returned ${servers.length} servers`,
    );
    const masterServer = servers.find((s) => s.name === serverName);

    if (!masterServer) {
      const names = servers.map((s) => s.name).join(', ');
      throw new Error(
        `Master server "${serverName}" not found after creation. Available servers: [${names}]`,
      );
    }

    this.logger.log(
      `[createMasterNode] Found master server: id=${masterServer.id} ip=${masterServer.public_ip ?? masterServer.private_ip} status=${masterServer.status}`,
    );

    // Update node with server info
    node.providerResourceId = masterServer.id;
    node.ipAddress = masterServer.public_ip || masterServer.private_ip;
    node.privateIp = masterServer.private_ip ?? null;
    node.status = NodeStatus.JOINING;
    if (cluster.metadata?.vnetConfig) {
      node.subnetId = cluster.metadata.vnetConfig.subnetId ?? null;
      node.metadata = {
        ...node.metadata,
        vnetAttachment: {
          vnetId: cluster.metadata.vnetConfig.vnetId,
          subnetId: cluster.metadata.vnetConfig.subnetId,
          privateIp: masterServer.private_ip ?? null,
          attachedAt: new Date().toISOString(),
          source: 'create-time',
        },
      };
    }
    await this.nodeRepository.save(node);

    await this.billingIntervals.openNodeInterval({
      clusterId: cluster.id,
      nodeId: node.id,
      serverName: node.serverName,
      providerResourceId: node.providerResourceId,
      provider: cluster.provider,
      region: cluster.region,
      location: masterServer.location,
      serverType: cluster.nodeSize,
      nodeType: node.nodeType,
    });

    if (cluster.metadata?.vnetConfig) {
      if (!masterServer.private_ip) {
        throw new Error(
          `Master node ${serverName} has no private IP after VNet attachment — cannot proceed (network=${cluster.metadata.vnetConfig.vnetId})`,
        );
      }
      this.logger.log(
        `Master node ${serverName} attached to VNet at create — privateIp=${masterServer.private_ip}`,
      );
      await this.updateOperationProgress(
        operationId,
        25,
        'Master node attached to VNet',
      );
    }

    await this.updateOperationProgress(
      operationId,
      30,
      'Master node created, waiting for K3s to be ready...',
    );

    // No pre-wait: fetchKubeconfigFromMaster polls until the file exists, so the
    // kubeconfig appearing IS the readiness signal.

    // Fetch kubeconfig from master via SSH using bootstrap key. The server host
    // baked into the kubeconfig is normally the master's private VNet IP, but a
    // workload that does NOT share a private network with the control cluster
    // (typical cross-provider case) is unreachable there — the API server must
    // then be addressed on the master's public IP (the firewall opens 6443 to
    // the control's public IP; see CrossProviderFirewallService).
    const serverIp = await this.resolveKubeconfigServerIp(cluster, node);
    this.logger.log(
      `[createMasterNode] Fetching kubeconfig from master ${node.ipAddress} via SSH (bootstrap key id: ${savedBootstrapKey.id}); kubeconfig server=${serverIp}`,
    );
    let kubeconfig: string;
    try {
      kubeconfig = await this.fetchKubeconfigFromMaster(
        node.ipAddress,
        bootstrapKey.privateKey,
        serverIp,
        // Paced against how long a bootstrap actually takes, not against the
        // 15-min deadline: the deadline is the give-up point, and pacing to it
        // would crawl to a tenth of the bar on a healthy boot. A node that runs
        // long parks at the ceiling rather than pretending to still be moving.
        async (elapsedMs) => {
          const ratio = Math.min(
            elapsedMs / ClusterOrchestrationService.KUBECONFIG_TYPICAL_WAIT_MS,
            1,
          );
          await this.updateOperationProgress(
            operationId,
            30 + Math.round(ratio * 65),
            'Waiting for K3s to write its kubeconfig...',
          );
        },
      );
    } catch (err) {
      this.logger.error(
        `[createMasterNode] Failed to fetch kubeconfig from ${node.ipAddress}: ${err.message}`,
        err.stack,
      );
      throw err;
    }
    this.logger.log(
      `[createMasterNode] Kubeconfig fetched (${kubeconfig.length} bytes), encrypting and storing...`,
    );
    cluster.kubeconfigEncrypted = this.encryptionService.encrypt(kubeconfig);

    // Update cluster with master info
    cluster.masterNodeId = node.id;
    cluster.masterIpAddress = node.ipAddress;
    cluster.masterPrivateIp = node.privateIp ?? null;
    await this.clusterRepository.save(cluster);
    this.logger.log(
      `[createMasterNode] Cluster updated: masterIp=${cluster.masterIpAddress} masterPrivateIp=${cluster.masterPrivateIp ?? 'none'} masterNodeId=${cluster.masterNodeId}`,
    );

    // Mark node as ready
    node.status = NodeStatus.READY;
    await this.nodeRepository.save(node);

    await this.updateOperationProgress(operationId, 100, 'Master node ready');
    this.logger.log(
      `[createMasterNode] ✅ Master node ${serverName} fully ready`,
    );

    return node;
  }

  /**
   * Create worker nodes for the cluster
   */
  async createWorkerNodes(
    cluster: ClusterEntity,
    count: number,
    operationId: string,
    providerFirewallIds?: string[],
  ): Promise<ClusterNodeEntity[]> {
    this.logger.log(
      `Creating ${count} worker nodes for cluster ${cluster.name}`,
    );

    const k3sToken = this.encryptionService.decrypt(cluster.k3sTokenEncrypted);
    const workers: ClusterNodeEntity[] = [];

    const masterJoinIp = cluster.masterPrivateIp || cluster.masterIpAddress;
    if (!masterJoinIp) {
      throw new Error('Master IP address not set');
    }
    if (cluster.metadata?.vnetConfig && !cluster.masterPrivateIp) {
      throw new Error(
        `Cluster ${cluster.name} has a VNet but no masterPrivateIp — cannot join workers over VNet. Recreate the cluster so the master is provisioned with the VNet attached at create time.`,
      );
    }

    // Create workers in batches of 2 for better performance
    const batchSize = 2;
    for (let i = 0; i < count; i += batchSize) {
      const batch = Math.min(batchSize, count - i);
      const batchPromises = [];

      for (let j = 0; j < batch; j++) {
        const workerIndex = i + j + 1;
        batchPromises.push(
          this.createWorkerNode(
            cluster,
            workerIndex,
            k3sToken,
            masterJoinIp,
            operationId,
            providerFirewallIds,
          ),
        );
      }

      const batchWorkers = await Promise.all(batchPromises);
      workers.push(...batchWorkers);

      await this.updateOperationProgress(
        operationId,
        Math.floor(((i + batch) / count) * 100),
        `Created ${i + batch}/${count} worker nodes`,
      );
    }

    return workers;
  }

  /**
   * Create a single worker node
   */
  private async createWorkerNode(
    cluster: ClusterEntity,
    index: number,
    k3sToken: string,
    masterIp: string,
    operationId: string,
    providerFirewallIds?: string[],
  ): Promise<ClusterNodeEntity> {
    const serverName = `${cluster.name}-worker-${index}`;
    this.logger.log(`Creating worker node: ${serverName}`);

    // Retrieve CA public key for injection into cloud-init
    // CA must be configured before cluster creation (validated in ClustersService)
    const caPublicKey = await this.caManager.getCAPublicKey();
    this.logger.log(
      `CA public key retrieved for worker node ${serverName} cloud-init injection - ephemeral certificates enabled`,
    );

    // Create node record FIRST so we have the node.id for SERVER_ID in cloud-init
    const node = await this.ensureNodeRecord(
      cluster.id,
      serverName,
      NodeType.WORKER,
      { workerIndex: index },
    );

    const controlClusterIp = await this.resolveWorkerObservabilityIp(cluster);

    // Resolve Flui shared storage config for the worker (NFS+fscache, §14).
    // Workers mount the master's NFS export and run cachefilesd. We need
    // master's private IP for the mount.
    const workerSharedStorage =
      cluster.sharedStorageEnabled !== false && cluster.masterPrivateIp
        ? {
            enabled: true,
            masterPrivateIp: cluster.masterPrivateIp,
          }
        : undefined;

    // Generate worker init script WITH serverId (node.id from database)
    const workerScript = await this.k3sScriptService.generateWorkerScript({
      serverId: node.id, // IMPORTANT: Pass database node ID for observability metrics
      clusterId: cluster.id,
      clusterName: cluster.name,
      k3sToken,
      masterIp,
      k3sVersion: cluster.k3sVersion,
      instanceId: serverName,
      instanceName: serverName,
      provider: cluster.provider,
      caPublicKey,
      // Multi-cluster observability
      controlClusterIp,
      sharedStorage: workerSharedStorage,
    });

    // Bootstrap key for CA enrollment: used only for initial server access to
    // install the CA public key.
    const bootstrapKey = await this.ensureBootstrapKey(cluster, 'worker');
    const savedBootstrapKey = { id: bootstrapKey.id };

    // Sync bootstrap key with provider — or inject via cloud-init if provider has no SSH registry
    const workerProviderService = this.providerFactory.getProvider(
      cluster.provider as CloudProvider,
    );
    const workerSupportsSSHRegistry =
      typeof workerProviderService.createSSHKey === 'function';

    // Pass local key ID — ServersService will resolve it to the provider key ID during sync
    let workerLocalSSHKeyIds: string[] = [];
    let workerBootstrapPublicKeyForCloudInit: string | undefined;

    if (workerSupportsSSHRegistry) {
      workerLocalSSHKeyIds = [savedBootstrapKey.id];
      this.logger.log(
        `Bootstrap key ${savedBootstrapKey.id} will be synced with ${cluster.provider} by ServersService (worker ${serverName})`,
      );
    } else {
      this.logger.log(
        `Provider ${cluster.provider} does not support SSH key registry — bootstrap key will be injected via cloud-init`,
      );
      workerBootstrapPublicKeyForCloudInit = bootstrapKey.publicKey;
    }

    // Re-generate worker script with bootstrap key if needed (cloud-init injection)
    const finalWorkerScript = workerBootstrapPublicKeyForCloudInit
      ? await this.k3sScriptService.generateWorkerScript({
          serverId: node.id,
          clusterId: cluster.id,
          clusterName: cluster.name,
          k3sToken,
          masterIp,
          k3sVersion: cluster.k3sVersion,
          instanceId: serverName,
          instanceName: serverName,
          provider: cluster.provider,
          caPublicKey,
          controlClusterIp,
          bootstrapPublicKey: workerBootstrapPublicKeyForCloudInit,
          sharedStorage: workerSharedStorage,
        })
      : workerScript;

    // Generate labels for cluster worker node
    const labels = this.labelService.generateServerLabels({
      resourceType: 'cluster-node',
      clusterId: cluster.id,
      clusterName: cluster.name,
      nodeId: node.id,
      nodeType: 'worker',
      environment: 'production',
    });

    // Create server via queue
    const serverUuid = crypto.randomUUID();

    // Create operation record for server creation
    const serverOperation = this.operationRepository.create({
      operationType: OperationType.CREATE_SERVER,
      resourceType: 'server',
      resourceName: serverName,
      resourceId: serverName,
      status: OperationStatus.PENDING,
      progress: 0,
      provider: cluster.provider as CloudProvider,
      metadata: {
        serverConfig: {
          name: serverName,
          provider: cluster.provider as CloudProvider,
          server_type: cluster.nodeSize,
          location: cluster.region,
          region: cluster.region,
          size: cluster.nodeSize,
          image: cluster.image || 'ubuntu-22.04',
          sshKeys: [savedBootstrapKey.id],
          labels: labels,
        } as CreateServerDto,
        serverName,
        clusterId: cluster.id,
        clusterName: cluster.name,
        nodeType: 'worker',
        workerIndex: index,
      } as CreateServerOperationMetadata,
    });
    const savedServerOperation =
      await this.operationRepository.save(serverOperation);

    const providerNetworkIds = await this.resolveProviderNetworkIds(cluster);

    const createServerJobData: CreateServerJobData = {
      operationId: savedServerOperation.id,
      config: {
        name: serverName,
        provider: cluster.provider as CloudProvider,
        server_type: cluster.nodeSize,
        image: cluster.image || 'ubuntu-24.04',
        location: cluster.region,
        ssh_keys:
          workerLocalSSHKeyIds.length > 0 ? workerLocalSSHKeyIds : undefined,
        user_data: finalWorkerScript,
        cluster_name: cluster.name,
        environment: 'production',
        uuid: serverUuid,
        labels: labels,
        firewalls:
          providerFirewallIds && providerFirewallIds.length > 0
            ? providerFirewallIds
            : undefined, // Attach firewalls if provided
        diskSizeGb: cluster.diskSizeGb,
        networks: providerNetworkIds,
      },
    };

    if (providerFirewallIds && providerFirewallIds.length > 0) {
      this.logger.log(
        `Attaching ${providerFirewallIds.length} firewall(s) to worker node ${serverName}`,
      );
    }
    if (providerNetworkIds && providerNetworkIds.length > 0) {
      this.logger.log(
        `Attaching worker node ${serverName} to provider network(s) ${providerNetworkIds.join(', ')} at creation`,
      );
    }

    await this.infrastructureQueue.add('create-server', createServerJobData, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    // Wait for server creation
    await this.waitForOperation(createServerJobData.operationId, 600000);

    // Get server details
    const providerService = this.providerFactory.getProvider(
      cluster.provider as CloudProvider,
    );
    const servers = await providerService.listServersAsDto();
    const workerServer = servers.find((s) => s.name === serverName);

    if (!workerServer) {
      throw new Error(`Worker server ${serverName} not found after creation`);
    }

    // Update node
    node.providerResourceId = workerServer.id;
    node.ipAddress = workerServer.public_ip || workerServer.private_ip;
    node.privateIp = workerServer.private_ip ?? null;
    node.status = NodeStatus.READY;
    if (cluster.metadata?.vnetConfig) {
      if (!workerServer.private_ip) {
        throw new Error(
          `Worker node ${serverName} has no private IP after VNet attachment — K3s join would fail (network=${cluster.metadata.vnetConfig.vnetId})`,
        );
      }
      node.subnetId = cluster.metadata.vnetConfig.subnetId ?? null;
      node.metadata = {
        ...node.metadata,
        vnetAttachment: {
          vnetId: cluster.metadata.vnetConfig.vnetId,
          subnetId: cluster.metadata.vnetConfig.subnetId,
          privateIp: workerServer.private_ip,
          attachedAt: new Date().toISOString(),
          source: 'create-time',
        },
      };
    }
    await this.nodeRepository.save(node);

    await this.billingIntervals.openNodeInterval({
      clusterId: cluster.id,
      nodeId: node.id,
      serverName: node.serverName,
      providerResourceId: node.providerResourceId,
      provider: cluster.provider,
      region: cluster.region,
      location: workerServer.location,
      serverType: cluster.nodeSize,
      nodeType: node.nodeType,
    });

    this.logger.log(
      `Worker node ${serverName} provisioned (privateIp=${node.privateIp ?? 'none'}). Waiting for K3s join...`,
    );

    try {
      await this.waitForNodeReady(cluster, serverName);
    } catch (err) {
      node.status = NodeStatus.ERROR;
      node.metadata = {
        ...node.metadata,
        joinError: {
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        },
      };
      await this.nodeRepository.save(node);
      // Clean up the half-joined K3s artifacts so a subsequent retry with the
      // same hostname can register a fresh node-password. Without this the
      // master rejects the second agent's password as a duplicate-hostname
      // mismatch and the cluster ends up with a permanent NotReady ghost.
      await this.cleanupK3sNodeArtifacts(cluster, serverName);
      throw err;
    }

    this.logger.log(`Worker node ${serverName} joined cluster and is Ready`);
    return node;
  }

  /**
   * Poll the cluster until the named node appears Ready in the Kubernetes API.
   * Throws an explicit error on timeout — caller should surface it as the
   * operation failure reason.
   */
  private async waitForNodeReady(
    cluster: ClusterEntity,
    nodeName: string,
    timeoutMs = 240000,
    intervalMs = 10000,
  ): Promise<void> {
    if (!cluster.kubeconfigEncrypted) {
      throw new Error(
        `Cluster ${cluster.name} has no kubeconfig — cannot verify node ${nodeName} join`,
      );
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    const { coreApi } = this.kubernetesService.getKubeClient(kubeconfig);

    const deadline = Date.now() + timeoutMs;
    let lastErr: string | undefined;

    while (Date.now() < deadline) {
      try {
        const resp = await coreApi.readNode({ name: nodeName });
        const node = (resp as any).body ?? resp;
        const conditions = node?.status?.conditions ?? [];
        const ready = conditions.find((c: any) => c.type === 'Ready');
        if (ready?.status === 'True') {
          this.logger.log(
            `Node ${nodeName} joined cluster and is Ready (took ~${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)}s)`,
          );
          return;
        }
        lastErr = ready
          ? `Ready=${ready.status} (${ready.reason ?? 'no reason'}: ${ready.message ?? ''})`
          : 'Ready condition missing';
      } catch (err: any) {
        const code = err?.code ?? err?.response?.statusCode;
        if (code === 404) {
          lastErr = 'node not yet registered with API server';
        } else {
          lastErr = err?.message ?? String(err);
        }
      }
      await this.sleep(intervalMs);
    }

    throw new Error(
      `Node ${nodeName} did not become Ready within ${Math.round(timeoutMs / 1000)}s. ` +
        `Server provisioned but K3s agent join failed or unreachable. Last status: ${lastErr ?? 'unknown'}. ` +
        `Investigate via SSH (cloud-init logs, /var/log/k3s-worker-init.log, journalctl -u k3s-agent).`,
    );
  }

  /**
   * Remove leftover K3s artifacts for a node hostname:
   *   - the Node object in the API server
   *   - the `<nodename>.node-password.k3s` Secret in kube-system
   *
   * K3s rejects subsequent joins for the same hostname when the stored
   * node-password hash doesn't match what the new agent presents — so a
   * partial-join failure leaves the hostname unusable until both are gone.
   * Best-effort: 404s are swallowed so the caller can run this idempotently
   * before retries or in the explicit removeWorker flow.
   */
  private async cleanupK3sNodeArtifacts(
    cluster: ClusterEntity,
    nodeName: string,
  ): Promise<void> {
    if (!cluster.kubeconfigEncrypted) return;
    let coreApi: any;
    try {
      const kubeconfig = this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted,
      );
      coreApi = this.kubernetesService.getKubeClient(kubeconfig).coreApi;
    } catch (err) {
      this.logger.warn(
        `cleanupK3sNodeArtifacts: cannot read kubeconfig for cluster ${cluster.id}: ${(err as Error).message}`,
      );
      return;
    }
    try {
      await coreApi.deleteNode({ name: nodeName });
      this.logger.log(`Deleted K3s node ${nodeName}`);
    } catch (err: any) {
      const code = err?.code ?? err?.response?.statusCode;
      if (code !== 404) {
        this.logger.warn(
          `Failed to delete K3s node ${nodeName}: ${err?.message ?? err}`,
        );
      }
    }
    try {
      await coreApi.deleteNamespacedSecret({
        name: `${nodeName}.node-password.k3s`,
        namespace: 'kube-system',
      });
      this.logger.log(`Deleted node-password secret for ${nodeName}`);
    } catch (err: any) {
      const code = err?.code ?? err?.response?.statusCode;
      if (code !== 404) {
        this.logger.warn(
          `Failed to delete node-password secret for ${nodeName}: ${err?.message ?? err}`,
        );
      }
    }
  }

  /**
   * Resolve provider-side network IDs to attach when creating a server.
   * Uses the cluster's vnetConfig.vnetId (Flui UUID) to look up the provider VNet ID.
   */
  private async resolveProviderNetworkIds(
    cluster: ClusterEntity,
  ): Promise<string[] | undefined> {
    const vnetId = cluster.metadata?.vnetConfig?.vnetId;
    if (!vnetId) {
      return undefined;
    }
    try {
      const vnet = await this.vnetsService.getVNet(vnetId);
      return vnet.providerResourceId ? [vnet.providerResourceId] : undefined;
    } catch (err) {
      this.logger.error(
        `Failed to resolve provider network ID for VNet ${vnetId}: ${err.message}`,
      );
      throw err;
    }
  }

  /**
   * Attach a cluster node to VNet
   */
  private async attachNodeToVNet(
    node: ClusterNodeEntity,
    vnetConfig: any,
    cluster: ClusterEntity,
  ): Promise<void> {
    try {
      if (!node.providerResourceId) {
        throw new Error(
          'Node must have a provider resource ID before VNet attachment',
        );
      }

      // Determine which subnet to use
      let subnetId = vnetConfig.subnetId;

      // If no specific subnet provided, get the first available subnet from the VNet
      if (!subnetId) {
        const subnetsResponse = await this.subnetsService.listSubnets({
          vnetId: vnetConfig.vnetId,
        });
        if (!subnetsResponse.subnets || subnetsResponse.subnets.length === 0) {
          throw new Error(`No subnets found in VNet ${vnetConfig.vnetId}`);
        }
        subnetId = subnetsResponse.subnets[0].id;
        this.logger.log(
          `Auto-selected subnet ${subnetId} for node ${node.serverName}`,
        );
      }

      // Attach server to subnet
      const attachmentDto = {
        serverId: node.providerResourceId,
        ip: vnetConfig.autoAssignIp === false ? vnetConfig.ip : undefined,
      };

      await this.subnetsService.attachServerToSubnet(subnetId, attachmentDto);

      node.subnetId = subnetId;
      node.metadata = {
        ...node.metadata,
        vnetAttachment: {
          vnetId: vnetConfig.vnetId,
          subnetId: subnetId,
          attachedAt: new Date().toISOString(),
          autoAssignedIp: vnetConfig.autoAssignIp !== false,
        },
      };

      await this.nodeRepository.save(node);

      this.logger.log(
        `Successfully attached node ${node.serverName} (${node.providerResourceId}) to subnet ${subnetId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to attach node ${node.serverName} to VNet: ${error.message}`,
        error.stack,
      );
      // Don't throw - log the error but continue cluster creation
      // Store error in node metadata for troubleshooting
      node.metadata = {
        ...node.metadata,
        vnetAttachmentError: {
          message: error.message,
          timestamp: new Date().toISOString(),
        },
      };
      await this.nodeRepository.save(node);
    }
  }

  /**
   * Wait for an operation to complete
   */
  private async waitForOperation(
    operationId: string,
    maxWaitMs = 600000,
  ): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 5000; // 5 seconds
    let checks = 0;

    this.logger.log(
      `Waiting for operation ${operationId} (timeout: ${maxWaitMs / 1000}s)`,
    );

    while (Date.now() - startTime < maxWaitMs) {
      await this.sleep(checkInterval);
      checks++;

      const operation = await this.operationRepository.findOne({
        where: { id: operationId },
      });

      if (!operation) {
        throw new Error(`Operation ${operationId} not found`);
      }

      this.logger.log(
        `Operation ${operationId} check #${checks}: status=${operation.status} ` +
          `progress=${operation.progress ?? 0}% elapsed=${Math.round((Date.now() - startTime) / 1000)}s` +
          (operation.metadata?.message
            ? ` msg="${operation.metadata.message}"`
            : ''),
      );

      if (operation.status === OperationStatus.COMPLETED) {
        this.logger.log(
          `Operation ${operationId} completed after ${checks} checks (${Math.round((Date.now() - startTime) / 1000)}s)`,
        );
        return;
      }

      if (operation.status === OperationStatus.FAILED) {
        // Guard against a stale FAILED status from a previous Bull retry attempt:
        // if this operation was JUST created (less than checkInterval ago) and
        // it is already FAILED without having been IN_PROGRESS, it is a leftover from
        // a prior job invocation — wait one more cycle before giving up.
        const ageMs = operation.updatedAt
          ? Date.now() - new Date(operation.updatedAt).getTime()
          : 0;
        if (checks === 1 && ageMs > maxWaitMs / 2) {
          this.logger.warn(
            `Operation ${operationId} found in FAILED state on first check ` +
              `(age: ${Math.round(ageMs / 1000)}s) — likely a stale status from a previous attempt, waiting one more cycle`,
          );
          continue;
        }

        const errorMsg =
          operation.errorMessage ||
          operation.metadata?.error ||
          'Unknown error';
        this.logger.error(
          `Operation ${operationId} FAILED after ${checks} checks: ${errorMsg} ` +
            `| metadata: ${JSON.stringify(operation.metadata)}`,
        );
        throw new Error(`Operation failed: ${errorMsg}`);
      }
    }

    throw new Error(
      `Operation ${operationId} timed out after ${maxWaitMs / 1000}s (${checks} checks)`,
    );
  }

  /**
   * Update operation progress
   */
  /**
   * Report progress *within the step the caller is already in*, resolved from the
   * operation row rather than passed in — node creation is driven from several
   * flows (create-cluster master, create-cluster workers, add-worker) that each
   * sit at a different step index.
   *
   * `stepProgress` is 0-100 of the current step, not of the operation. Writing
   * only the flat `progress` field, as this used to, meant the UI never saw any
   * of it: the tracker derives its bar from the step weights and
   * currentStepProgress and ignores `progress` whenever the operation carries
   * steps. The bar sat at the step's floor for the entire wait — 147s of the 148s
   * a single-node create takes — and then jumped to done.
   */
  private async updateOperationProgress(
    operationId: string,
    stepProgress: number,
    message: string,
  ): Promise<void> {
    const operation = await this.operationRepository.findOne({
      where: { id: operationId },
    });
    if (!operation) return;

    const savedSteps = operation.metadata?.operationSteps ?? [];
    operation.currentStepProgress = stepProgress;
    operation.progress = savedSteps.length
      ? calculateOperationProgressFromSaved(
          savedSteps,
          operation.currentStepIndex ?? 0,
          stepProgress,
        )
      : stepProgress;
    operation.metadata = {
      ...operation.metadata,
      message,
      timestamp: new Date(),
    };
    await this.operationRepository.save(operation);

    this.logger.debug(
      `Operation ${operationId}: step ${operation.currentStepIndex} at ${stepProgress}% (overall ${operation.progress}%) - ${message}`,
    );
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get control cluster if it exists and is ready
   * Returns null if no control cluster exists or if it's not ready
   */
  private debugLogBootstrapKey(
    label: string,
    serverName: string,
    bootstrapKey: { privateKey: string; publicKey: string },
  ): void {
    if (process.env.DEBUG_LOG_BOOTSTRAP_KEYS !== 'true') return;
    this.logger.warn('='.repeat(80));
    this.logger.warn(`DEBUG MODE: Bootstrap SSH Key (${label})`);
    this.logger.warn('Server: ' + serverName);
    this.logger.warn('='.repeat(80));
    this.logger.warn('PRIVATE KEY:');
    this.logger.warn(bootstrapKey.privateKey);
    this.logger.warn('='.repeat(80));
    this.logger.warn('PUBLIC KEY:');
    this.logger.warn(bootstrapKey.publicKey);
    this.logger.warn('='.repeat(80));
  }

  /**
   * The cluster's bootstrap keypair, minted once and reused for every node and
   * every retry.
   *
   * Regenerating is unrecoverable: the public half only reaches the node via
   * cloud-init, which is frozen at server-create time and runs once on first
   * boot. A retry reuses the existing server (creation is idempotent by name),
   * so a fresh key is never installed on it and every later SSH gets
   * "Permission denied (publickey)".
   */
  private async ensureBootstrapKey(
    cluster: ClusterEntity,
    nodeType: 'master' | 'worker',
  ): Promise<{ id: string; publicKey: string; privateKey: string }> {
    const existing = await this.accessService.getBootstrapKeyMaterialForCluster(
      cluster.id,
    );
    if (existing) {
      this.logger.log(
        `Reusing bootstrap key ${existing.id} for cluster ${cluster.name} (${nodeType})`,
      );
      return existing;
    }

    this.logger.log(`Generating bootstrap key for cluster ${cluster.name}`);
    const generated = await this.keyGenerator.generateKeyPair('ed25519');
    this.debugLogBootstrapKey(nodeType.toUpperCase(), cluster.name, generated);

    const saved = await this.accessService.createSSHKey({
      name: `flui-bootstrap-cluster-${cluster.name}`,
      public_key: generated.publicKey,
      private_key: generated.privateKey, // Will be encrypted in storage
      fingerprint: generated.fingerprint,
      type: 'ed25519',
      temporary: true, // Marked for cleanup once CA enrollment has happened
      metadata: {
        purpose: 'bootstrap',
        scope: 'cluster',
        clusterId: cluster.id,
        clusterName: cluster.name,
      },
      tags: {
        'cluster-id': cluster.id,
        'cluster-name': cluster.name,
        purpose: 'bootstrap',
        'node-type': 'master',
        'auto-generated': 'true',
      },
    });

    // Record before anything can fail: an unrecorded key is one a retry can't find.
    cluster.bootstrapKeyId = saved.id;
    await this.clusterRepository.update(cluster.id, {
      bootstrapKeyId: saved.id,
    });

    return {
      id: saved.id,
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
    };
  }

  /**
   * Idempotent by (clusterId, serverName): the queue re-runs node creation from
   * the top on retry, while server creation is idempotent by name. A blind insert
   * would pile up duplicate rows pointing at the same server — inflating the
   * cluster's recomputed nodeCount — and mint a fresh node.id that no longer
   * matches the SERVER_ID the already-booted node reports for its metrics.
   */
  private async ensureNodeRecord(
    clusterId: string,
    serverName: string,
    nodeType: NodeType,
    metadata: Record<string, unknown> = {},
  ): Promise<ClusterNodeEntity> {
    const existing = await this.nodeRepository.findOne({
      where: { clusterId, serverName },
    });
    if (existing) {
      this.logger.log(
        `Reusing node record ${existing.id} for ${nodeType} ${serverName}`,
      );
      return existing;
    }
    const node = await this.nodeRepository.save(
      this.nodeRepository.create({
        clusterId,
        serverName,
        providerResourceId: '', // Will be updated after server creation
        nodeType,
        status: NodeStatus.CREATING,
        metadata,
      }),
    );
    this.logger.log(
      `Created node record with ID ${node.id} for ${nodeType} ${serverName}`,
    );
    return node;
  }

  private async loadCaKeyPair(): Promise<{
    caPublicKey: string;
    caPrivateKey: string;
  }> {
    const caPublicKey = await this.caManager.getCAPublicKey();
    this.logger.log(
      `CA public key preview: ${caPublicKey.substring(0, 60)}...`,
    );

    let caPrivateKey: string;
    try {
      caPrivateKey = await this.caManager.getCAPrivateKey();
    } catch (e) {
      throw new Error(
        `Cannot provision a new cluster: SSH CA private key is not available ` +
          `(env SSH_CA_PRIVATE_KEY empty, no file at ~/.flui/profiles/<profile>/ca/ca_key, ` +
          `and no encrypted private key in the certificate_authorities table). ` +
          `The freshly-created cluster would be unable to issue ephemeral SSH ` +
          `certs (Dashboard terminal, in-cluster ops). ` +
          `Underlying: ${(e as Error).message}`,
      );
    }
    this.logger.log(
      `CA private key resolved — will be injected into flui-secrets`,
    );
    return { caPublicKey, caPrivateKey };
  }

  private async resolveWorkerObservabilityIp(
    cluster: ClusterEntity,
  ): Promise<string | undefined> {
    if (cluster.clusterType === ClusterType.WORKLOAD) {
      try {
        const obsCluster = await this.getControlCluster();
        if (
          obsCluster &&
          (obsCluster.masterPrivateIp || obsCluster.masterIpAddress)
        ) {
          return obsCluster.masterPrivateIp ?? obsCluster.masterIpAddress;
        }
      } catch (error) {
        this.logger.error(
          `Error retrieving control cluster for worker node: ${error.message}`,
        );
      }
      return undefined;
    }
    if (isControlClusterType(cluster.clusterType)) {
      return cluster.masterPrivateIp ?? cluster.masterIpAddress ?? undefined;
    }
    return undefined;
  }

  private async resolveControlClusterIp(
    cluster: ClusterEntity,
  ): Promise<string | undefined> {
    if (cluster.clusterType !== ClusterType.WORKLOAD) {
      this.logger.log(
        `📊 This is an control cluster - will NOT connect to remote control cluster`,
      );
      return undefined;
    }
    this.logger.log(
      `📊 This is a WORKLOAD cluster - checking for control cluster...`,
    );
    try {
      const obsCluster = await this.getControlCluster();
      if (
        obsCluster &&
        (obsCluster.masterPrivateIp || obsCluster.masterIpAddress)
      ) {
        // Cross-provider: the vnet/private IP is not routable off the master's
        // provider, so a workload on a different provider must push to the
        // public IP (the firewall opens the ingest ports to it — MVP-3).
        const crossProvider = obsCluster.provider !== cluster.provider;
        const ip = crossProvider
          ? obsCluster.masterIpAddress
          : (obsCluster.masterPrivateIp ?? obsCluster.masterIpAddress);
        if (ip) {
          this.logger.log(
            `✅ Using control cluster at ${ip} for monitoring${crossProvider ? ' (cross-provider public IP)' : ''}`,
          );
          this.logger.debug(
            `   Will pass OBSERVABILITY_CLUSTER_IP=${ip} to bootstrap script`,
          );
          return ip;
        }
        this.logger.warn(
          `⚠️ Control cluster has no ${crossProvider ? 'public' : ''} IP for cross-provider monitoring`,
        );
      }
      if (obsCluster) {
        this.logger.warn(
          `⚠️ Control cluster exists but is not ready (status: ${obsCluster.status})`,
        );
      } else {
        this.logger.warn(
          '⚠️ No control cluster found - cluster will have limited monitoring capabilities',
        );
      }
      this.logger.warn(
        `   OBSERVABILITY_CLUSTER_IP will be empty - cluster will use localhost for monitoring`,
      );
    } catch (error) {
      this.logger.error(
        `❌ Error retrieving control cluster: ${error.message}. Proceeding without remote monitoring.`,
        error.stack,
      );
      this.logger.warn(
        `   OBSERVABILITY_CLUSTER_IP will be empty - cluster will use localhost for monitoring`,
      );
    }
    return undefined;
  }

  private async getControlCluster(): Promise<ClusterEntity | null> {
    try {
      this.logger.debug('🔍 Searching for control cluster in database...');

      const obsCluster = await this.clusterRepository.findOne({
        where: {
          clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
        },
        order: {
          createdAt: 'DESC', // Get most recent if multiple exist
        },
      });

      if (!obsCluster) {
        this.logger.warn(
          '❌ No control cluster found in database (clusterType = OBSERVABILITY)',
        );
        return null;
      }

      this.logger.debug(
        `✅ Found control cluster: ${obsCluster.name} (id: ${obsCluster.id})`,
      );
      this.logger.debug(
        `   - Status: ${obsCluster.status} (required: ${ClusterStatus.READY})`,
      );
      this.logger.debug(
        `   - Master IP: ${obsCluster.masterIpAddress || 'NOT SET'}`,
      );
      this.logger.debug(`   - Created: ${obsCluster.createdAt}`);

      // Only return if cluster is READY and has master IP
      if (
        obsCluster.status === ClusterStatus.READY &&
        obsCluster.masterIpAddress
      ) {
        this.logger.log(
          `✅ Control cluster is READY with master IP: ${obsCluster.masterIpAddress}`,
        );
        return obsCluster;
      }

      if (obsCluster.status !== ClusterStatus.READY) {
        this.logger.warn(
          `⚠️ Control cluster exists but status is ${obsCluster.status} (not READY)`,
        );
      }

      if (!obsCluster.masterIpAddress) {
        this.logger.warn(
          `⚠️ Control cluster exists but masterIpAddress is not set`,
        );
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Error retrieving control cluster: ${error.message}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Decide which master IP the kubeconfig's API-server URL should point at.
   *
   * Default (and every control cluster): the private VNet IP — 6443 is never
   * exposed publicly for same-network clusters. A WORKLOAD cluster that does not
   * share a private network with the control (the typical cross-provider case:
   * BYOS control, or a workload on a different provider/VNet) cannot reach that
   * private IP, so we bake the master's PUBLIC IP instead. This is decided per
   * cluster, never a global default, and only ever flips a workload to public.
   */
  private async resolveKubeconfigServerIp(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<string> {
    const privateFirst = node.privateIp ?? node.ipAddress;
    if (cluster.clusterType !== ClusterType.WORKLOAD) return privateFirst;

    let control: ClusterEntity | null = null;
    try {
      control = await this.getControlCluster();
    } catch (err) {
      this.logger.warn(
        `[kubeconfig] control lookup failed (${(err as Error).message}); ` +
          `defaulting to private IP ${privateFirst}`,
      );
      return privateFirst;
    }

    if (control && this.sharesPrivateNetworkWithControl(cluster, control)) {
      return privateFirst;
    }
    // No shared private network with the control → private IP is unroutable.
    this.logger.log(
      `[kubeconfig] workload ${cluster.name} does not share a private network ` +
        `with the control cluster — baking public API-server IP ${node.ipAddress}`,
    );
    return node.ipAddress;
  }

  /**
   * True when a workload and the control cluster sit on the same private network
   * and can therefore reach each other over private IPs. Requires the same
   * provider and the same VNet; if both pin an explicit subnet, the same subnet.
   * A control with no VNet config (e.g. BYOS) never shares — returns false.
   */
  private sharesPrivateNetworkWithControl(
    workload: ClusterEntity,
    control: ClusterEntity,
  ): boolean {
    if (workload.provider !== control.provider) return false;
    type VNetRef = { vnetId?: string; subnetId?: string };
    const w = (workload.metadata as { vnetConfig?: VNetRef })?.vnetConfig;
    const c = (control.metadata as { vnetConfig?: VNetRef })?.vnetConfig;
    if (!w?.vnetId || !c?.vnetId) return false;
    if (w.vnetId !== c.vnetId) return false;
    if (w.subnetId && c.subnetId && w.subnetId !== c.subnetId) return false;
    return true;
  }

  /** Bounded by wall clock, not attempt count: an attempt costs SSH time plus
   *  the delay, so a count-based budget shrinks as failures get faster. Stays
   *  under the queue's 30min job timeout, which would re-run the whole handler. */
  private static readonly KUBECONFIG_FETCH_DEADLINE_MS = 15 * 60 * 1000;
  private static readonly KUBECONFIG_FETCH_INTERVAL_MS = 15000;
  /** Measured on Hetzner hel1: cloud-init reaches k3s.yaml ~106s after the
   *  server answers. Only paces the progress bar — never gates the fetch. */
  private static readonly KUBECONFIG_TYPICAL_WAIT_MS = 110_000;

  /**
   * Fetch kubeconfig from master node via SSH using the bootstrap key.
   * Polls until k3s has written /etc/rancher/k3s/k3s.yaml, then replaces
   * 127.0.0.1 with the public IP.
   */
  private async fetchKubeconfigFromMaster(
    masterIp: string,
    bootstrapPrivateKey: string,
    serverIp: string,
    onWaiting?: (elapsedMs: number) => Promise<void>,
  ): Promise<string> {
    const started = Date.now();
    const deadline =
      started + ClusterOrchestrationService.KUBECONFIG_FETCH_DEADLINE_MS;
    let attempt = 0;
    let lastError = 'never attempted';

    while (Date.now() < deadline) {
      attempt++;
      const remainingMs = deadline - Date.now();
      try {
        this.logger.log(
          `Fetching kubeconfig via SSH (attempt ${attempt}, ${Math.round(remainingMs / 1000)}s left)...`,
        );
        const raw = await this.nativeSsh.execCommand(
          masterIp,
          'root',
          bootstrapPrivateKey,
          'cat /etc/rancher/k3s/k3s.yaml',
          20000,
        );

        if (!raw?.includes('apiVersion')) {
          throw new Error('Invalid kubeconfig received');
        }

        // serverIp is the private VNet IP by default; resolveKubeconfigServerIp
        // supplies the public IP for cross-network workloads (see its doc).
        const kubeconfig = raw.replaceAll('127.0.0.1', serverIp);
        this.logger.log('✅ Kubeconfig fetched successfully from master');
        return kubeconfig;
      } catch (err) {
        lastError = err.message;

        // Rejected credentials never become accepted ones by waiting, and
        // burning the deadline hides the cause behind what reads as a slow boot.
        if (/permission denied|denied \(publickey\)/i.test(lastError)) {
          throw new Error(
            `Master rejected the bootstrap key — it is not the key installed at first boot, ` +
              `so no amount of waiting will help: ${lastError}`,
          );
        }

        this.logger.warn(
          `Kubeconfig fetch attempt ${attempt} failed: ${lastError}`,
        );
        await onWaiting?.(Date.now() - started);
        await this.sleep(
          Math.min(
            ClusterOrchestrationService.KUBECONFIG_FETCH_INTERVAL_MS,
            Math.max(0, deadline - Date.now()),
          ),
        );
      }
    }

    throw new Error(
      `Failed to fetch kubeconfig within ${Math.round(
        ClusterOrchestrationService.KUBECONFIG_FETCH_DEADLINE_MS / 60000,
      )} minutes (${attempt} attempts): ${lastError}`,
    );
  }
}
