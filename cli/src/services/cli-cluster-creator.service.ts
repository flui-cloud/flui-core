import { Injectable, Logger } from '@nestjs/common';
import {
  ClusterEntity,
  ClusterStatus,
  isControlClusterType,
} from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import {
  NodeType,
  NodeStatus,
} from 'src/modules/infrastructure/clusters/entities/cluster-node.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from 'src/modules/infrastructure/servers/entities/infrastructure-operations.entity';
import { CliClusterRepository } from '../lib/repositories/cli-cluster.repository';
import { CliNodeRepository } from '../lib/repositories/cli-node.repository';
import { CliOperationRepository } from '../lib/repositories/cli-operation.repository';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { EncryptionService } from 'src/modules/shared/encryption/services/encryption.service';
import { CliK3sScriptService } from './cli-k3s-script.service';
import { buildNipBaseDomain } from '../lib/nip-base-domain.util';
import { LabelService } from 'src/modules/infrastructure/shared/services/label.service';
import { CliCaService } from './cli-ca.service';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ProfileManager } from '../lib/profile-manager';
import * as https from 'node:https';

import { HetznerFirewallService } from 'src/modules/providers/services/hetzner-firewall.service';
import { CliFirewallRepository } from '../lib/repositories/cli-firewall.repository';
import { CliSshService } from './cli-ssh.service';
import { CliLoggerService } from './cli-logger.service';
import { CliVnetRepository } from '../lib/repositories/cli-vnet.repository';

/**
 * CLI Cluster Creator Service
 *
 * Creates K3s clusters synchronously without Bull queue.
 * This service bypasses the queue processor and creates infrastructure directly.
 */
@Injectable()
export class CliClusterCreatorService {
  private readonly logger = new Logger(CliClusterCreatorService.name);

  constructor(
    private readonly clusterRepository: CliClusterRepository,
    private readonly nodeRepository: CliNodeRepository,
    private readonly operationRepository: CliOperationRepository,
    private readonly providerFactory: ProviderFactory,
    private readonly encryptionService: EncryptionService,
    private readonly k3sScriptService: CliK3sScriptService,
    private readonly labelService: LabelService,
    private readonly caService: CliCaService,
    private readonly firewallService: HetznerFirewallService,
    private readonly firewallRepository: CliFirewallRepository,
    private readonly sshService: CliSshService,
    private readonly cliLoggerService: CliLoggerService,
    private readonly vnetRepository: CliVnetRepository,
  ) {}

  /** Log to both NestJS stdout and operation log file */
  private log(
    operationId: string,
    message: string,
    level: 'INFO' | 'WARN' | 'ERROR' = 'INFO',
  ): void {
    if (level === 'ERROR') this.logger.error(message);
    else if (level === 'WARN') this.logger.warn(message);
    else this.logger.log(message);
    this.cliLoggerService.writeLog(operationId, message, level);
  }

