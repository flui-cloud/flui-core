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
  OperationStep,
} from 'src/modules/infrastructure/servers/entities/infrastructure-operations.entity';
import { CliClusterRepository } from '../lib/repositories/cli-cluster.repository';
import { CliNodeRepository } from '../lib/repositories/cli-node.repository';
import { CliOperationRepository } from '../lib/repositories/cli-operation.repository';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { EncryptionService } from 'src/modules/shared/encryption/services/encryption.service';
import { CliK3sScriptService } from './cli-k3s-script.service';
import { buildNipBaseDomain } from '../lib/nip-base-domain.util';
import { LabelService } from 'src/modules/infrastructure/shared/services/label.service';
import {
  CONTEXT_LABEL,
  contextLabelPair,
  contextTag,
} from '../lib/context-stamp';
import { CliCaService } from './cli-ca.service';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';

import { HetznerFirewallService } from 'src/modules/providers/services/hetzner-firewall.service';
import { CliFirewallRepository } from '../lib/repositories/cli-firewall.repository';
import { CliSshService } from './cli-ssh.service';
import { CliLoggerService } from './cli-logger.service';
import { CliVnetRepository } from '../lib/repositories/cli-vnet.repository';
import { ApiClient, ApiError } from '../lib/api-client';
import { ConfigStorage } from '../lib/config-storage';
import { CliByosPurgeService } from './cli-byos-purge.service';
import { resolveClusterSshTarget } from '../lib/cluster-ssh-target';
import { checkTcpPort } from '../lib/utils/tcp-port';
import { resolveSshMode, revokeAuthorizedKeyCommand } from '../lib/ssh-mode';
import { emitEvent } from '../lib/progress-events';

interface BootstrapKey {
  keyId: string;
  publicKeyPath: string;
  privateKeyPath: string;
}

/**
 * Retry only what a restarting control plane can recover from. A 4xx answers
 * the same on every attempt, so retrying it just burns the window and hides
 * the cause; a missing status means the request never got an answer at all.
 */
const isRetryableApiFailure = (status?: number): boolean =>
  status === undefined || status === 408 || status === 429 || status >= 500;

/**
 * Operator-facing text for a failed host-firewall apply. Names the exposed
 * ports explicitly so the claim can be verified with a single port scan.
 */
