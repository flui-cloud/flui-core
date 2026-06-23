import { Injectable, Logger } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CliLoggerService } from './cli-logger.service';
import { getScriptsBaseUrl } from '../config/bootstrap.config';
import { resolveEffectiveImageTags } from '../config/release-override';

export interface K3sMasterConfig {
  serverId?: string; // Database node ID (ClusterNodeEntity.id) - used for observability metrics
  clusterId: string;
  clusterName: string;
  k3sToken: string;
  k3sVersion?: string;
  instanceId: string;
  instanceName: string;
  provider: string;
  caPublicKey?: string;
  operationId?: string; // For logging to operation log file
  // Observability stack configuration
  deployObservabilityStack?: boolean;
  // Observability stack passwords
  postgresPassword: string;
  redisPassword: string;
  grafanaPassword: string;
  encryptionKey?: string;
  // Auth mode configuration
  authMode?: string;
  jwtSecret?: string;
  adminEmail?: string;
  adminPassword?: string;
  // Zitadel identity provider
  zitadelMasterkey?: string;
  zitadelDbAdminPassword?: string;
  zitadelDbUserPassword?: string;
  zitadelDomain?: string;
  zitadelAdminEmail?: string;
  zitadelAdminTempPassword?: string;
  // BootstrapSeeder vars — pre-seeded via cloud-init so API can populate DB at first boot
  fluiApiKey?: string;
  providerApiKey?: string;
  providerScalewayAccessKey?: string;
  providerScalewaySecretKey?: string;
  providerRegions?: string;
  clusterRegion?: string;
  instanceType?: string;
  clusterFirewallId?: string;
  /** BYOS: operator-provided public IP — drives the nip.io domain when the
   *  node's detected IP isn't the reachable address (NAT / fixed public IP). */
  masterPublicIp?: string;
  nipIoCertEnabled?: boolean;
  acmeStaging?: boolean;
  /**
   * Install from mobile tags instead of the pinned release: bootstrap ref
   * `master` + `:latest` Docker images. Set by `flui env create --latest`.
   */
  useLatest?: boolean;
  // Per-cluster nip.io hostname token. When set, system FQDNs become
  // auth/api/app.${token}.${masterIp}.nip.io — gives each cluster a unique
  // Let's Encrypt domain set so repeated test creations don't burn the
  // 5-certs-per-7-days rate limit on the same IP.
  nipHostnameToken?: string | null;
  envVnet?: {
    vnetProviderResourceId: string;
    vnetProvider: string;
    vnetName: string;
    vnetIpRange: string;
    subnetProviderResourceId: string;
    subnetIpRange: string;
    subnetType: string;
    networkZone: string;
  };
  /**
   * Flui shared storage configuration (NFS+fscache, see scaling doc §14).
   * When `enabled`, the master mounts a Flui-managed Volume on
   * /var/lib/flui/storage, exports it via NFSv4, and re-points
   * local-path-provisioner to it. Workers mount the same path via NFS.
   */
  sharedStorage?: {
    enabled: boolean;
    volumeDevicePath?: string;
    volumeSizeGb?: number;
  };
}

export interface K3sWorkerConfig {
  serverId?: string; // Database node ID (ClusterNodeEntity.id) - used for observability metrics
  clusterId: string;
  clusterName: string;
  k3sToken: string;
  masterIp: string;
  k3sVersion?: string;
  instanceId: string;
  instanceName: string;
  provider: string;
  caPublicKey?: string;
  operationId?: string; // For logging to operation log file
  /** See K3sMasterConfig.useLatest — keeps the worker on the same bootstrap ref. */
  useLatest?: boolean;
  /**
   * Flui shared storage on workers: install cachefilesd + mount NFS export
   * from master. See scaling doc §14.
   */
  sharedStorage?: {
    enabled: boolean;
    masterPrivateIp?: string;
  };
}

/**
 * CLI K3s Script Service
 *
 * Generates K3s initialization scripts for control clusters.
 * Uses scripts from cli/src/modules/instances/assets/scripts/ directory.
 */