  /**
   * Create cluster synchronously (bypasses Bull queue)
   */
  async createClusterSync(
    cluster: ClusterEntity,
    operation: InfrastructureOperationEntity,
  ): Promise<void> {
    const opId = operation.id;
    this.log(
      opId,
      `[CLI Mode] Creating cluster ${cluster.name} synchronously...`,
    );

    try {
      // Update operation status
      operation.status = OperationStatus.IN_PROGRESS;
      operation.currentStepIndex = 0;
      await this.operationRepository.save(operation);

      // Get cloud provider
      const provider = this.providerFactory.getProvider(
        cluster.provider as any,
      );

      // For CLI mode, we'll use provider-generated SSH keys or user-specified ones
      // This avoids the AccessService database dependency
      // Decrypt K3s token
      const k3sToken = this.encryptionService.decrypt(
        cluster.k3sTokenEncrypted,
      );

      // Get firewall ID from metadata if pre-created
      const metadata = operation.metadata as any;
      const firewallId = metadata?.firewallId;

      // Step 1: Create master node
      this.log(opId, 'Creating master node...');
      operation.currentStepIndex = 1;
      await this.operationRepository.save(operation);

      const masterServerName = `${cluster.name}-master`;
      const masterLabels = [
        { key: 'managed-by', value: 'flui-cloud' },
        { key: 'flui-cluster-id', value: cluster.id },
        { key: 'flui-resource-type', value: 'cluster-node' },
        { key: 'flui-node-type', value: 'master' },
      ];

      // Generate bootstrap SSH key for master node
      const masterBootstrapKey = await this.generateBootstrapKey(
        provider,
        cluster.id,
        masterServerName,
      );

      // Get CA public key for enrollment
      const caPublicKey = await this.caService.getCaPublicKey();

      const decrypted = this.decryptClusterSecrets(cluster);
      const {
        postgresPassword,
        redisPassword,
        grafanaPassword,
        encryptionKey,
        fluiApiKey,
        providerToken,
        providerScalewayAccessKey,
        providerScalewaySecretKey,
        providerRegions,
        zitadelMasterkey,
        zitadelDbAdminPassword,
        zitadelDbUserPassword,
        zitadelAdminTempPassword,
        jwtSecret,
        adminEmail,
        adminPassword,
      } = decrypted;
      const clusterMeta = cluster.metadata as any;

      const envVnet = clusterMeta?.envVnet as
        | {
            vnetProviderResourceId: string;
            vnetIpRange: string;
            subnetProviderResourceId: string;
            subnetIpRange: string;
            subnetType: string;
            networkZone: string;
          }
        | undefined;

      // Create master node entity FIRST to get the database ID
      const masterNode = this.nodeRepository.create({
        cluster,
        clusterId: cluster.id,
        providerResourceId: '', // Will be updated after server creation
        serverName: masterServerName,
        nodeType: NodeType.MASTER,
        status: NodeStatus.CREATING,
        ipAddress: '', // Will be updated after server creation
        metadata: {},
      });
      await this.nodeRepository.save(masterNode);
      this.log(opId, `Master node database record created: ${masterNode.id}`);

      // Resolve Flui shared storage config (NFS+fscache, see scaling doc §14).
      // Default: enabled. Master gets a Volume hosting the NFS export; workers
      // mount it via NFSv4 + fscache. Disabled at creation via --no-shared-storage.
      const sharedStorageEnabled = cluster.sharedStorageEnabled !== false;
      const sharedStorageVolumeSizeGb = cluster.sharedStorageVolumeSizeGb ?? 20;

      const masterUserData = await this.k3sScriptService.generateMasterScript({
        serverId: masterNode.id, // Use database node ID
        clusterId: cluster.id,
        clusterName: cluster.name,
        k3sToken,
        instanceId: `${cluster.name}-master`,
        instanceName: masterServerName,
        provider: cluster.provider,
        caPublicKey,
        operationId: operation.id,
        deployObservabilityStack: isControlClusterType(cluster.clusterType),
        postgresPassword,
        redisPassword,
        grafanaPassword,
        authMode: clusterMeta?.authMode || 'local',
        jwtSecret,
        adminEmail,
        adminPassword,
        encryptionKey,
        zitadelMasterkey,
        zitadelDbAdminPassword,
        zitadelDbUserPassword,
        zitadelAdminTempPassword,
        fluiApiKey,
        providerApiKey: providerToken,
        providerScalewayAccessKey,
        providerScalewaySecretKey,
        providerRegions,
        clusterRegion: cluster.region,
        instanceType: cluster.nodeSize,
        clusterFirewallId: firewallId || '',
        nipIoCertEnabled: !clusterMeta?.zitadelDomain,
        acmeStaging: !!clusterMeta?.acmeStaging,
        useLatest: !!clusterMeta?.useLatest,
        nipHostnameToken: cluster.nipHostnameToken || null,
        envVnet: envVnet
          ? {
              vnetProviderResourceId: envVnet.vnetProviderResourceId,
              vnetProvider: cluster.provider,
              vnetName: 'flui-env-vnet',
              vnetIpRange: envVnet.vnetIpRange,
              subnetProviderResourceId: envVnet.subnetProviderResourceId,
              subnetIpRange: envVnet.subnetIpRange,
              subnetType: envVnet.subnetType,
              networkZone: envVnet.networkZone,
            }
          : undefined,
        sharedStorage: sharedStorageEnabled
          ? {
              enabled: true,
              volumeSizeGb: sharedStorageVolumeSizeGb,
            }
          : undefined,
      });

      const masterServer = await provider.createServer({
        name: masterServerName,
        image: cluster.image,
        server_type: cluster.nodeSize,
        location: cluster.region,
        ssh_keys: [masterBootstrapKey.keyId],
        labels: masterLabels,
        user_data: masterUserData,
        firewalls: firewallId ? [firewallId] : undefined,
        networks: envVnet ? [envVnet.vnetProviderResourceId] : undefined,
        attachedVolumes: sharedStorageEnabled
          ? [
              {
                name: `${cluster.name}-flui-shared`,
                sizeGb: sharedStorageVolumeSizeGb,
                labels: masterLabels,
              },
            ]
          : undefined,
      });

      // Persist Flui shared storage Volume id for cleanup at destroy time.
      if (sharedStorageEnabled && masterServer.attachedVolumes?.[0]) {
        cluster.sharedStorageVolumeId =
          masterServer.attachedVolumes[0].volumeId;
        cluster.sharedStorageVolumeSizeGb =
          masterServer.attachedVolumes[0].sizeGb ?? sharedStorageVolumeSizeGb;
      }

      masterNode.providerResourceId = masterServer.serverId;
      masterNode.ipAddress = masterServer.ipAddress;
      masterNode.privateIp = masterServer.privateIp;
      await this.nodeRepository.save(masterNode);

      if (envVnet) {
        await this.vnetRepository.attachServerToVNet(
          envVnet.vnetProviderResourceId,
          masterServer.serverId,
        );
      }

      cluster.masterIpAddress = masterServer.ipAddress;
      cluster.nodeCount = 1;
      await this.clusterRepository.save(cluster);

      this.log(opId, `Master node created: ${masterServer.ipAddress}`);

      // Step 2: Wait for observability stack to be ready
      this.log(opId, 'Waiting for observability stack deployment...');
      operation.currentStepIndex = 2;
      await this.operationRepository.save(operation);

      await this.waitForObservabilityStackReady(
        masterServer.ipAddress,
        1800000, // 30 min timeout (deployment can take time)
        cluster.nipHostnameToken,
      );

      this.log(opId, '✅ Observability stack is fully deployed and ready');

      // Step 3a: Fetch real kubeconfig from K3s master via SSH
      this.log(opId, 'Fetching kubeconfig from K3s master...');
      const kubeconfig = await this.fetchKubeconfig(cluster.masterIpAddress);
      cluster.kubeconfigEncrypted = this.encryptionService.encrypt(kubeconfig);
      await this.clusterRepository.save(cluster);
      this.log(opId, '✅ Kubeconfig generated and encrypted');

      // Step 3b: Patch Kubernetes secret with SSH CA keys + bootstrap seeder vars
      await this.createApiCredentialsSecret(opId, cluster.masterIpAddress, {
        fluiApiKey,
        providerToken,
        providerScalewayAccessKey,
        providerScalewaySecretKey,
        providerRegions,
        clusterRegion: cluster.region,
        instanceType: cluster.nodeSize,
        envVnet,
        bootstrapNodePrivateIp: masterServer.privateIp,
        provider: cluster.provider,
        sharedStorageVolumeId: cluster.sharedStorageVolumeId ?? undefined,
        sharedStorageVolumeSizeGb:
          cluster.sharedStorageVolumeSizeGb ?? undefined,
      });

      // Step 3c: Informational — Zitadel PAT injected on demand via sync-auth-domain
      if (isControlClusterType(cluster.clusterType)) {
        this.log(
          opId,
          'ℹ️  Zitadel service account PAT will be injected when sync-auth-domain is called.',
        );
        this.log(
          opId,
          '   After DNS is configured, call: POST /api/v1/clusters/:id/dns-zone/sync-auth-domain',
        );
      }

      masterNode.status = NodeStatus.READY;
      await this.nodeRepository.save(masterNode);

      // Step 4: Create worker nodes if needed
      const workerCount = metadata?.workerCount || 0;

      if (workerCount > 0) {
        this.log(opId, `Creating ${workerCount} worker nodes...`);
        operation.currentStepIndex = 4;
        await this.operationRepository.save(operation);

        for (let i = 0; i < workerCount; i++) {
          const workerServerName = `${cluster.name}-worker-${i + 1}`;
          const workerLabels = [
            { key: 'managed-by', value: 'flui-cloud' },
            { key: 'flui-cluster-id', value: cluster.id },
            { key: 'flui-resource-type', value: 'cluster-node' },
            { key: 'flui-node-type', value: 'worker' },
          ];

          // Generate bootstrap SSH key for worker node
          const workerBootstrapKey = await this.generateBootstrapKey(
            provider,
            cluster.id,
            workerServerName,
          );

          // Create worker node entity FIRST to get the database ID
          const workerNode = this.nodeRepository.create({
            cluster,
            clusterId: cluster.id,
            providerResourceId: '', // Will be updated after server creation
            serverName: workerServerName,
            nodeType: NodeType.WORKER,
            status: NodeStatus.CREATING,
            ipAddress: '', // Will be updated after server creation
            metadata: {},
          });
          await this.nodeRepository.save(workerNode);
          this.log(
            opId,
            `Worker node ${i + 1} database record created: ${workerNode.id}`,
          );

          // Worker shared storage config: mount NFS from master via fscache.
          // Worker only needs masterPrivateIp; the master is already up at
          // this point so we read its private IP from the saved entity.
          const workerSharedStorage =
            sharedStorageEnabled && masterNode.privateIp
              ? {
                  enabled: true,
                  masterPrivateIp: masterNode.privateIp,
                }
              : undefined;

          const workerUserData =
            await this.k3sScriptService.generateWorkerScript({
              serverId: workerNode.id, // Use database node ID
              clusterId: cluster.id,
              clusterName: cluster.name,
              k3sToken,
              masterIp: cluster.masterIpAddress,
              instanceId: `${cluster.name}-worker-${i + 1}`,
              instanceName: workerServerName,
              provider: cluster.provider,
              caPublicKey,
              operationId: operation.id,
              useLatest: !!clusterMeta?.useLatest,
              sharedStorage: workerSharedStorage,
            });

          const workerServer = await provider.createServer({
            name: workerServerName,
            image: cluster.image,
            server_type: cluster.nodeSize,
            location: cluster.region,
            ssh_keys: [workerBootstrapKey.keyId],
            labels: workerLabels,
            user_data: workerUserData,
            firewalls: firewallId ? [firewallId] : undefined,
            networks: envVnet ? [envVnet.vnetProviderResourceId] : undefined,
          });

          workerNode.providerResourceId = workerServer.serverId;
          workerNode.ipAddress = workerServer.ipAddress;
          workerNode.privateIp = workerServer.privateIp;
          await this.nodeRepository.save(workerNode);

          if (envVnet) {
            await this.vnetRepository.attachServerToVNet(
              envVnet.vnetProviderResourceId,
              workerServer.serverId,
            );
          }

          this.log(
            opId,
            `Worker node ${i + 1}/${workerCount} created: ${workerServer.ipAddress}`,
          );
        }

        cluster.nodeCount = 1 + workerCount;
        await this.clusterRepository.save(cluster);
      }

      // Update firewall repository with cluster ID if firewall was used
      if (firewallId) {
        try {
          const firewallRecord =
            await this.firewallRepository.findById(firewallId);

          if (firewallRecord) {
            // Cluster-scoped name so destroy matches by exact name only.
            const scopedFirewallName = `flui-control-firewall-${cluster.id}`;
            firewallRecord.clusterId = cluster.id;
            firewallRecord.name = scopedFirewallName;
            // Get server IDs from cluster nodes
            const serverIds = cluster.nodes.map(
              (node) => node.providerResourceId,
            );
            firewallRecord.appliedToServerIds = serverIds;
            await this.firewallRepository.save(firewallRecord);

            // Update Hetzner firewall labels + name with cluster ID
            try {
              const existingLabels = Object.fromEntries(
                firewallRecord.labels.map((l) => [l.key, l.value]),
              );
              const updatedLabels = {
                ...existingLabels,
                'flui-cluster-id': cluster.id,
                'flui-cluster-name': cluster.name,
              };
              await this.firewallService.updateFirewallLabels(
                firewallId,
                updatedLabels,
                scopedFirewallName,
              );
              this.log(
                opId,
                `✅ Firewall ${firewallId} labels updated on Hetzner with cluster ID`,
              );
            } catch (labelError) {
              this.log(
                opId,
                `Failed to update Hetzner firewall labels: ${labelError.message}`,
                'WARN',
              );
            }

            this.log(
              opId,
              `✅ Firewall ${firewallId} configured for cluster ${cluster.name}`,
            );
          }
        } catch (error) {
          this.log(
            opId,
            `Failed to update firewall record: ${error.message}`,
            'WARN',
          );
        }
      }

      // Mark cluster as READY
      cluster.status = ClusterStatus.READY;
      await this.clusterRepository.save(cluster);

      // Mark operation as COMPLETED
      operation.status = OperationStatus.COMPLETED;
      operation.currentStepIndex = operation.totalSteps;
      await this.operationRepository.save(operation);

      this.log(opId, `Cluster ${cluster.name} created successfully!`);
    } catch (error) {
      this.log(opId, `Failed to create cluster: ${error.message}`, 'ERROR');

      // Roll back the pre-created firewall. If creation failed before the
      // rename/label step it stays with a temporary name and no
      // flui-cluster-id label, which makes it invisible to `env destroy`
      // (it matches neither the label query nor the scoped-name fallback)
      // and leaks as an orphan that blocks the next run's name.
      const orphanFirewallId = (operation.metadata as any)?.firewallId;
      if (orphanFirewallId) {
        try {
          await this.firewallService.deleteFirewall(orphanFirewallId);
          await this.firewallRepository.delete(orphanFirewallId);
          this.log(
            opId,
            `✅ Rolled back firewall ${orphanFirewallId} after failed cluster creation`,
          );
        } catch (cleanupError) {
          this.log(
            opId,
            `Failed to roll back firewall ${orphanFirewallId}: ${cleanupError.message}. ` +
              `Delete it manually on the provider to avoid an orphan.`,
            'WARN',
          );
        }
      }

      // Mark cluster as FAILED
      cluster.status = ClusterStatus.ERROR;
      await this.clusterRepository.save(cluster);

      // Mark operation as FAILED
      operation.status = OperationStatus.FAILED;
      operation.metadata = {
        ...operation.metadata,
        error: error.message,
        errorStack: error.stack,
      };
      await this.operationRepository.save(operation);

      throw error;
    }
  }

