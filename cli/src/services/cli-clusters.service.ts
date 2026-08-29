import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { ConfigStorage } from '../lib/config-storage';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { CreateClusterDto } from 'src/modules/infrastructure/clusters/dto/create-cluster.dto';
import { HostnameMode } from 'src/modules/dns/enums/hostname-mode.enum';
import {
  generateNipHostnameToken,
  isValidNipHostnameToken,
} from 'src/modules/dns/utils/nip-token.util';
import {
  InfrastructureOperationEntity,
  OperationType,
  OperationStatus,
} from 'src/modules/infrastructure/servers/entities/infrastructure-operations.entity';
import { CliClusterRepository } from '../lib/repositories/cli-cluster.repository';
import { CliOperationRepository } from '../lib/repositories/cli-operation.repository';
import { CliNodeRepository } from '../lib/repositories/cli-node.repository';
import { CliFirewallRepository } from '../lib/repositories/cli-firewall.repository';
import { EncryptionService } from 'src/modules/shared/encryption/services/encryption.service';
import { CliSshService } from './cli-ssh.service';
import { CliCaService } from './cli-ca.service';
import { ProviderFactory } from 'src/modules/providers/services/provider.factory';
import { FirewallProviderFactory } from 'src/modules/providers/core/factories/firewall-provider.factory';
import { belongsToContext } from '../lib/context-stamp';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/**
 * CLI Clusters Service
 *
 * Simplified version of ClustersService for CLI usage.
 * Uses file-based repositories and Bull queue mock.
 * Integrates SSH and CA management for secure server access.
 */
@Injectable()
export class CliClustersService {
  private readonly logger = new Logger(CliClustersService.name);

  constructor(
    private readonly clusterRepository: CliClusterRepository,
    private readonly operationRepository: CliOperationRepository,
    private readonly nodeRepository: CliNodeRepository,
    private readonly firewallRepository: CliFirewallRepository,
    private readonly encryptionService: EncryptionService,
    private readonly sshService: CliSshService,
    private readonly caService: CliCaService,
    private readonly providerFactory: ProviderFactory,
    private readonly firewallFactory: FirewallProviderFactory,
    @Inject('BullQueue_infrastructure')
    private readonly infrastructureQueue: any,
  ) {}