function hostFirewallFailureMessage(cause: string): string {
  return [
    `Host firewall not registered with the control plane: ${cause}`,
    '',
    '  The ruleset applied before k3s started is still active on the host, so',
    '  6443, 10250 and the NodePort range are not exposed. What is missing is',
    '  the control plane record: Flui cannot reconcile this firewall or report',
    '  drift on it until it exists.',
    '',
    '  Register it with:',
    '',
    '      flui env firewall apply',
    '',
    '  Then check it with: flui env firewall status',
  ].join('\n');
}

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
    private readonly purgeService: CliByosPurgeService,
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

    // BYOS has no provisioning API — install over SSH onto an existing host.
    if (cluster.provider === CloudProvider.BYOS) {
      return this.createClusterSyncByos(cluster, operation);
    }

    const sshMode = resolveSshMode(cluster.metadata);
    // Every throwaway key minted for this run, and every node it was authorised
    // on, so the teardown can find them all whether the run ends in a handoff or
    // in a failure.
    const bootstrapKeys: BootstrapKey[] = [];
    const nodeIps: string[] = [];

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
        contextLabelPair(),
      ];

      // Generate bootstrap SSH key for master node
      const masterBootstrapKey = await this.generateBootstrapKey(
        provider,
        cluster.id,
        masterServerName,
      );
      bootstrapKeys.push(masterBootstrapKey);

      // In ephemeral-key mode the getters are not just skipped, they must not be
      // called at all: they create the CA on this machine as a side effect, and
      // the whole point of the mode is that no CA comes into existence here.
      const caPublicKey =
        sshMode === 'ephemeral-key'
          ? ''
          : await this.caService.getCaPublicKey();
      const caPrivateKey =
        sshMode === 'ephemeral-key'
          ? ''
          : await this.caService.getCaPrivateKey();

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
        provider: cluster.provider,
        region: cluster.region || null,
        serverType: cluster.nodeSize || null,
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
        caPrivateKey,
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

      // Announced before the call, not after. A run that dies between the
      // request and its answer has still created a billable server, and the
      // only way a caller can know that is if we said so first.
      emitEvent({
        type: 'resource',
        kind: 'server',
        id: null,
        name: masterServerName,
      });
      // The shared-storage Volume is created inside the same call and survives
      // the server on every provider, so a caller that only heard about the
      // server would be left with a paid disk that nothing names.
      const sharedVolumeName = `${cluster.name}-flui-shared`;
      if (sharedStorageEnabled) {
        emitEvent({
          type: 'resource',
          kind: 'volume',
          id: null,
          name: sharedVolumeName,
        });
      }
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
                name: sharedVolumeName,
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
        emitEvent({
          type: 'resource',
          kind: 'volume',
          id: String(masterServer.attachedVolumes[0].volumeId),
          name: sharedVolumeName,
        });
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

      nodeIps.push(masterServer.ipAddress);
      emitEvent({
        type: 'resource',
        kind: 'server',
        id: String(masterServer.serverId),
        name: masterServerName,
      });
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

      // With no CA enrolled there is no certificate to present, so the rest of
      // the run goes over the throwaway key that cloud-init already authorised.
      const provisioningKeyPath =
        sshMode === 'ephemeral-key'
          ? masterBootstrapKey.privateKeyPath
          : undefined;

      // Step 3a: Fetch real kubeconfig from K3s master via SSH
      this.log(opId, 'Fetching kubeconfig from K3s master...');
      const kubeconfig = await this.fetchKubeconfig(
        cluster.masterIpAddress,
        provisioningKeyPath,
      );
      cluster.kubeconfigEncrypted = this.encryptionService.encrypt(kubeconfig);
      await this.clusterRepository.save(cluster);
      this.log(opId, '✅ Kubeconfig generated and encrypted');

      // Step 3b: Patch Kubernetes secret with SSH CA keys + bootstrap seeder vars
      await this.createApiCredentialsSecret(
        opId,
        cluster.masterIpAddress,
        {
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
        },
        provisioningKeyPath ? { keyPath: provisioningKeyPath } : undefined,
      );

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
            contextLabelPair(),
          ];

          // Generate bootstrap SSH key for worker node
          const workerBootstrapKey = await this.generateBootstrapKey(
            provider,
            cluster.id,
            workerServerName,
          );
          bootstrapKeys.push(workerBootstrapKey);

          // Create worker node entity FIRST to get the database ID
          const workerNode = this.nodeRepository.create({
            cluster,
            clusterId: cluster.id,
            providerResourceId: '', // Will be updated after server creation
            serverName: workerServerName,
            nodeType: NodeType.WORKER,
            status: NodeStatus.CREATING,
            ipAddress: '', // Will be updated after server creation
            provider: cluster.provider,
            region: cluster.region || null,
            serverType: cluster.nodeSize || null,
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

          emitEvent({
            type: 'resource',
            kind: 'server',
            id: null,
            name: workerServerName,
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

          nodeIps.push(workerServer.ipAddress);
          emitEvent({
            type: 'resource',
            kind: 'server',
            id: String(workerServer.serverId),
            name: workerServerName,
          });
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

      // Last SSH of the run: after this the cluster answers to nobody until its
      // owner adopts it. Anything needing a shell has to have happened already.
      if (sshMode === 'ephemeral-key') {
        await this.destroyBootstrapKeys(opId, provider, bootstrapKeys, nodeIps);
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

      // A failed run is exactly when a throwaway key is most likely to be
      // forgotten, and the half-built nodes it opens are still standing.
      if (sshMode === 'ephemeral-key') {
        const provider = this.providerFactory.getProvider(
          cluster.provider as any,
        );
        await this.destroyBootstrapKeys(opId, provider, bootstrapKeys, nodeIps);
      }

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
   * BYOS install: mirrors createClusterSync but runs the bootstrap over the
   * operator's own SSH key (the only credential the host trusts pre-CA). No
   * provider API, so firewall / vnet / managed-volume are skipped.
   */
  private async createClusterSyncByos(
    cluster: ClusterEntity,
    operation: InfrastructureOperationEntity,
  ): Promise<void> {
    const opId = operation.id;
    const byos = ((cluster.metadata as any)?.byos ?? {}) as {
      host?: string;
      port?: number;
      user?: string;
      keyPath?: string;
      masterPublicIp?: string;
      localStub?: boolean;
    };

    try {
      operation.status = OperationStatus.IN_PROGRESS;
      operation.currentStepIndex = 0;
      await this.operationRepository.save(operation);

      if (!byos.host || !byos.keyPath) {
        throw new Error(
          'BYOS cluster metadata missing host/keyPath — cannot reach the server.',
        );
      }
      const port = byos.port ?? 22;
      const user = byos.user ?? 'root';
      const publicIp = byos.masterPublicIp || byos.host;

      const k3sToken = this.encryptionService.decrypt(
        cluster.k3sTokenEncrypted,
      );
      const caPublicKey = await this.caService.getCaPublicKey();
      const caPrivateKey = await this.caService.getCaPrivateKey();
      const decrypted = this.decryptClusterSecrets(cluster);
      const clusterMeta = cluster.metadata as any;

      this.log(opId, 'Creating master node record (BYOS)...');
      operation.currentStepIndex = 1;
      await this.operationRepository.save(operation);

      const masterServerName = `${cluster.name}-master`;
      const masterNode = this.nodeRepository.create({
        cluster,
        clusterId: cluster.id,
        providerResourceId: byos.host, // host identifier, not a cloud resource id
        serverName: masterServerName,
        nodeType: NodeType.MASTER,
        status: NodeStatus.CREATING,
        ipAddress: publicIp,
        privateIp: byos.host,
        // The operator's own machine: no region, no size, no price to record.
        provider: cluster.provider,
        region: null,
        serverType: null,
        metadata: { byosHost: byos.host, byosPort: port },
      });
      await this.nodeRepository.save(masterNode);

      // No managed block volume on BYOS — local-path on the node's own disk.
      const masterUserData = await this.k3sScriptService.generateMasterScript({
        serverId: masterNode.id,
        clusterId: cluster.id,
        clusterName: cluster.name,
        k3sToken,
        instanceId: `${cluster.name}-master`,
        instanceName: masterServerName,
        provider: cluster.provider,
        caPublicKey,
        caPrivateKey,
        operationId: opId,
        deployObservabilityStack: isControlClusterType(cluster.clusterType),
        postgresPassword: decrypted.postgresPassword,
        redisPassword: decrypted.redisPassword,
        grafanaPassword: decrypted.grafanaPassword,
        authMode: clusterMeta?.authMode || 'local',
        jwtSecret: decrypted.jwtSecret,
        adminEmail: decrypted.adminEmail,
        adminPassword: decrypted.adminPassword,
        encryptionKey: decrypted.encryptionKey,
        zitadelMasterkey: decrypted.zitadelMasterkey,
        zitadelDbAdminPassword: decrypted.zitadelDbAdminPassword,
        zitadelDbUserPassword: decrypted.zitadelDbUserPassword,
        zitadelAdminTempPassword: decrypted.zitadelAdminTempPassword,
        fluiApiKey: decrypted.fluiApiKey,
        clusterRegion: cluster.region,
        instanceType: cluster.nodeSize,
        masterPublicIp: publicIp,
        nipIoCertEnabled: !clusterMeta?.zitadelDomain,
        acmeStaging: !!clusterMeta?.acmeStaging,
        useLatest: !!clusterMeta?.useLatest,
        nipHostnameToken: cluster.nipHostnameToken || null,
        sharedStorage: undefined,
        byosSshPort: port,
      });

      this.log(opId, `Running bootstrap on ${user}@${byos.host}:${port} ...`);
      operation.currentStepIndex = 2;
      await this.operationRepository.save(operation);

      await this.sshService.runScriptWithKey({
        host: byos.host,
        port,
        user,
        keyPath: byos.keyPath,
        script: masterUserData,
        onData: (chunk) =>
          this.cliLoggerService.writeLog(opId, chunk.trimEnd(), 'INFO'),
      });

      masterNode.status = NodeStatus.READY;
      await this.nodeRepository.save(masterNode);
      cluster.masterIpAddress = publicIp;
      cluster.nodeCount = 1;
      await this.clusterRepository.save(cluster);
      this.log(opId, `✅ Master bootstrap completed on ${publicIp}`);

      // Verify the host now trusts the Flui CA — the key new BYOS mechanic.
      try {
        const probe = await this.sshService.sshExecCertOnPort(
          byos.host,
          'echo flui-ca-ok',
          port,
          user,
        );
        if (probe.includes('flui-ca-ok')) {
          this.log(opId, '✅ Flui SSH CA trusted on host (cert auth works)');
        }
      } catch (e) {
        this.log(
          opId,
          `⚠ CA-cert SSH verification failed: ${(e as Error).message}`,
          'WARN',
        );
      }

      if (byos.localStub) {
        this.log(
          opId,
          'ℹ Local stub mode — skipping observability wait, kubeconfig fetch and secret patch.',
        );
      } else {
        this.log(opId, 'Waiting for control-plane / observability stack...');
        operation.currentStepIndex = 3;
        await this.operationRepository.save(operation);
        await this.waitForObservabilityStackReady(
          publicIp,
          1800000,
          cluster.nipHostnameToken,
        );

        // Fetch kubeconfig over the operator's SSH target (port-aware — the
        // host may not be on :22, e.g. local Podman on 2222). Best-effort.
        try {
          const raw = await this.sshService.sshExecCertOnPort(
            byos.host,
            'sudo cat /etc/rancher/k3s/k3s.yaml',
            port,
            user,
          );
          cluster.kubeconfigEncrypted = this.encryptionService.encrypt(
            raw.replaceAll('127.0.0.1', publicIp),
          );
          await this.clusterRepository.save(cluster);
          this.log(opId, '✅ Kubeconfig fetched');
        } catch (e) {
          this.log(
            opId,
            `⚠ Kubeconfig fetch skipped: ${(e as Error).message}`,
            'WARN',
          );
        }

        // SSH-CA secret patch lets the API SSH to nodes. Best-effort on BYOS:
        // it runs kubectl over SSH on :22 today, so a non-22 host just skips it
        // (the stack itself is already deployed by the bootstrap).
        try {
          await this.createApiCredentialsSecret(
            opId,
            publicIp,
            {
              fluiApiKey: decrypted.fluiApiKey,
              providerToken: '',
              providerScalewayAccessKey: '',
              providerScalewaySecretKey: '',
              providerRegions: '',
              clusterRegion: cluster.region,
              instanceType: cluster.nodeSize,
              provider: cluster.provider,
              bootstrapNodePrivateIp: byos.host,
            },
            { host: byos.host, port, user },
          );
        } catch (e) {
          this.log(
            opId,
            `⚠ API-credentials secret patch skipped: ${(e as Error).message}`,
            'WARN',
          );
        }
      }

      // The API-DB cluster record is seeded in-cluster by the bootstrap and
      // lacks the operator's SSH coordinates, so the dashboard/API can't reach
      // a node on a non-standard SSH port (firewall, etc.). Persist them (best
      // effort — never fail the create over this).
      await this.persistByosTargetToApi(
        cluster,
        byos,
        decrypted.fluiApiKey,
        opId,
      );

      // Register the private network as a first-class VNet (register+validate,
      // mirroring cloud) + attach the master. Server derives the CIDR from the
      // node when not declared. Best-effort — never fail the create over it.
      await this.ensureByosVNetOnApi(
        cluster,
        (cluster.metadata as { byos?: { nodeNetwork?: string } })?.byos
          ?.nodeNetwork,
        decrypted.fluiApiKey,
        opId,
      );

      // Lock the host down by default. Runs last because it needs the API DB
      // record, the persisted SSH target and the SSH-CA secret all in place so
      // the reconcile can SSH in to apply the ruleset — and the SSH-CA patch
      // rollout-restarts flui-api, so the enable rides out that window on retry.
      // Skipped for local stubs (no reachable API to enable against).
      if (!byos.localStub) {
        await this.ensureByosHostFirewall(cluster, decrypted.fluiApiKey, opId);
      }

      // READY only once the host is firewalled: an install that leaves the
      // kube-apiserver open to the internet has not succeeded.
      cluster.status = ClusterStatus.READY;
      await this.clusterRepository.save(cluster);

      operation.status = OperationStatus.COMPLETED;
      operation.currentStepIndex = operation.totalSteps;
      await this.operationRepository.save(operation);
      this.log(opId, `BYOS cluster ${cluster.name} created successfully!`);
    } catch (error) {
      this.log(
        opId,
        `BYOS cluster creation failed: ${(error as Error).message}`,
        'ERROR',
      );
      cluster.status = ClusterStatus.ERROR;
      await this.clusterRepository.save(cluster);
      operation.status = OperationStatus.FAILED;
      operation.metadata = {
        ...operation.metadata,
        error: (error as Error).message,
        errorStack: (error as Error).stack,
      };
      await this.operationRepository.save(operation);
      throw error;
    }
  }

  /**
   * Wipe + re-bootstrap the EXISTING master server over SSH, skipping
   * provider.createServer/deleteServer entirely — the VM, firewall, VNet and
   * shared-storage Volume stay untouched. Cloud counterpart of
   * {@link createClusterSyncByos}. v1: single-node cloud clusters only.
   */
  async reinstallControlCluster(
    cluster: ClusterEntity,
    operation: InfrastructureOperationEntity,
  ): Promise<void> {
    const opId = operation.id;
    try {
      if (cluster.provider === CloudProvider.BYOS) {
        throw new Error(
          'Reinstall is not supported for BYOS clusters — use `flui env destroy --purge-host` + `flui env create --host` instead.',
        );
      }
      if (cluster.nodeCount > 1) {
        throw new Error(
          `Reinstall only supports single-node (master-only) clusters today — this cluster has ${cluster.nodeCount} nodes.`,
        );
      }

      operation.status = OperationStatus.IN_PROGRESS;
      operation.currentStepIndex = 0;
      await this.operationRepository.save(operation);

      const masterNode = await this.nodeRepository.findOne({
        where: { clusterId: cluster.id, nodeType: NodeType.MASTER },
      });
      if (!masterNode) {
        throw new Error('No master node record found for this cluster.');
      }
      if (!cluster.masterIpAddress) {
        throw new Error('Cluster has no master IP address on record.');
      }

      const sshTarget = resolveClusterSshTarget(
        cluster,
        cluster.masterIpAddress,
      );

      this.log(
        opId,
        `Reinstalling on ${sshTarget.user}@${sshTarget.host}:${sshTarget.port} ...`,
      );
      operation.currentStep = OperationStep.CLUSTER_REINSTALL_INIT;
      operation.currentStepIndex = 1;
      await this.operationRepository.save(operation);

      // Fail fast with a clear cause instead of a raw ssh timeout several
      // steps in — port 22 blocked almost always means the Cloud Firewall's
      // SSH allowlist no longer matches the operator's current IP.
      const sshPortOpen = await checkTcpPort(
        sshTarget.host,
        sshTarget.port,
        8000,
      );
      if (!sshPortOpen) {
        throw new Error(
          `SSH port ${sshTarget.port} is not reachable on ${sshTarget.host}. ` +
            `Check the cluster's firewall SSH allowlist: \`flui env update-firewall --list\`, ` +
            `then \`flui env update-firewall\` to allow your current IP.`,
        );
      }

      cluster.status = ClusterStatus.SCALING;
      masterNode.status = NodeStatus.CREATING;
      await this.clusterRepository.save(cluster);
      await this.nodeRepository.save(masterNode);

      this.log(opId, 'Purging existing k3s/Flui state...');
      operation.currentStep = OperationStep.CLUSTER_REINSTALL_PURGE;
      await this.operationRepository.save(operation);
      await this.sshService.runScriptWithCert({
        host: sshTarget.host,
        port: sshTarget.port,
        user: sshTarget.user,
        script: this.purgeService.buildScript(false, null),
        onData: (chunk) =>
          this.cliLoggerService.writeLog(opId, chunk.trimEnd(), 'INFO'),
      });
      this.log(opId, '✅ Existing install purged');

      const k3sToken = this.encryptionService.decrypt(
        cluster.k3sTokenEncrypted,
      );
      const caPublicKey = await this.caService.getCaPublicKey();
      const caPrivateKey = await this.caService.getCaPrivateKey();
      const decrypted = this.decryptClusterSecrets(cluster);
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
      const sharedStorageEnabled = cluster.sharedStorageEnabled !== false;

      const masterUserData = await this.k3sScriptService.generateMasterScript({
        serverId: masterNode.id,
        clusterId: cluster.id,
        clusterName: cluster.name,
        k3sToken,
        instanceId: `${cluster.name}-master`,
        instanceName: masterNode.serverName,
        provider: cluster.provider,
        caPublicKey,
        caPrivateKey,
        operationId: opId,
        deployObservabilityStack: isControlClusterType(cluster.clusterType),
        postgresPassword: decrypted.postgresPassword,
        redisPassword: decrypted.redisPassword,
        grafanaPassword: decrypted.grafanaPassword,
        authMode: clusterMeta?.authMode || 'local',
        jwtSecret: decrypted.jwtSecret,
        adminEmail: decrypted.adminEmail,
        adminPassword: decrypted.adminPassword,
        encryptionKey: decrypted.encryptionKey,
        zitadelMasterkey: decrypted.zitadelMasterkey,
        zitadelDbAdminPassword: decrypted.zitadelDbAdminPassword,
        zitadelDbUserPassword: decrypted.zitadelDbUserPassword,
        zitadelAdminTempPassword: decrypted.zitadelAdminTempPassword,
        fluiApiKey: decrypted.fluiApiKey,
        providerApiKey: decrypted.providerToken,
        providerScalewayAccessKey: decrypted.providerScalewayAccessKey,
        providerScalewaySecretKey: decrypted.providerScalewaySecretKey,
        providerRegions: decrypted.providerRegions,
        clusterRegion: cluster.region,
        instanceType: cluster.nodeSize,
        clusterFirewallId: clusterMeta?.firewallId || '',
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
              volumeSizeGb: cluster.sharedStorageVolumeSizeGb ?? 20,
            }
          : undefined,
      });

      this.log(opId, 'Running bootstrap install...');
      operation.currentStep = OperationStep.CLUSTER_REINSTALL_BOOTSTRAP;
      operation.currentStepIndex = 2;
      await this.operationRepository.save(operation);
      await this.sshService.runScriptWithCert({
        host: sshTarget.host,
        port: sshTarget.port,
        user: sshTarget.user,
        script: masterUserData,
        onData: (chunk) =>
          this.cliLoggerService.writeLog(opId, chunk.trimEnd(), 'INFO'),
      });
      this.log(opId, `✅ Bootstrap completed on ${cluster.masterIpAddress}`);

      this.log(opId, 'Waiting for control-plane / observability stack...');
      operation.currentStep = OperationStep.CLUSTER_REINSTALL_OBSERVABILITY;
      operation.currentStepIndex = 3;
      await this.operationRepository.save(operation);
      await this.waitForObservabilityStackReady(
        cluster.masterIpAddress,
        1800000,
        cluster.nipHostnameToken,
      );

      operation.currentStep = OperationStep.CLUSTER_REINSTALL_FINALIZE;
      operation.currentStepIndex = 4;
      await this.operationRepository.save(operation);

      try {
        const kubeconfig = await this.fetchKubeconfig(cluster.masterIpAddress);
        cluster.kubeconfigEncrypted =
          this.encryptionService.encrypt(kubeconfig);
        this.log(opId, '✅ Kubeconfig fetched');
      } catch (e) {
        this.log(
          opId,
          `⚠ Kubeconfig fetch skipped: ${(e as Error).message}`,
          'WARN',
        );
      }

      await this.createApiCredentialsSecret(opId, cluster.masterIpAddress, {
        fluiApiKey: decrypted.fluiApiKey,
        providerToken: decrypted.providerToken,
        providerScalewayAccessKey: decrypted.providerScalewayAccessKey,
        providerScalewaySecretKey: decrypted.providerScalewaySecretKey,
        providerRegions: decrypted.providerRegions,
        clusterRegion: cluster.region,
        instanceType: cluster.nodeSize,
        provider: cluster.provider,
        bootstrapNodePrivateIp: masterNode.privateIp,
        sharedStorageVolumeId: cluster.sharedStorageVolumeId ?? undefined,
        sharedStorageVolumeSizeGb:
          cluster.sharedStorageVolumeSizeGb ?? undefined,
        envVnet,
      });

      masterNode.status = NodeStatus.READY;
      await this.nodeRepository.save(masterNode);
      cluster.status = ClusterStatus.READY;
      await this.clusterRepository.save(cluster);

      operation.status = OperationStatus.COMPLETED;
      operation.currentStepIndex = operation.totalSteps;
      await this.operationRepository.save(operation);
      this.log(opId, `Cluster ${cluster.name} reinstalled successfully!`);
    } catch (error) {
      this.log(opId, `Reinstall failed: ${(error as Error).message}`, 'ERROR');
      cluster.status = ClusterStatus.ERROR;
      await this.clusterRepository.save(cluster);
      operation.status = OperationStatus.FAILED;
      operation.metadata = {
        ...operation.metadata,
        error: (error as Error).message,
        errorStack: (error as Error).stack,
      };
      await this.operationRepository.save(operation);
      throw error;
    }
  }

  /**
   * BYOS worker join: the same scaling flow as the provisioned path, minus
   * provisioning. We don't call `provider.createServer`; instead we deliver the
   * SAME `k3s-worker-init.sh` bootstrap over the operator's own SSH key (the
   * only credential a fresh host trusts before the Flui CA is installed), join
   * it to the existing master, and record the node. Mirrors
   * {@link createClusterSyncByos} for the master.
   *
   * The firewall is handled in two passes when the cluster has a host firewall:
   * before the join we widen the MASTER ruleset to accept the node network (so
   * the worker can reach :6443); after the worker is registered (and trusts the
   * CA) we reconcile again to push the ruleset to the worker too. Both are
   * best-effort and driven through the admin API.
   */
  async joinWorkerByos(opts: {
    cluster: ClusterEntity;
    host: string;
    port: number;
    user: string;
    keyPath: string;
    masterIp: string;
    nodeNetwork?: string;
    onLog?: (msg: string) => void;
  }): Promise<{
    nodeId: string;
    serverName: string;
    privateIp?: string;
    nodeNetwork?: string;
  }> {
    const { cluster } = opts;
    const port = opts.port ?? 22;
    const user = opts.user ?? 'root';
    const log = (m: string): void =>
      opts.onLog ? opts.onLog(m) : this.logger.log(m);

    const k3sToken = this.encryptionService.decrypt(cluster.k3sTokenEncrypted);
    const caPublicKey = await this.caService.getCaPublicKey();
    const decrypted = this.decryptClusterSecrets(cluster);
    const clusterMeta = cluster.metadata as any;

    // 1. Detect the worker's real on-network private IP over the operator key
    //    (before the CA is installed). Feeds the host firewall's internalCidrs.
    let privateIp: string | undefined;
    try {
      const detected = await this.sshService.sshExecWithKey({
        host: opts.host,
        port,
        user,
        keyPath: opts.keyPath,
        command:
          "ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | " +
          String.raw`grep -E '^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)' | head -1`,
      });
      privateIp = detected.trim() || undefined;
    } catch {
      /* best effort — firewall can still use an explicit --node-network */
    }
    log(`→ Worker private IP: ${privateIp ?? '(undetected)'}`);

    const nodeNetwork =
      opts.nodeNetwork ||
      (privateIp ? CliClusterCreatorService.toSlash24(privateIp) : undefined);
    if (nodeNetwork) log(`→ Node network (firewall): ${nodeNetwork}`);

    // 2. Allocate the worker name + local node record.
    const workerIndex =
      (cluster.nodes ?? []).filter((n) => n.nodeType === NodeType.WORKER)
        .length + 1;
    const serverName = `${cluster.name}-worker-${workerIndex}`;
    log(`→ Worker name: ${serverName}`);

    const workerNode = this.nodeRepository.create({
      cluster,
      clusterId: cluster.id,
      providerResourceId: opts.host,
      serverName,
      nodeType: NodeType.WORKER,
      status: NodeStatus.JOINING,
      ipAddress: opts.host,
      privateIp,
      provider: cluster.provider,
      region: null,
      serverType: null,
      metadata: { byos: { host: opts.host, port, user } },
    });
    await this.nodeRepository.save(workerNode);

    // 3. Build a best-effort admin API client (dashboard/firewall sync).
    const api = this.buildAdminApiClient(cluster, decrypted.fluiApiKey);

    // 4. Pre-authorise the firewall: persist the node network and reconcile the
    //    MASTER so it accepts the worker's k3s traffic BEFORE the join. (No-op
    //    when no host firewall is configured.) The byos object is sent whole —
    //    metadata merge is shallow, so we must carry port/user through or they
    //    get clobbered (the firewall backend needs them to reach each node).
    const clusterByos = (cluster.metadata as any)?.byos ?? {};
    if (api && nodeNetwork) {
      await this.tryPatchNodeNetwork(
        api,
        cluster.id,
        {
          port: clusterByos.port ?? 22,
          user: clusterByos.user ?? 'root',
          nodeNetwork,
        },
        log,
      );
    }
    if (api) {
      await this.tryReconcileFirewall(
        api,
        cluster.id,
        'pre-join (master accepts node network)',
        log,
      );
    }

    // 5. Deliver + run the worker bootstrap over the operator key.
    log(
      `→ Joining ${user}@${opts.host}:${port} to master ${opts.masterIp} ...`,
    );
    const workerUserData = await this.k3sScriptService.generateWorkerScript({
      serverId: workerNode.id,
      clusterId: cluster.id,
      clusterName: cluster.name,
      k3sToken,
      masterIp: opts.masterIp,
      instanceId: serverName,
      instanceName: serverName,
      provider: cluster.provider,
      caPublicKey,
      useLatest: !!clusterMeta?.useLatest,
      sharedStorage: undefined,
    });

    await this.sshService.runScriptWithKey({
      host: opts.host,
      port,
      user,
      keyPath: opts.keyPath,
      script: workerUserData,
      onData: (chunk) => log(chunk.trimEnd()),
    });

    // 6. Verify the worker now trusts the Flui CA (cert auth works).
    try {
      const probe = await this.sshService.sshExecCertOnPort(
        opts.host,
        'echo flui-ca-ok',
        port,
        user,
      );
      if (probe.includes('flui-ca-ok')) {
        log('✅ Flui SSH CA trusted on worker (cert auth works)');
      }
    } catch (e) {
      log(`⚠ CA-cert SSH verification failed: ${(e as Error).message}`);
    }

    // 7. Mark the local node ready + bump node count.
    workerNode.status = NodeStatus.READY;
    await this.nodeRepository.save(workerNode);
    cluster.nodeCount = (cluster.nodeCount ?? 1) + 1;
    await this.clusterRepository.save(cluster);
    log(`✅ Worker ${serverName} joined the cluster`);

    // 8. Register the worker in the API DB so the dashboard lists it and the
    //    firewall backend can enforce on it (best-effort).
    if (api) {
      await this.tryRegisterByosNode(
        api,
        cluster.id,
        { serverName, ipAddress: opts.host, privateIp, port, user },
        log,
      );
      // 9. Reconcile again — now resolveTargets includes the worker, so the
      //    ruleset lands on it too (it trusts the CA after the bootstrap).
      await this.tryReconcileFirewall(
        api,
        cluster.id,
        'post-join (apply ruleset to worker)',
        log,
      );
    }

    return { nodeId: workerNode.id, serverName, privateIp, nodeNetwork };
  }

  /** /24 of a dotted-quad IP (a sensible default node-network for the firewall). */
  static toSlash24(ip: string): string | undefined {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.trim());
    return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : undefined;
  }

  /** Admin API client over the cluster's M2M key (best-effort, normalises /api/v1). */
  private buildAdminApiClient(
    cluster: ClusterEntity,
    fluiApiKey: string,
  ): ApiClient | null {
    try {
      const cfg = new ConfigStorage();
      const raw =
        cfg.getApiUrl() ||
        (cluster.masterIpAddress
          ? `https://api.${buildNipBaseDomain(cluster.masterIpAddress, cluster.nipHostnameToken)}`
          : '');
      if (!raw || !fluiApiKey) return null;
      const baseUrl = raw.replace(/\/api\/v1\/?$/, '');
      return new ApiClient({ baseUrl, apiKey: fluiApiKey });
    } catch {
      return null;
    }
  }

  private async tryPatchNodeNetwork(
    api: ApiClient,
    clusterId: string,
    byos: { port: number; user: string; nodeNetwork: string },
    log: (m: string) => void,
  ): Promise<void> {
    try {
      await api.patch(`/api/v1/infrastructure/clusters/${clusterId}/metadata`, {
        metadata: { byos },
      });
    } catch (e) {
      log(`⚠ Could not persist node network: ${(e as Error).message}`);
    }
  }

  private async tryRegisterByosNode(
    api: ApiClient,
    clusterId: string,
    node: {
      serverName: string;
      ipAddress?: string;
      privateIp?: string;
      port: number;
      user: string;
    },
    log: (m: string) => void,
  ): Promise<void> {
    try {
      await api.post(
        `/api/v1/infrastructure/clusters/${clusterId}/byos-nodes`,
        {
          serverName: node.serverName,
          nodeType: 'worker',
          ipAddress: node.ipAddress,
          privateIp: node.privateIp,
          byos: { host: node.ipAddress, port: node.port, user: node.user },
        },
      );
      log('✅ Worker registered with the control plane (visible in dashboard)');
    } catch (e) {
      log(
        `⚠ Worker not registered with the API (dashboard may not list it): ${(e as Error).message}`,
      );
    }
  }

  /**
   * Reconcile the cluster host firewall through the idempotent enable endpoint.
   * A 404 means no firewall is configured — nothing to do (the join works
   * without one). Any other failure is logged, not fatal.
   */
  private async tryReconcileFirewall(
    api: ApiClient,
    clusterId: string,
    phase: string,
    log: (m: string) => void,
  ): Promise<void> {
    try {
      await api.get(`/api/v1/firewalls/cluster/${clusterId}`);
    } catch {
      log(`→ No host firewall on the cluster — skipping ${phase}`);
      return;
    }
    try {
      await api.post(`/api/v1/firewalls/cluster/${clusterId}/enable`, {});
      log(`✅ Host firewall reconciled: ${phase}`);
    } catch (e) {
      log(`⚠ Firewall reconcile failed (${phase}): ${(e as Error).message}`);
    }
  }

  /**
   * Decide what BYOS SSH coordinates to persist into the API-DB cluster
   * metadata. Only the perspective-independent bits (port/user) are stored —
   * the host is resolved from the node IP by the firewall backend. Returns null
   * for the default :22/root case, which the node-IP fallback already covers.
   * Pure (no I/O) so the skip-on-default decision is unit-testable.
   */
  static buildByosTargetPatch(
    clusterId: string,
    byos: { port?: number; user?: string },
  ): {
    path: string;
    body: { metadata: { byos: { port: number; user: string } } };
  } | null {
    const port = byos.port ?? 22;
    const user = byos.user ?? 'root';
    if (port === 22 && user === 'root') return null;
    return {
      path: `/api/v1/infrastructure/clusters/${clusterId}/metadata`,
      body: { metadata: { byos: { port, user } } },
    };
  }

  /**
   * Best-effort persistence of the BYOS SSH target to the API DB so the
   * dashboard/API firewall (and future SSH ops) can reach the node. Never
   * fatal: on failure the operator can set it later via
   * `PATCH /infrastructure/clusters/:id/metadata`.
   */
  private async persistByosTargetToApi(
    cluster: ClusterEntity,
    byos: { host?: string; port?: number; user?: string },
    fluiApiKey: string,
    opId: string,
  ): Promise<void> {
    const patch = CliClusterCreatorService.buildByosTargetPatch(
      cluster.id,
      byos,
    );
    if (!patch) return; // default :22/root — node-IP fallback already works

    try {
      const client = this.buildAdminApiClient(cluster, fluiApiKey);
      if (!client) {
        this.log(
          opId,
          '⚠ BYOS SSH-target persistence skipped (no API URL or key) — set it later from the dashboard.',
          'WARN',
        );
        return;
      }
      await client.patch(patch.path, patch.body);
      this.log(
        opId,
        '✅ BYOS SSH target persisted to API (firewall manageable from dashboard)',
      );
    } catch (e) {
      this.log(
        opId,
        `⚠ BYOS SSH-target persistence skipped: ${(e as Error).message}`,
        'WARN',
      );
    }
  }

  /**
   * Best-effort: register the cluster's private network as a first-class VNet on
   * the API DB (mirrors cloud — one network per cluster, nodes attach to it).
   * The server derives the CIDR from the master node when `ipRange` is omitted.
   * Never fatal: on failure the operator can run it later from the dashboard.
   */
  private async ensureByosVNetOnApi(
    cluster: ClusterEntity,
    ipRange: string | undefined,
    fluiApiKey: string,
    opId: string,
  ): Promise<void> {
    try {
      const client = this.buildAdminApiClient(cluster, fluiApiKey);
      if (!client) {
        this.log(
          opId,
          '⚠ BYOS VNet registration skipped (no API URL or key) — register it later from the dashboard.',
          'WARN',
        );
        return;
      }
      const res = await client.post<{ ipRange?: string }>(
        `/api/v1/infrastructure/clusters/${cluster.id}/byos-vnet`,
        ipRange ? { ipRange } : {},
      );
      this.log(
        opId,
        `✅ Private network registered as VNet (${res?.ipRange ?? 'derived'})`,
      );
    } catch (e) {
      this.log(
        opId,
        `⚠ BYOS VNet registration skipped: ${(e as Error).message}`,
        'WARN',
      );
    }
  }

  /**
   * Seed and apply the host firewall (nftables) by default on a fresh BYOS
   * install, through the idempotent enable endpoint: policy drop, with only
   * 22/80/443 (+ kubelet/flannel/internal) reachable. It creates the managed
   * ClusterFirewallEntity (editable from the dashboard) and reconciles over
   * SSH. Retries across the flui-api rollout that the SSH-CA secret patch
   * triggers — a missed apply would otherwise linger, since the scheduler only
   * reconciles cross-provider peers, not this. Best-effort: on persistent
   * failure the operator enables it from the dashboard (cluster → Firewall).
   */
  private async ensureByosHostFirewall(
    cluster: ClusterEntity,
    fluiApiKey: string,
    opId: string,
  ): Promise<void> {
    const client = this.buildAdminApiClient(cluster, fluiApiKey);
    if (!client) {
      throw new Error(
        hostFirewallFailureMessage(
          'no API URL or key available to reach the control plane',
        ),
      );
    }

    const path = `/api/v1/firewalls/cluster/${cluster.id}/enable`;
    const maxAttempts = 6;
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 15000));
      try {
        await client.post(path, {});
        this.log(
          opId,
          '✅ Host firewall enabled (nftables policy drop; 22/80/443 open)',
        );
        return;
      } catch (e) {
        const status = e instanceof ApiError ? e.statusCode : undefined;
        lastError = status
          ? `HTTP ${status} — ${(e as Error).message}`
          : (e as Error).message;
        if (!isRetryableApiFailure(status)) {
          // Log the resolved URL: a routing 404 and a real "not found" read
          // identically otherwise.
          this.log(
            opId,
            `✖ Permanent failure on POST ${client.getBaseUrl()}${path}: ${lastError}`,
            'ERROR',
          );
          break;
        }
        this.log(
          opId,
          `↻ Host firewall enable attempt ${attempt}/${maxAttempts} failed (API may be restarting): ${lastError}`,
        );
      }
    }
    throw new Error(hostFirewallFailureMessage(lastError));
  }

  /**
   * The cluster's own M2M key. Lets a remediation command reach the control
   * plane in the same conditions the installer had — before, or without, an
   * interactive `flui auth login`.
   */
  getClusterApiKey(cluster: ClusterEntity): string | null {
    try {
      return this.decryptClusterSecrets(cluster).fluiApiKey || null;
    } catch {
      return null;
    }
  }

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
      [CONTEXT_LABEL]: contextTag(),
    };

    this.logger.debug(`Uploading bootstrap key to provider for ${nodeName}...`);

    const keyName = `flui-bootstrap-${clusterId}-${nodeName}`;
    emitEvent({ type: 'resource', kind: 'ssh-key', id: null, name: keyName });

    const sshKey = await provider.createSSHKey(
      `flui-bootstrap-${clusterId}-${nodeName}`,
      publicKeyContent,
      bootstrapLabels,
    );

    emitEvent({
      type: 'resource',
      kind: 'ssh-key',
      id: String(sshKey.id),
      name: keyName,
    });
    this.logger.log(`Bootstrap key created for ${nodeName} (ID: ${sshKey.id})`);

    return {
      keyId: sshKey.id.toString(),
      publicKeyPath,
      privateKeyPath,
    };
  }

  /**
   * Ends the life of every throwaway key minted for a run.
   *
   * Three things have to happen, and only all three together mean "destroyed":
   * the key stops being authorised on the nodes, the provider stops holding a
   * copy, and the private half stops existing on this machine. Deleting the
   * provider resource alone is the mistake worth naming — the public key is
   * already in `authorized_keys` by then, so the account keeps working long
   * after the provider says the key is gone.
   *
   * Revocation on the node comes first, because it is the step that needs SSH.
   * Nothing here throws: a cluster that is otherwise built must not be reported
   * as failed because a cleanup call did. What could not be released is named
   * in the log, precisely enough to finish by hand.
   */
  private async destroyBootstrapKeys(
    opId: string,
    provider: any,
    keys: BootstrapKey[],
    nodeIps: string[],
  ): Promise<void> {
    if (keys.length === 0) return;

    for (const key of keys) {
      let publicKey = '';
      try {
        publicKey = fs.readFileSync(key.publicKeyPath, 'utf-8').trim();
      } catch {
        publicKey = '';
      }

      if (publicKey) {
        for (const ip of nodeIps) {
          try {
            await this.sshService.sshExecWithKey({
              host: ip,
              command: revokeAuthorizedKeyCommand(publicKey),
              keyPath: key.privateKeyPath,
            });
          } catch (error) {
            this.log(
              opId,
              `Could not revoke the bootstrap key on ${ip}: ${
                (error as Error).message
              }. It stays authorised until removed from ~/.ssh/authorized_keys.`,
              'WARN',
            );
          }
        }
      }

      try {
        await provider.deleteSSHKey?.(key.keyId);
        emitEvent({ type: 'released', name: key.keyId });
      } catch (error) {
        this.log(
          opId,
          `Could not delete bootstrap key ${key.keyId} at the provider: ${
            (error as Error).message
          }. Remove it from the provider console.`,
          'WARN',
        );
      }

      for (const file of [key.privateKeyPath, key.publicKeyPath]) {
        try {
          fs.rmSync(file, { force: true });
        } catch {
          this.log(opId, `Could not remove ${file}.`, 'WARN');
        }
      }
    }

    this.log(
      opId,
      `✅ ${keys.length} bootstrap key(s) revoked on the nodes, deleted at the provider and removed from this machine`,
    );
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
  private async fetchKubeconfig(
    masterIp: string,
    keyPath?: string,
  ): Promise<string> {
    const command = 'sudo cat /etc/rancher/k3s/k3s.yaml';
    const raw = keyPath
      ? await this.sshService.sshExecWithKey({
          host: masterIp,
          command,
          keyPath,
        })
      : await this.sshService.sshExec(masterIp, command);
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
    ssh?: {
      host?: string;
      port?: number;
      user?: string;
      /** Set in ephemeral-key mode: there is no CA to present a certificate from. */
      keyPath?: string;
    },
  ): Promise<void> {
    this.log(
      operationId,
      'Patching Kubernetes secret with SSH CA keys + bootstrap vars...',
    );

    try {
      const caPrivateKey = await this.caService.getCaPrivateKey();
      const caPublicKey = await this.caService.getCaPublicKey();

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
      if (ssh?.keyPath) {
        await this.sshService.sshExecWithKey({
          host: ssh.host ?? masterIp,
          command: writeAndPatchCmd,
          user: ssh.user ?? 'root',
          port: ssh.port ?? 22,
          keyPath: ssh.keyPath,
        });
      } else {
        await this.sshService.sshExec(
          ssh?.host ?? masterIp,
          writeAndPatchCmd,
          ssh?.user ?? 'root',
          ssh?.port ?? 22,
        );
      }

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