  /**
   * Generate bootstrap SSH key for a node
   * Returns the SSH key ID from the cloud provider and local key paths
   */
  private decryptClusterSecrets(cluster: ClusterEntity): {
    postgresPassword: string;
    redisPassword: string;
    grafanaPassword: string;
    encryptionKey: string;
    fluiApiKey: string;
    providerToken: string;
    providerScalewayAccessKey: string;
    providerScalewaySecretKey: string;
    providerRegions: string;
    zitadelMasterkey: string;
    zitadelDbAdminPassword: string;
    zitadelDbUserPassword: string;
    zitadelAdminTempPassword: string;
    jwtSecret: string;
    adminEmail: string;
    adminPassword: string;
  } {
    const meta = (cluster.metadata ?? {}) as any;
    const tryDecrypt = (v?: string) =>
      v ? this.encryptionService.decrypt(v) : '';
    const encryptionKeyPath = path.join(
      os.homedir(),
      '.flui',
      'encryption.key',
    );
    return {
      postgresPassword: this.encryptionService.decrypt(
        meta.postgresPasswordEncrypted,
      ),
      redisPassword: this.encryptionService.decrypt(
        meta.redisPasswordEncrypted,
      ),
      grafanaPassword: this.encryptionService.decrypt(
        meta.grafanaPasswordEncrypted,
      ),
      encryptionKey: fs.existsSync(encryptionKeyPath)
        ? fs.readFileSync(encryptionKeyPath, 'utf-8').trim()
        : '',
      fluiApiKey: meta.fluiApiKey || '',
      providerToken: tryDecrypt(meta.providerTokenEncrypted),
      providerScalewayAccessKey: tryDecrypt(
        meta.providerScalewayAccessKeyEncrypted,
      ),
      providerScalewaySecretKey: tryDecrypt(
        meta.providerScalewaySecretKeyEncrypted,
      ),
      providerRegions: meta.providerRegions || '',
      zitadelMasterkey: tryDecrypt(meta.zitadelMasterkeyEncrypted),
      zitadelDbAdminPassword: tryDecrypt(meta.zitadelDbAdminPasswordEncrypted),
      zitadelDbUserPassword: tryDecrypt(meta.zitadelDbUserPasswordEncrypted),
      zitadelAdminTempPassword: tryDecrypt(
        meta.zitadelAdminTempPasswordEncrypted,
      ),
      jwtSecret: tryDecrypt(meta.jwtSecretEncrypted),
      adminEmail: meta.adminEmail || '',
      adminPassword: tryDecrypt(meta.adminPasswordEncrypted),
    };
  }