  /**
   * Create a new cluster
   */
  async create(createClusterDto: CreateClusterDto): Promise<{
    cluster: ClusterEntity;
    operation: InfrastructureOperationEntity;
  }> {
    this.logger.log(`Creating cluster: ${createClusterDto.name}`);

    // Get or create SSH key pair
    const { publicKey: sshPublicKey } =
      await this.sshService.getOrCreateSshKey();
    this.logger.log('SSH key ready for cluster provisioning');

    // Get or create CA certificate
    const caPublicKey = await this.caService.getCaPublicKey();
    this.logger.log('CA certificate ready for cluster provisioning');

    // Generate and encrypt K3s token
    const k3sToken = this.generateK3sToken();
    const k3sTokenEncrypted = this.encryptionService.encrypt(k3sToken);

    // Generate and encrypt observability stack passwords
    const postgresPassword = this.generateSecurePassword(64);
    const redisPassword = this.generateSecurePassword(64);
    const grafanaPassword = this.generateSecurePassword(64);
    // Generate CLI API key (pre-seeded into flui-secrets for BootstrapSeeder)
    const fluiApiKey = `flui_${uuidv4().replaceAll('-', '')}`;

    // Read provider credentials for bootstrap injection.
    // Hetzner uses a single API token; Scaleway uses an Access Key ID + Secret Key pair.
    // Both shapes are propagated to the cluster pod so BootstrapSeeder can re-create
    // the right credential rows server-side without an extra HTTP roundtrip.
    const configStorage = new ConfigStorage();
    let providerToken = '';
    let providerScalewayAccessKey = '';
    let providerScalewaySecretKey = '';
    let providerRegions = '';
    if (createClusterDto.provider === 'scaleway') {
      const creds = configStorage.getCredentials('scaleway') as {
        accessKey?: string;
        secretKey?: string;
      } | null;
      providerScalewayAccessKey = creds?.accessKey || '';
      providerScalewaySecretKey = creds?.secretKey || '';
      // Scaleway authenticates HTTP calls with the Secret Key (X-Auth-Token);
      // keep providerToken populated so legacy code paths still work.
      providerToken = providerScalewaySecretKey;
      providerRegions = 'fr-par,nl-ams,pl-waw';
    } else {
      providerToken = configStorage.getToken(createClusterDto.provider) || '';
      providerRegions = 'nbg1,fsn1,hel1,ash,hil';
    }

    // Generate JWT secret and admin credentials for local auth mode
    const jwtSecret = this.generateSecurePassword(64);
    const adminEmail = (createClusterDto.metadata as any)?.adminEmail || '';
    const adminPassword = this.generateSecurePassword(24);

    // Generate Zitadel secrets (only used by control clusters)
    const zitadelMasterkey = this.generateSecurePassword(32);
    const zitadelDbAdminPassword = this.generateSecurePassword(32);
    const zitadelDbUserPassword = this.generateSecurePassword(32);
    const zitadelAdminTempPassword = this.generateSecurePassword(24);

    // Get worker count from DTO
    const workerCount = createClusterDto.workerCount;

    // Determine cluster type from metadata (same logic as API; accept legacy flag)
    const metadata = createClusterDto.metadata || {};
    const clusterType =
      metadata.isControlCluster || metadata.isObservabilityCluster
        ? ClusterType.CONTROL
        : ClusterType.WORKLOAD;

    const hostnameMode =
      createClusterDto.endpointHostnameMode ?? HostnameMode.IP;
    let nipHostnameToken: string | null = null;
    if (hostnameMode === HostnameMode.IP) {
      if (createClusterDto.nipHostnameToken) {
        if (!isValidNipHostnameToken(createClusterDto.nipHostnameToken)) {
          throw new Error(
            'nipHostnameToken must match [a-z0-9-], 1-30 chars, no leading/trailing dash.',
          );
        }
        nipHostnameToken = createClusterDto.nipHostnameToken;
      } else {
        nipHostnameToken = generateNipHostnameToken();
      }
      this.logger.log(
        `Cluster ${createClusterDto.name} nip.io hostname token: ${nipHostnameToken}`,
      );
    }

    // Create cluster entity with SSH and CA info
    const cluster = this.clusterRepository.create({
      name: createClusterDto.name,
      provider: createClusterDto.provider,
      region: createClusterDto.region,
      nodeSize: createClusterDto.nodeSize,
      image: createClusterDto.image || 'ubuntu-24.04',
      nodeCount: 0, // Will be updated during creation
      status: ClusterStatus.CREATING,
      clusterType,
      k3sTokenEncrypted,
      k3sVersion: createClusterDto.k3sVersion || 'v1.35.4+k3s1',
      endpointHostnameMode: hostnameMode,
      nipHostnameToken,
      sharedStorageEnabled: createClusterDto.sharedStorageEnabled,
      sharedStorageVolumeSizeGb: createClusterDto.sharedStorageVolumeSizeGb,
      metadata: {
        ...createClusterDto.metadata,
        sshPublicKey,
        caPublicKey,
        // Store encrypted passwords for observability stack
        postgresPasswordEncrypted:
          this.encryptionService.encrypt(postgresPassword),
        redisPasswordEncrypted: this.encryptionService.encrypt(redisPassword),
        grafanaPasswordEncrypted:
          this.encryptionService.encrypt(grafanaPassword),
        // Auth mode — used by env:credentials to know which sections to show
        authMode: metadata.authMode || 'local',
        // Store encrypted JWT secret and admin credentials for local auth
        jwtSecretEncrypted: this.encryptionService.encrypt(jwtSecret),
        adminEmail,
        adminPasswordEncrypted: this.encryptionService.encrypt(adminPassword),
        // Store encrypted Zitadel secrets
        zitadelMasterkeyEncrypted:
          this.encryptionService.encrypt(zitadelMasterkey),
        zitadelDbAdminPasswordEncrypted: this.encryptionService.encrypt(
          zitadelDbAdminPassword,
        ),
        zitadelDbUserPasswordEncrypted: this.encryptionService.encrypt(
          zitadelDbUserPassword,
        ),
        zitadelAdminTempPasswordEncrypted: this.encryptionService.encrypt(
          zitadelAdminTempPassword,
        ),
        // Bootstrap seeder vars — injected into flui-secrets, read by BootstrapSeeder at API startup
        fluiApiKey, // plain text — written into K8s secret, not stored encrypted here
        providerTokenEncrypted: this.encryptionService.encrypt(providerToken),
        providerScalewayAccessKeyEncrypted: providerScalewayAccessKey
          ? this.encryptionService.encrypt(providerScalewayAccessKey)
          : '',
        providerScalewaySecretKeyEncrypted: providerScalewaySecretKey
          ? this.encryptionService.encrypt(providerScalewaySecretKey)
          : '',
        providerRegions,
      },
      sshKeyIds: createClusterDto.sshKeys || [],
    });

    await this.clusterRepository.save(cluster);

    // Create operation
    const operation = this.operationRepository.create({
      operationType: OperationType.CREATE_CLUSTER,
      status: OperationStatus.PENDING,
      resourceId: cluster.id,
      resourceType: 'cluster',
      resourceName: cluster.name,
      provider: cluster.provider as any,
      totalSteps: 5 + workerCount,
      currentStepIndex: 0,
      metadata: {
        clusterId: cluster.id,
        clusterConfig: createClusterDto,
        estimatedDurationInSeconds: 80,
        targetNodeCount: workerCount + 1,
        workerCount,
        sshPublicKey,
        caPublicKey,
        firewallId: createClusterDto.metadata?.firewallId,
        sourceCidrs: createClusterDto.metadata?.sourceCidrs,
      },
    });

    await this.operationRepository.save(operation);

    // Add job to queue (our mock queue will execute synchronously)
    await this.infrastructureQueue.add('create-cluster', {
      clusterId: cluster.id,
      operationId: operation.id,
    });

    return { cluster, operation };
  }