@Injectable()
export class CliK3sScriptService {
  private readonly logger = new Logger(CliK3sScriptService.name);

  constructor(private readonly cliLogger: CliLoggerService) {}

  /**
   * Log to both console and operation log file
   */
  private log(
    message: string,
    operationId?: string,
    level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG' = 'INFO',
  ): void {
    // Always log to console
    switch (level) {
      case 'ERROR':
        this.logger.error(message);
        break;
      case 'WARN':
        this.logger.warn(message);
        break;
      case 'DEBUG':
        this.logger.debug(message);
        break;
      default:
        this.logger.log(message);
    }

    // Also log to file if operationId is provided
    if (operationId) {
      this.cliLogger.writeLog(operationId, message, level);
    }
  }

  /**
   * Generate cloud-init script for K3s master node
   * Uses bootstrap approach: generates minimal script that downloads from GitHub
   */
  async generateMasterScript(config: K3sMasterConfig): Promise<string> {
    const opId = config.operationId;
    try {
      this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, opId);
      this.log(
        `[BOOTSTRAP MASTER SCRIPT] Cluster: ${config.clusterName}`,
        opId,
      );
      const scriptsBaseUrl = getScriptsBaseUrl(config.useLatest ?? false);
      const imageTags = resolveEffectiveImageTags(config.useLatest ?? false);
      this.log(`Scripts URL: ${scriptsBaseUrl}`, opId);

      // Generate bootstrap script that downloads and executes k3s-master-init.sh from GitHub
      const script = this.generateBootstrapScript('master', {
        SCRIPTS_BASE_URL: scriptsBaseUrl,
        MANIFESTS_BASE_URL: scriptsBaseUrl.replace('/scripts', '/manifests'),
        SERVER_ID: config.serverId || '', // Database node ID for observability
        INSTANCE_ID: config.instanceId,
        INSTANCE_NAME: config.instanceName,
        CLOUD_PROVIDER: config.provider,
        CLUSTER_ID: config.clusterId,
        CLUSTER_NAME: config.clusterName,
        K3S_TOKEN: config.k3sToken,
        K3S_VERSION: config.k3sVersion || 'v1.35.4+k3s1',
        // Pinned Flui image tags — consumed by the system manifests via envsubst.
        FLUI_API_IMAGE_TAG: imageTags.fluiApi,
        FLUI_WEB_IMAGE_TAG: imageTags.fluiWeb,
        FLUI_AUTHZ_IMAGE_TAG: imageTags.fluiAuthz,
        DEPLOY_OBSERVABILITY_STACK: config.deployObservabilityStack
          ? 'true'
          : 'false',
        POSTGRES_PASSWORD: config.postgresPassword,
        REDIS_PASSWORD: config.redisPassword,
        GRAFANA_PASSWORD: config.grafanaPassword,
        AUTH_MODE: config.authMode || 'local',
        JWT_SECRET: config.jwtSecret || '',
        ADMIN_EMAIL: config.adminEmail || '',
        ADMIN_PASSWORD: config.adminPassword || '',
        ENCRYPTION_KEY: config.encryptionKey || '',
        ZITADEL_MASTERKEY: config.zitadelMasterkey || '',
        ZITADEL_DB_ADMIN_PASSWORD: config.zitadelDbAdminPassword || '',
        ZITADEL_DB_USER_PASSWORD: config.zitadelDbUserPassword || '',
        ZITADEL_DOMAIN: config.zitadelDomain || '',
        ZITADEL_ADMIN_EMAIL:
          config.zitadelAdminEmail || config.adminEmail || '',
        ZITADEL_ADMIN_TEMP_PASSWORD: config.zitadelAdminTempPassword || '',
        ZITADEL_AUDIENCE: '',
        FLUI_CA_PUBLIC_KEY: config.caPublicKey || '',
        FLUI_NIP_IO_CERT_ENABLED: config.nipIoCertEnabled ? 'true' : '',
        FLUI_ACME_STAGING: config.acmeStaging ? 'true' : '',
        // BootstrapSeeder vars — available at envsubst time so API reads them at first boot
        FLUI_CLI_API_KEY: config.fluiApiKey || '',
        PROVIDER_HETZNER_API_KEY:
          config.provider === 'hetzner' ? config.providerApiKey || '' : '',
        PROVIDER_SCALEWAY_ACCESS_KEY: config.providerScalewayAccessKey || '',
        PROVIDER_SCALEWAY_SECRET_KEY: config.providerScalewaySecretKey || '',
        PROVIDER_REGIONS: config.providerRegions || '',
        CLUSTER_REGION: config.clusterRegion || '',
        INSTANCE_TYPE: config.instanceType || '',
        CLUSTER_FIREWALL_ID: config.clusterFirewallId || '',
        FLUI_MASTER_PUBLIC_IP: config.masterPublicIp || '',
        FLUI_VNET_PROVIDER_RESOURCE_ID:
          config.envVnet?.vnetProviderResourceId || '',
        FLUI_VNET_PROVIDER: config.envVnet?.vnetProvider || '',
        FLUI_VNET_NAME: config.envVnet?.vnetName || '',
        FLUI_VNET_IP_RANGE: config.envVnet?.vnetIpRange || '',
        FLUI_SUBNET_PROVIDER_RESOURCE_ID:
          config.envVnet?.subnetProviderResourceId || '',
        FLUI_SUBNET_IP_RANGE: config.envVnet?.subnetIpRange || '',
        FLUI_SUBNET_TYPE: config.envVnet?.subnetType || '',
        FLUI_SUBNET_NETWORK_ZONE: config.envVnet?.networkZone || '',
        NIP_HOSTNAME_TOKEN: config.nipHostnameToken || '',
        // Flui shared storage (NFS+fscache, scaling doc §14)
        FLUI_SHARED_STORAGE_ENABLED: config.sharedStorage?.enabled
          ? 'true'
          : 'false',
        FLUI_SHARED_STORAGE_DEVICE:
          config.sharedStorage?.volumeDevicePath ?? '',
        FLUI_SHARED_STORAGE_VOLUME_GB: String(
          config.sharedStorage?.volumeSizeGb ?? 0,
        ),
      });

      this.log(`Bootstrap script generated: ${script.length} bytes`, opId);

      // VALIDATION: Check script size is within limits
      const MAX_SIZE = 32000; // Hetzner limit: 32 KiB
      if (script.length > MAX_SIZE) {
        throw new Error(
          `Bootstrap script exceeds Hetzner limit: ${script.length} bytes > ${MAX_SIZE} bytes`,
        );
      }
      this.log(`✓ Script size OK: ${script.length} / ${MAX_SIZE} bytes`, opId);

      // Save debug copy
      await this.saveDebugScript(config.clusterId, 'master.sh', script, opId);

      this.log(`✅ Bootstrap master script generated successfully`, opId);
      this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, opId);