  private async generateBootstrapKey(
    provider: any,
    clusterId: string,
    nodeName: string,
  ): Promise<{ keyId: string; publicKeyPath: string; privateKeyPath: string }> {
    const bootstrapDir = path.join(
      os.homedir(),
      '.flui',
      'bootstrap-keys',
      clusterId,
    );

    // Ensure bootstrap directory exists
    if (!fs.existsSync(bootstrapDir)) {
      fs.mkdirSync(bootstrapDir, { recursive: true, mode: 0o700 });
    }

    const privateKeyPath = path.join(bootstrapDir, `${nodeName}-bootstrap`);
    const publicKeyPath = `${privateKeyPath}.pub`;

    this.logger.debug(`Generating bootstrap SSH key for ${nodeName}...`);

    // Generate ED25519 SSH keypair
    execFileSync(
      'ssh-keygen',
      [
        '-t',
        'ed25519',
        '-f',
        privateKeyPath,
        '-N',
        '',
        '-C',
        `flui-bootstrap-${nodeName}`,
      ],
      { stdio: 'pipe' },
    );

    // Set correct permissions
    fs.chmodSync(privateKeyPath, 0o600);
    fs.chmodSync(publicKeyPath, 0o644);

    // Read public key content
    const publicKeyContent = fs.readFileSync(publicKeyPath, 'utf-8').trim();

    // Upload to cloud provider with labels (Record<string, string> format)
    const bootstrapLabels = {
      'managed-by': 'flui-cloud',
      'flui-cluster-id': clusterId,
      'flui-resource-type': 'ssh-key',
      'flui-ssh-key-name': nodeName,
    };

    this.logger.debug(`Uploading bootstrap key to provider for ${nodeName}...`);

    const sshKey = await provider.createSSHKey(
      `flui-bootstrap-${clusterId}-${nodeName}`,
      publicKeyContent,
      bootstrapLabels,
    );

    this.logger.log(`Bootstrap key created for ${nodeName} (ID: ${sshKey.id})`);

    return {
      keyId: sshKey.id.toString(),
      publicKeyPath,
      privateKeyPath,
    };
  }