  /**
   * Wipe + re-bootstrap the cluster's existing master over SSH, leaving the
   * provider-side VM/firewall/volume/VNet untouched. Runs as a detached
   * background job like `create()` — the bootstrap can take many minutes.
   */
  async reinstallControlCluster(
    cluster: ClusterEntity,
  ): Promise<{ operationId: string }> {
    this.logger.log(`Reinstalling control cluster: ${cluster.name}`);

    const operation = this.operationRepository.create({
      operationType: OperationType.REINSTALL_CLUSTER,
      status: OperationStatus.PENDING,
      resourceId: cluster.id,
      resourceType: 'cluster',
      resourceName: cluster.name,
      provider: cluster.provider as any,
      totalSteps: 5,
      currentStepIndex: 0,
      metadata: {
        clusterId: cluster.id,
        estimatedDurationInSeconds: 600,
      },
    });
    await this.operationRepository.save(operation);

    cluster.status = ClusterStatus.SCALING;
    await this.clusterRepository.save(cluster);

    await this.infrastructureQueue.add('reinstall-cluster', {
      clusterId: cluster.id,
      operationId: operation.id,
    });

    return { operationId: operation.id };
  }

  /**
   * Get cluster by ID
   */
  async findOne(id: string): Promise<ClusterEntity | null> {
    return this.clusterRepository.findOne({
      where: { id },
      relations: ['nodes'],
    });
  }

  /**
   * Get kubeconfig for cluster
   */
  async getKubeconfig(clusterId: string): Promise<string | null> {
    const cluster = await this.findOne(clusterId);

    if (!cluster?.kubeconfigEncrypted) {
      return null;
    }

    return this.encryptionService.decrypt(cluster.kubeconfigEncrypted);
  }