      return script;
    } catch (error) {
      this.logger.error(
        `Failed to generate master script: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Generate cloud-init script for K3s worker node
   * Uses bootstrap approach: generates minimal script that downloads from GitHub
   */
  async generateWorkerScript(config: K3sWorkerConfig): Promise<string> {
    const opId = config.operationId;
    try {
      this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, opId);
      this.log(
        `[BOOTSTRAP WORKER SCRIPT] Cluster: ${config.clusterName}`,
        opId,
      );
      const scriptsBaseUrl = getScriptsBaseUrl(config.useLatest ?? false);
      this.log(`Scripts URL: ${scriptsBaseUrl}`, opId);

      // Generate bootstrap script that downloads and executes k3s-worker-init.sh from GitHub
      const script = this.generateBootstrapScript('worker', {
        SERVER_ID: config.serverId || '', // Database node ID for observability
        SCRIPTS_BASE_URL: scriptsBaseUrl,
        INSTANCE_ID: config.instanceId,
        INSTANCE_NAME: config.instanceName,
        CLOUD_PROVIDER: config.provider,
        CLUSTER_ID: config.clusterId,
        CLUSTER_NAME: config.clusterName,
        K3S_TOKEN: config.k3sToken,
        K3S_URL: `https://${config.masterIp}:6443`,
        K3S_VERSION: config.k3sVersion || 'v1.35.4+k3s1',
        MASTER_IP: config.masterIp,
        FLUI_CA_PUBLIC_KEY: config.caPublicKey || '',
        // Flui shared storage (NFS+fscache, scaling doc §14)
        FLUI_SHARED_STORAGE_ENABLED: config.sharedStorage?.enabled
          ? 'true'
          : 'false',
        FLUI_SHARED_STORAGE_MASTER_IP:
          config.sharedStorage?.masterPrivateIp ?? '',
      });

      this.log(`Bootstrap script generated: ${script.length} bytes`, opId);

      // VALIDATION: Check script size is within limits
      const MAX_SIZE = 32000; // Hetzner limit: 32 KiB
      if (script.length > MAX_SIZE) {
        throw new Error(
          `Bootstrap script exceeds Hetzner limit: ${script.length} bytes > ${MAX_SIZE} bytes`,
        );
      }
      this.log(`✓ Script size OK: ${script.length} / ${MAX_SIZE} bytes`, opId);

      // Save debug copy
      await this.saveDebugScript(config.clusterId, 'worker.sh', script, opId);

      this.log(`✅ Bootstrap worker script generated successfully`, opId);
      this.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, opId);

      return script;
    } catch (error) {
      this.log(
        `Failed to generate worker script: ${error.message}`,
        opId,
        'ERROR',
      );
      this.logger.error(
        `Failed to generate worker script: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Generate bootstrap script that downloads and executes K3s init script from GitHub
   */
  private generateBootstrapScript(
    type: 'master' | 'worker',
    vars: Record<string, string>,
  ): string {
    const scriptName =
      type === 'master' ? 'k3s-master-init.sh' : 'k3s-worker-init.sh';

    // Export all variables
    const exports = Object.entries(vars)
      .map(([key, value]) => {
        // Escape single quotes in value
        const escapedValue = value.replaceAll("'", String.raw`'\''`);
        return `export ${key}='${escapedValue}'`;
      })
      .join('\n');

    return `#!/bin/bash
# Flui.cloud Bootstrap Script (${type})
# Downloads and executes ${scriptName} from GitHub
set -euo pipefail

# Configuration variables
${exports}

if [ -z "\${PRIVATE_IP:-}" ]; then
  PRIVATE_IP=$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -E '^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)' | head -1 || true)
fi
export PRIVATE_IP="\${PRIVATE_IP:-}"
export FLUI_BOOTSTRAP_NODE_PRIVATE_IP="\${PRIVATE_IP:-}"
echo "[Bootstrap] PRIVATE_IP=\${PRIVATE_IP:-(unresolved)}"

# Download and execute K3s initialization script
echo "[Bootstrap] Downloading ${scriptName} from \${SCRIPTS_BASE_URL}..."
if ! curl -fsSL "\${SCRIPTS_BASE_URL}/${scriptName}" -o /tmp/${scriptName}; then
    echo "[Bootstrap] ERROR: Failed to download ${scriptName}"
    exit 1
fi

chmod +x /tmp/${scriptName}
echo "[Bootstrap] Executing ${scriptName}..."
if ! /tmp/${scriptName}; then
    echo "[Bootstrap] ERROR: ${scriptName} execution failed"
    exit 1
fi

echo "[Bootstrap] ${scriptName} completed successfully"
`;
  }

  /**
   * Save script to debug directory for inspection
   */
  private async saveDebugScript(
    clusterId: string,
    filename: string,
    content: string,
    operationId?: string,
  ): Promise<void> {
    try {
      const debugDir = path.join(os.homedir(), '.flui', 'debug', clusterId);
      await fs.mkdir(debugDir, { recursive: true });

      const debugPath = path.join(debugDir, filename);
      await fs.writeFile(debugPath, content, 'utf8');

      this.log(`💾 Debug script saved: ${debugPath}`, operationId);
    } catch (error) {
      this.log(
        `Failed to save debug script: ${error.message}`,
        operationId,
        'WARN',
      );
      // Don't throw - this is just for debugging
    }
  }
}