  /**
   * Get CA enrollment script for cloud-init
   */
  private async getCaEnrollmentScript(): Promise<string> {
    return await this.caService.getEnrollmentScript();
  }

  /**
   * Wait for observability stack to be ready by polling health endpoint
   */
  private async waitForObservabilityStackReady(
    masterIp: string,
    timeout: number,
    nipHostnameToken?: string | null,
  ): Promise<void> {
    const startTime = Date.now();
    const baseDomain = buildNipBaseDomain(masterIp, nipHostnameToken);
    const healthUrl = `https://app.${baseDomain}/`;
    let lastStatus = '';

    this.logger.log(`Polling health endpoint: ${healthUrl}`);
    this.logger.log(`Timeout: ${timeout / 1000}s (${timeout / 60000} minutes)`);

    const agent = new https.Agent({ rejectUnauthorized: false });
    const checkUrl = (url: string): Promise<number | null> =>
      new Promise((resolve) => {
        const req = https.get(url, { agent }, (res) => {
          resolve(res.statusCode ?? null);
          res.resume();
        });
        req.setTimeout(8000, () => {
          req.destroy();
          resolve(null);
        });
        req.on('error', () => resolve(null));
      });

    while (Date.now() - startTime < timeout) {
      const status = await checkUrl(healthUrl);

      if (status !== null && status >= 200 && status < 400) {
        this.logger.log(
          `✅ Observability stack ready (HTTP ${status} from ${healthUrl})`,
        );
        return;
      }

      if (status !== null && lastStatus !== `pending-${status}`) {
        this.logger.log(`Bootstrap in progress (HTTP ${status} from Traefik)`);
        lastStatus = `pending-${status}`;
      } else if (status === null && lastStatus !== 'unreachable') {
        if (Date.now() - startTime > 120000) {
          this.logger.warn(`Health check unreachable (will retry...)`);
        }
        lastStatus = 'unreachable';
      }

      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    throw new Error(
      `Timeout waiting for observability stack to be ready after ${timeout / 1000}s`,
    );
  }

  /**
   * Wait for server to be ready
   */
  private async waitForServerReady(
    provider: any,
    serverId: string,
    timeout: number,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const server = await provider.getServerStatus(serverId);

      if (server.status === 'running' || server.status === 'ready') {
        return;
      }

      if (server.status === 'error' || server.status === 'failed') {
        throw new Error(`Server ${serverId} failed to start: ${server.status}`);
      }

      // Wait 5 seconds before checking again
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    throw new Error(`Timeout waiting for server ${serverId} to be ready`);
  }

  /**
   * Fetch the real kubeconfig from the K3s master via SSH.
   * K3s generates a valid kubeconfig with client certificates at
   * /etc/rancher/k3s/k3s.yaml. We read it and replace 127.0.0.1
   * with the actual master IP so it's accessible remotely.
   */
  private async fetchKubeconfig(masterIp: string): Promise<string> {
    const raw = await this.sshService.sshExec(
      masterIp,
      'sudo cat /etc/rancher/k3s/k3s.yaml',
    );
    // K3s writes server: https://127.0.0.1:6443 — replace with real IP
    return raw.replaceAll('127.0.0.1', masterIp);
  }

  /**
   * Patch the existing flui-secrets Kubernetes secret with SSH CA keys.
   *
   * The bootstrap script (00-secrets.yaml) creates flui-secrets with
   * DB_PASSWORD, REDIS_PASSWORD, ENCRYPTION_KEY, GRAFANA_ADMIN_PASSWORD.
   * This method adds SSH CA keys so the API can SSH to servers using
   * the same CA as the CLI (unified SSH access).
   */
  private async createApiCredentialsSecret(
    operationId: string,
    masterIp: string,
    bootstrap: {
      fluiApiKey: string;
      providerToken: string;
      providerScalewayAccessKey: string;
      providerScalewaySecretKey: string;
      providerRegions: string;
      clusterRegion: string;
      instanceType: string;
      provider: string;
      bootstrapNodePrivateIp?: string;
      sharedStorageVolumeId?: string;
      sharedStorageVolumeSizeGb?: number;
      envVnet?: {
        vnetProviderResourceId: string;
        vnetIpRange: string;
        subnetProviderResourceId: string;
        subnetIpRange: string;
        subnetType: string;
        networkZone: string;
      };
    },
  ): Promise<void> {
    this.log(
      operationId,
      'Patching Kubernetes secret with SSH CA keys + bootstrap vars...',
    );

    try {
      // Load CLI CA keys to share with API for unified SSH access.
      // CA keys are profile-scoped (~/.flui/profiles/<profile>/ca), not global —
      // the old global path threw ENOENT and silently skipped the whole patch.
      const caKeyDir = path.join(ProfileManager.getProfileDir(), 'ca');
      const caPrivateKey = fs
        .readFileSync(path.join(caKeyDir, 'ca_key'), 'utf8')
        .trim();
      const caPublicKey = fs
        .readFileSync(path.join(caKeyDir, 'ca_key.pub'), 'utf8')
        .trim();

      // Base64-encode for Kubernetes Opaque secret data field
      const b64 = (s: string) => Buffer.from(s).toString('base64');

      // Encode the entire patch JSON as base64, decode on the server, then apply.
      // This avoids all shell escaping issues since sshExec wraps commands
      // in double quotes and JSON contains double quotes that would conflict.
      const data: Record<string, string> = {
        SSH_CA_PRIVATE_KEY: b64(caPrivateKey),
        SSH_CA_PUBLIC_KEY: b64(caPublicKey),
        FLUI_CLI_API_KEY: b64(bootstrap.fluiApiKey),
        PROVIDER_HETZNER_API_KEY:
          bootstrap.provider === 'hetzner'
            ? b64(bootstrap.providerToken)
            : b64(''),
        PROVIDER_SCALEWAY_ACCESS_KEY: b64(
          bootstrap.providerScalewayAccessKey || '',
        ),
        PROVIDER_SCALEWAY_SECRET_KEY: b64(
          bootstrap.providerScalewaySecretKey || '',
        ),
        PROVIDER_REGIONS: b64(bootstrap.providerRegions),
        CLUSTER_REGION: b64(bootstrap.clusterRegion),
        INSTANCE_TYPE: b64(bootstrap.instanceType),
      };

      if (bootstrap.envVnet) {
        data.FLUI_VNET_PROVIDER_RESOURCE_ID = b64(
          bootstrap.envVnet.vnetProviderResourceId,
        );
        data.FLUI_VNET_PROVIDER = b64(bootstrap.provider);
        data.FLUI_VNET_NAME = b64('flui-env-vnet');
        data.FLUI_VNET_IP_RANGE = b64(bootstrap.envVnet.vnetIpRange);
        data.FLUI_SUBNET_PROVIDER_RESOURCE_ID = b64(
          bootstrap.envVnet.subnetProviderResourceId,
        );
        data.FLUI_SUBNET_IP_RANGE = b64(bootstrap.envVnet.subnetIpRange);
        data.FLUI_SUBNET_TYPE = b64(bootstrap.envVnet.subnetType);
        data.FLUI_SUBNET_NETWORK_ZONE = b64(bootstrap.envVnet.networkZone);
      }
      if (bootstrap.bootstrapNodePrivateIp) {
        data.FLUI_BOOTSTRAP_NODE_PRIVATE_IP = b64(
          bootstrap.bootstrapNodePrivateIp,
        );
      }
      if (bootstrap.sharedStorageVolumeId) {
        data.FLUI_SHARED_STORAGE_VOLUME_ID = b64(
          bootstrap.sharedStorageVolumeId,
        );
      }
      if (bootstrap.sharedStorageVolumeSizeGb) {
        data.FLUI_SHARED_STORAGE_VOLUME_GB = b64(
          String(bootstrap.sharedStorageVolumeSizeGb),
        );
      }

      const patchJson = JSON.stringify({ data });
      const patchBase64 = Buffer.from(patchJson).toString('base64');
      const writeAndPatchCmd =
        `echo ${patchBase64} | base64 -d > /tmp/flui-ssh-ca-patch.json` +
        ` && (kubectl patch secret flui-secrets -n flui-system --type merge` +
        `      --patch-file /tmp/flui-ssh-ca-patch.json` +
        `   || kubectl patch secret flui-secrets -n default --type merge` +
        `      --patch-file /tmp/flui-ssh-ca-patch.json)` +
        ` && rm -f /tmp/flui-ssh-ca-patch.json` +
        ` && (kubectl rollout restart deployment/flui-api -n flui-system 2>/dev/null` +
        ` || kubectl rollout restart deployment/flui-api -n default 2>/dev/null` +
        ` || true)`;
      await this.sshService.sshExec(masterIp, writeAndPatchCmd);

      this.log(
        operationId,
        '✅ Kubernetes secret patched with SSH CA keys and bootstrap vars',
      );
    } catch (error) {
      this.log(
        operationId,
        `Failed to patch Kubernetes secret: ${error.message}`,
        'WARN',
      );
      this.log(operationId, 'You can add SSH CA manually later.', 'WARN');
    }
  }
}