  /**
   * Delete cluster with orphaned VPS cleanup
   */
  async remove(id: string): Promise<void> {
    const cluster = await this.findOne(id);

    if (!cluster) {
      throw new Error(`Cluster ${id} not found`);
    }

    this.logger.log(`Deleting control cluster ${id} (${cluster.name})`);
    this.logger.log(
      `Cluster details: ${JSON.stringify({
        id: cluster.id,
        name: cluster.name,
        provider: cluster.provider,
        region: cluster.region,
        status: cluster.status,
        nodeCount: cluster.nodeCount,
      })}`,
    );

    // Update status to DELETING
    cluster.status = ClusterStatus.DELETING;
    await this.clusterRepository.save(cluster);

    // BYOS: no provider API to delete servers — drop the local records only.
    // The host is the operator's own machine; uninstalling k3s is their call.
    if (cluster.provider === CloudProvider.BYOS) {
      const localNodes = await this.nodeRepository.find({
        where: { clusterId: cluster.id },
      });
      for (const node of localNodes) {
        await this.nodeRepository.remove(node);
      }
      await this.clusterRepository.remove(cluster);
      this.logger.log(
        `BYOS cluster ${cluster.id} records removed (server left intact)`,
      );
      return;
    }

    try {
      // Get provider instance
      const provider = this.providerFactory.getProvider(
        cluster.provider as any,
      );
      this.logger.log(`Using provider: ${cluster.provider}`);

      // PHASE 1: Delete nodes tracked in local storage
      const localNodes = await this.nodeRepository.find({
        where: { clusterId: cluster.id },
      });

      this.logger.log(
        `Phase 1: Found ${localNodes.length} nodes in local storage`,
      );
      if (localNodes.length > 0) {
        this.logger.log(
          `Local nodes details: ${JSON.stringify(
            localNodes.map((n) => ({
              id: n.id,
              serverName: n.serverName,
              providerResourceId: n.providerResourceId,
              nodeType: n.nodeType,
              ipAddress: n.ipAddress,
            })),
          )}`,
        );
      }

      const deletedServerIds = new Set<string>();
      const deletionActions: Array<{
        serverId: string;
        actionId: number;
        serverName: string;
      }> = [];

      // STEP 1: Initiate deletion for all tracked servers
      for (const node of localNodes) {
        if (node.providerResourceId) {
          this.logger.log(
            `Initiating deletion for tracked server ${node.serverName} (${node.providerResourceId})`,
          );

          try {
            const result = await provider.deleteServer({
              server_id: node.providerResourceId,
              provider: cluster.provider as any,
              force: true, // Force delete even if server is running
            });

            if (result.actionId) {
              deletionActions.push({
                serverId: node.providerResourceId,
                actionId: result.actionId,
                serverName: node.serverName,
              });
              this.logger.log(
                `✓ Deletion initiated for ${node.serverName} (Action ID: ${result.actionId})`,
              );
            } else {
              // If no actionId, mark as deleted immediately (might be already deleted)
              deletedServerIds.add(node.providerResourceId);
              this.logger.log(
                `✓ Server ${node.serverName} deleted (no action tracking needed)`,
              );
            }
          } catch (error) {
            // Log error but continue with other nodes
            this.logger.error(
              `✗ Failed to delete tracked server ${node.serverName}:`,
              error.message,
            );
          }

          // Remove node from file storage
          await this.nodeRepository.remove(node);
        }
      }

      // STEP 2: Wait for all deletion actions to complete
      if (deletionActions.length > 0) {
        this.logger.log(
          `Waiting for ${deletionActions.length} server deletion(s) to complete...`,
        );

        // Check if provider supports waitForActionCompletion (Hetzner does)
        if (typeof (provider as any).waitForActionCompletion === 'function') {
          for (const action of deletionActions) {
            try {
              this.logger.log(
                `Waiting for server ${action.serverName} deletion to complete (Action ID: ${action.actionId})...`,
              );
              await (provider as any).waitForActionCompletion(action.actionId);
              deletedServerIds.add(action.serverId);
              this.logger.log(`✓ Server ${action.serverName} fully deleted`);
            } catch (error) {
              this.logger.error(
                `✗ Failed to wait for server ${action.serverName} deletion:`,
                error.message,
              );
              // Even if waiting fails, mark as deleted to continue cleanup
              deletedServerIds.add(action.serverId);
            }
          }
        } else {
          this.logger.warn(
            'Provider does not support action tracking. Proceeding without waiting.',
          );
          // Mark all as deleted if provider doesn't support action tracking
          deletionActions.forEach((action) =>
            deletedServerIds.add(action.serverId),
          );
        }

        this.logger.log(
          `✓ All tracked server deletions completed (${deletedServerIds.size} servers deleted)`,
        );
      }

      // PHASE 2: Scan provider for orphaned VPS with matching observability-id
      this.logger.log(
        `Phase 2: Scanning ${cluster.provider} for orphaned VPS...`,
      );

      const allServers = await provider.listServersAsDto();
      this.logger.log(`Found ${allServers.length} total servers on provider`);

      if (allServers.length > 0) {
        this.logger.log(
          `All servers summary: ${JSON.stringify(
            allServers.map((s) => ({
              id: s.provider_resource_id,
              name: s.name,
              labels: s.labels?.map((l) => `${l.key}=${l.value}`),
            })),
          )}`,
        );
      }

      // Filter servers that belong to this control cluster
      const orphanedServers = allServers.filter((server) => {
        // Check if already deleted in Phase 1
        if (deletedServerIds.has(server.provider_resource_id)) {
          this.logger.log(
            `Skipping server ${server.name} - already deleted in Phase 1`,
          );
          return false;
        }

        // Check if server belongs to this control cluster
        const hasObservabilityId = server.labels?.some(
          (label) =>
            label.key === 'flui-cluster-id' && label.value === cluster.id,
        );

        // Check if server is managed by flui
        const isFluiManaged = server.labels?.some(
          (label) => label.key === 'managed-by' && label.value === 'flui-cloud',
        );

        const isMatch = hasObservabilityId && isFluiManaged;

        this.logger.log(
          `Server ${server.name}: isFluiManaged=${isFluiManaged}, hasObservabilityId=${hasObservabilityId}, isMatch=${isMatch}`,
        );

        return isMatch;
      });

      this.logger.log(
        `Found ${orphanedServers.length} orphaned VPS to clean up`,
      );

      // Delete orphaned VPS with safety checks
      const orphanedDeletionActions: Array<{
        serverId: string;
        actionId: number;
        serverName: string;
      }> = [];

      for (const server of orphanedServers) {
        if (this.verifySafeDeletion(server, cluster.id)) {
          try {
            this.logger.log(
              `Initiating deletion for orphaned VPS ${server.name} (${server.provider_resource_id})`,
            );
            const result = await provider.deleteServer({
              server_id: server.provider_resource_id,
              provider: cluster.provider as any,
              force: true, // Force delete even if server is running
            });

            if (result.actionId) {
              orphanedDeletionActions.push({
                serverId: server.provider_resource_id,
                actionId: result.actionId,
                serverName: server.name,
              });
              this.logger.log(
                `✓ Deletion initiated for ${server.name} (Action ID: ${result.actionId})`,
              );
            } else {
              this.logger.log(
                `✓ Orphaned VPS ${server.name} deleted (no action tracking needed)`,
              );
            }
          } catch (error) {
            this.logger.error(
              `✗ Failed to delete orphaned VPS ${server.name}:`,
              error.message,
            );
          }
        } else {
          this.logger.warn(
            `⚠ Skipped VPS ${server.name} - safety check failed`,
          );
        }
      }

      // Wait for all orphaned server deletions to complete
      if (orphanedDeletionActions.length > 0) {
        this.logger.log(
          `Waiting for ${orphanedDeletionActions.length} orphaned VPS deletion(s) to complete...`,
        );

        if (typeof (provider as any).waitForActionCompletion === 'function') {
          for (const action of orphanedDeletionActions) {
            try {
              this.logger.log(
                `Waiting for orphaned VPS ${action.serverName} deletion to complete (Action ID: ${action.actionId})...`,
              );
              await (provider as any).waitForActionCompletion(action.actionId);
              this.logger.log(
                `✓ Orphaned VPS ${action.serverName} fully deleted`,
              );
            } catch (error) {
              this.logger.error(
                `✗ Failed to wait for orphaned VPS ${action.serverName} deletion:`,
                error.message,
              );
            }
          }
        }

        this.logger.log(
          `✓ All orphaned VPS deletions completed (${orphanedDeletionActions.length} servers deleted)`,
        );
      }

      // PHASE 2.5: Delete cluster firewalls (GUARANTEED CLEANUP)
      this.logger.log(
        `Phase 2.5: Deleting cluster firewalls from ${cluster.provider}...`,
      );

      try {
        const providerEnum = (
          cluster.provider || ''
        ).toLowerCase() as CloudProvider;
        const firewallService =
          this.firewallFactory.getFirewallProviderOrFail(providerEnum);

        // STEP 1: Find ALL firewalls for this cluster
        this.logger.log(
          `Searching for firewalls with label flui-cluster-id=${cluster.id}`,
        );
        const clusterFirewalls = await firewallService.listFirewalls({
          clusterId: cluster.id,
        });

        this.logger.log(
          `Found ${clusterFirewalls.length} firewall(s) for cluster ${cluster.id}`,
        );

        // STEP 1b: FALLBACK - Search by name pattern if no firewalls found by label
        let allFirewalls = [...clusterFirewalls];
        if (clusterFirewalls.length === 0) {
          this.logger.log(
            `No firewalls found by label. Searching by name pattern...`,
          );
          // Exact cluster-scoped names only — never global prefixes (would hit
          // another cluster's firewall).
          const allProviderFirewalls = await firewallService.listFirewalls({});
          const nameMatchedFirewalls = allProviderFirewalls.filter(
            (fw) =>
              fw.name === `flui-control-firewall-${cluster.id}` ||
              fw.name === `flui-control-${cluster.id}` ||
              fw.name === `flui-observability-${cluster.id}`,
          );

          if (nameMatchedFirewalls.length > 0) {
            this.logger.log(
              `Found ${nameMatchedFirewalls.length} firewall(s) by name pattern:`,
            );
            nameMatchedFirewalls.forEach((fw) => {
              this.logger.log(`  - ${fw.name} (${fw.id})`);
            });
            allFirewalls.push(...nameMatchedFirewalls);
          } else {
            this.logger.log(
              `No firewalls found with observability name patterns`,
            );
          }
        }

        // STEP 1c: Sweep control firewalls this context left behind before a
        // cluster existed to label them with. Such a firewall carries no
        // flui-cluster-id, so neither the label query nor the scoped-name
        // fallback above can find it.
        //
        // What makes this safe is the context stamp, and nothing else. One
        // provider account holds several installations, and a control firewall
        // belonging to a live one is indistinguishable from a leftover by name
        // or by any other label: both are `flui-control-firewall-<hex>` with
        // the same three labels. Deciding by name once matched a production
        // firewall, and only the provider refusing to delete an in-use one kept
        // it. An unstamped firewall is therefore never claimed — everything
        // created before the stamp existed is unstamped, and that population is
        // exactly the one that must not be guessed at.
        if (isControlClusterType(cluster.clusterType)) {
          const known = new Set(allFirewalls.map((fw) => fw.id));
          const providerFirewalls = await firewallService.listFirewalls({});
          const orphans = providerFirewalls.filter(
            (fw) =>
              belongsToContext(fw.labels) &&
              fw.labels['flui-cluster-type'] === 'control' &&
              !fw.labels['flui-cluster-id'] &&
              !known.has(fw.id),
          );
          if (orphans.length > 0) {
            this.logger.log(
              `Found ${orphans.length} control firewall(s) of this context with no cluster:`,
            );
            orphans.forEach((fw) =>
              this.logger.log(`  - ${fw.name} (${fw.id})`),
            );
            allFirewalls.push(...orphans);
          }
        }

        if (allFirewalls.length === 0) {
          this.logger.log('✓ No firewalls to delete for this cluster');
        } else {
          // STEP 2: Delete each firewall, retrying while the server still holds it
          const deletePromises = allFirewalls.map(async (fw) => {
            const maxRetries = 6;
            const retryDelay = 5000; // 5 seconds

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
              try {
                this.logger.log(
                  `Deleting firewall ${fw.name} (${fw.id}) - Attempt ${attempt}/${maxRetries}`,
                );
                await firewallService.deleteFirewall(fw.id);
                this.logger.log(`✓ Deleted firewall ${fw.name}`);
                return { success: true, id: fw.id, name: fw.name };
              } catch (error) {
                // Retry on any error: the firewall frees up once the server is gone.
                if (attempt < maxRetries) {
                  this.logger.warn(
                    `Firewall ${fw.name} not deletable yet (${error.message}); retry ${attempt + 1}/${maxRetries} in ${retryDelay}ms...`,
                  );
                  await new Promise((resolve) =>
                    setTimeout(resolve, retryDelay),
                  );
                  continue; // Retry
                }

                this.logger.error(
                  `✗ Failed to delete firewall ${fw.name} after ${attempt} attempts: ${error.message}`,
                );
                return { success: false, id: fw.id, name: fw.name, error };
              }
            }

            return {
              success: false,
              id: fw.id,
              name: fw.name,
              error: new Error('Max retries exceeded'),
            };
          });

          const results = await Promise.all(deletePromises);
          const failedCount = results.filter((r) => !r.success).length;

          // STEP 3: VERIFICATION - Re-scan to ensure all deleted
          this.logger.log('Verifying all firewalls deleted...');
          const remainingFirewalls = await firewallService.listFirewalls({
            clusterId: cluster.id,
          });

          if (remainingFirewalls.length > 0) {
            this.logger.warn(
              `⚠️  WARNING: ${remainingFirewalls.length} firewall(s) still exist for cluster after deletion!`,
            );

            // RETRY deletion for remaining firewalls
            for (const fw of remainingFirewalls) {
              try {
                this.logger.log(
                  `RETRY: Deleting firewall ${fw.name} (${fw.id})`,
                );
                await firewallService.deleteFirewall(fw.id);
                this.logger.log(`✓ RETRY SUCCESS: Deleted firewall ${fw.name}`);
              } catch (error) {
                this.logger.error(
                  `✗ RETRY FAILED: Could not delete firewall ${fw.name}: ${error.message}`,
                );
              }
            }

            // Final verification
            const finalCheck = await firewallService.listFirewalls({
              clusterId: cluster.id,
            });

            if (finalCheck.length > 0) {
              this.logger.error(
                `❌ CRITICAL: ${finalCheck.length} firewall(s) could not be deleted. Manual cleanup required:`,
              );
              finalCheck.forEach((fw) => {
                this.logger.error(
                  `   - Firewall ID: ${fw.id}, Name: ${fw.name}`,
                );
              });
            } else {
              this.logger.log(
                '✓ All firewalls successfully deleted after retry',
              );
            }
          } else {
            this.logger.log(
              `✓ Successfully deleted all ${allFirewalls.length} firewall(s)`,
            );
          }

          if (failedCount > 0) {
            this.logger.warn(
              `${failedCount} firewall deletion(s) failed on first attempt`,
            );
          }

          // STEP 4: Clean up firewall from local storage
          this.logger.log('Cleaning up firewall from local storage...');
          for (const fw of allFirewalls) {
            try {
              await this.firewallRepository.delete(fw.id);
              this.logger.log(`✓ Removed firewall ${fw.id} from local storage`);
            } catch (error) {
              this.logger.warn(
                `Failed to remove firewall ${fw.id} from local storage: ${error.message}`,
              );
            }
          }
        }
      } catch (error) {
        this.logger.error(
          `Phase 2.5 failed: ${error.message}. Continuing with cluster deletion...`,
        );
        this.logger.error(`Error stack: ${error.stack}`);
      }

      this.logger.log('Phase 2.5 completed: Firewall cleanup finished');

      // PHASE 3: Clean up bootstrap SSH keys
      this.logger.log(
        `Phase 3: Scanning ${cluster.provider} for bootstrap SSH keys...`,
      );

      if (provider.listSSHKeys && provider.deleteSSHKey) {
        const allKeys = await provider.listSSHKeys();
        this.logger.log(`Found ${allKeys.length} total SSH keys on provider`);

        // Filter bootstrap keys for this control cluster
        const bootstrapKeys = allKeys.filter((key) => {
          const tags = key.tags || {};
          const tagMatch =
            tags['managed-by'] === 'flui-cloud' &&
            tags['flui-cluster-id'] === cluster.id &&
            tags['flui-resource-type'] === 'ssh-key';
          // Scaleway IAM keys have no tags — match the cluster id in the name.
          const nameMatch =
            typeof key.name === 'string' &&
            key.name.startsWith(`flui-bootstrap-${cluster.id}`);
          return tagMatch || nameMatch;
        });

        this.logger.log(
          `Found ${bootstrapKeys.length} bootstrap SSH keys to clean up`,
        );

        // Delete bootstrap keys
        for (const key of bootstrapKeys) {
          try {
            this.logger.log(
              `Deleting bootstrap SSH key ${key.name} (${key.id})`,
            );
            await provider.deleteSSHKey(key.id.toString());
            this.logger.log(`✓ Deleted bootstrap SSH key ${key.name}`);
          } catch (error) {
            this.logger.error(
              `✗ Failed to delete bootstrap SSH key ${key.name}:`,
              error.message,
            );
          }
        }

        // Clean up local bootstrap key files
        const bootstrapDir = path.join(
          os.homedir(),
          '.flui',
          'bootstrap-keys',
          cluster.id,
        );
        if (fs.existsSync(bootstrapDir)) {
          try {
            fs.rmSync(bootstrapDir, { recursive: true, force: true });
            this.logger.log(
              `✓ Cleaned up local bootstrap keys: ${bootstrapDir}`,
            );
          } catch (error) {
            this.logger.warn(
              `Failed to cleanup local bootstrap keys: ${error.message}`,
            );
          }
        }
      } else {
        this.logger.warn(
          `Provider ${cluster.provider} does not support SSH key management, skipping Phase 3`,
        );
      }

      // Detach + delete the Flui-managed shared storage Volume (if any).
      // We do this AFTER servers are deleted so the volume is already detached
      // at the provider; the explicit detachVolume call is a belt-and-braces
      // safety net for cases where the provider doesn't auto-detach.
      if (cluster.sharedStorageVolumeId) {
        const volumeRef = this.formatVolumeRef(
          cluster.sharedStorageVolumeId,
          cluster.provider,
          cluster.region,
        );
        this.logger.log(
          `[volume-cleanup] Starting detach+delete for ${volumeRef}`,
        );
        if (provider.detachVolume) {
          try {
            await provider.detachVolume(volumeRef);
          } catch (detachErr) {
            this.logger.warn(
              `[volume-cleanup] Detach failed for ${volumeRef}: ${(detachErr as Error).message} — will retry delete anyway`,
            );
          }
        }
        if (provider.deleteVolume) {
          // Scaleway can take a few seconds to release the volume reference
          // after the server is gone. Retry with backoff before giving up.
          const maxAttempts = 6;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              await provider.deleteVolume(volumeRef);
              this.logger.log(
                `[volume-cleanup] ✓ Deleted shared storage volume ${volumeRef}`,
              );
              break;
            } catch (volErr) {
              const msg = (volErr as Error).message;
              const lastAttempt = attempt === maxAttempts;
              if (lastAttempt) {
                this.logger.warn(
                  `[volume-cleanup] FAILED after ${attempt} attempts: ${msg}. ` +
                    `Run "flui env orphan-volumes --cleanup" to recover.`,
                );
              } else {
                this.logger.warn(
                  `[volume-cleanup] attempt ${attempt}/${maxAttempts} failed (${msg}); retrying in 5s...`,
                );
                await new Promise((r) => setTimeout(r, 5000));
              }
            }
          }
        } else {
          this.logger.warn(
            `[volume-cleanup] Provider ${cluster.provider} has no deleteVolume — leaving ${volumeRef} at provider`,
          );
        }
      }

      // Remove cluster from file storage
      await this.clusterRepository.remove(cluster);
      this.logger.log(`✓ Successfully deleted cluster ${cluster.name}`);
      this.logger.log(
        `Total: ${localNodes.length} tracked + ${orphanedServers.length} orphaned VPS cleaned up`,
      );
    } catch (error) {
      // If deletion fails, revert status to ERROR
      cluster.status = ClusterStatus.ERROR;
      await this.clusterRepository.save(cluster);

      this.logger.error(`Failed to delete cluster ${id}:`, error);
      throw error;
    }
  }

  /**
   * Verify that a server is safe to delete
   * Checks for all required flui labels
   */
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

  private verifySafeDeletion(
    server: any,
    expectedObservabilityId: string,
  ): boolean {
    const labels = server.labels || [];

    // MUST have managed-by = flui-cloud
    const isFluiManaged = labels.some(
      (label: any) =>
        label.key === 'managed-by' && label.value === 'flui-cloud',
    );

    // MUST have matching cluster-id
    const hasMatchingObsId = labels.some(
      (label: any) =>
        label.key === 'flui-cluster-id' &&
        label.value === expectedObservabilityId,
    );

    // MUST have node-type (master or worker)
    const hasNodeType = labels.some(
      (label: any) =>
        label.key === 'flui-node-type' &&
        (label.value === 'master' || label.value === 'worker'),
    );

    // MUST have resource-type = cluster-node
    const isClusterNode = labels.some(
      (label: any) =>
        label.key === 'flui-resource-type' && label.value === 'cluster-node',
    );

    const isSafe =
      isFluiManaged && hasMatchingObsId && hasNodeType && isClusterNode;

    if (!isSafe) {
      this.logger.warn(`Safety check FAILED for server ${server.name}:`, {
        isFluiManaged,
        hasMatchingObsId,
        hasNodeType,
        isClusterNode,
        labels: labels.map((l: any) => `${l.key}=${l.value}`),
      });
    }

    return isSafe;
  }

  /**
   * Get or create encryption key from ~/.flui/encryption.key
   * Same pattern as CA: generate once, reuse forever.
   * This key is shared between CLI and API (local dev) and deployed
   * to K8s clusters as ENCRYPTION_KEY in the flui-secrets Secret.
   */
  private getOrCreateEncryptionKey(): string {
    const keyDir = path.join(os.homedir(), '.flui');
    const keyFilePath = path.join(keyDir, 'encryption.key');

    // Reuse existing key
    if (fs.existsSync(keyFilePath)) {
      const existingKey = fs.readFileSync(keyFilePath, 'utf-8').trim();
      if (existingKey.length === 64) {
        this.logger.log('Reusing encryption key from ~/.flui/encryption.key');
        return existingKey;
      }
      this.logger.warn(
        'Invalid encryption key in ~/.flui/encryption.key, regenerating',
      );
    }

    // Generate new key
    const newKey = randomBytes(32).toString('hex');
    if (!fs.existsSync(keyDir)) {
      fs.mkdirSync(keyDir, { recursive: true });
    }
    fs.writeFileSync(keyFilePath, newKey, { encoding: 'utf-8', mode: 0o600 });
    this.logger.log('Generated new encryption key at ~/.flui/encryption.key');
    return newKey;
  }

  /**
   * Generate random K3s token
   */
  private generateK3sToken(): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let token = '';
    for (let i = 0; i < 64; i++) {
      token += chars.charAt(randomInt(chars.length));
    }
    return token;
  }

  /**
   * Generate secure password for observability stack components
   * Uses safe characters for bash variables: a-zA-Z0-9-_@.+:=
   */
  private generateSecurePassword(length: number = 64): string {
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const symbols = '-_@.+:=';
    const charset = lower + upper + digits + symbols;

    const chars: string[] = [];
    chars.push(
      lower.charAt(randomInt(lower.length)),
      upper.charAt(randomInt(upper.length)),
      digits.charAt(randomInt(digits.length)),
      symbols.charAt(randomInt(symbols.length)),
    );
    for (let i = 4; i < length; i++) {
      chars.push(charset.charAt(randomInt(charset.length)));
    }
    for (let i = chars.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
  }
}
