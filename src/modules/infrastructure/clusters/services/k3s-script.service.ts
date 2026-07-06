import { Injectable, Logger } from '@nestjs/common';

import { BOOTSTRAP_CONFIG } from 'src/config/bootstrap.config';
import { K3S_DEFAULT_VERSION } from '../constants';

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
  caPrivateKey?: string;
  // Observability stack configuration
  deployObservabilityStack?: boolean;
  // Auth mode configuration
  authMode?: string;
  jwtSecret?: string;
  // Observability stack passwords (optional for backward compatibility)
  postgresPassword?: string;
  redisPassword?: string;
  grafanaPassword?: string;
  // Multi-cluster observability
  controlClusterIp?: string;
  deployMonitoringAgent?: boolean;
  // Master node IP address for Prometheus configuration
  masterIp?: string;
  // Private IP on the environment VNet (used for K3s --node-ip / --advertise-address
  // and as the in-VNet endpoint other clusters reach the API on).
  privateIp?: string;
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
  // Bootstrap SSH public key for providers without SSH key registry (e.g. Scaleway)
  bootstrapPublicKey?: string;
  // Per-cluster nip.io hostname token. When set, system FQDNs become
  // auth/api/app.${token}.${masterIp}.nip.io — gives each cluster a unique
  // Let's Encrypt domain set so repeated test creations don't burn the
  // 5-certs-per-7-days rate limit on the same IP.
  nipHostnameToken?: string | null;
  /**
   * Flui shared storage configuration (NFS + fscache architecture).
   * When `enabled`, the master mounts a Flui-managed block storage Volume,
   * exports it via NFSv4, and reconfigures local-path-provisioner so all
   * catalog apps with `flui-shared` storage class write to it.
   *
   * `volumeDevicePath` is the Linux device path of the attached Volume
   * (e.g. /dev/disk/by-id/scsi-0HC_Volume_12345 for Hetzner). The
   * provider's createServer adapter computes this from the Volume id.
   *
   * Workers will mount NFS from `master.privateIp:/var/lib/flui/storage`.
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
  // Multi-cluster observability
  controlClusterIp?: string;
  // Private IP on the environment VNet for K3s --node-ip on the worker.
  privateIp?: string;
  // Bootstrap SSH public key for providers without SSH key registry (e.g. Scaleway)
  bootstrapPublicKey?: string;
  /**
   * Flui shared storage configuration. When `enabled`, the worker installs
   * cachefilesd and mounts the master's NFS export. Workers do not have a
   * dedicated Flui Volume — only the master does. See §14 of the scaling doc.
   */
  sharedStorage?: {
    enabled: boolean;
    masterPrivateIp?: string;
  };
}

@Injectable()
export class K3sScriptService {
  private readonly logger = new Logger(K3sScriptService.name);

  /**
   * Generate cloud-init script for K3s master node
   * Uses bootstrap approach: generates minimal script that downloads from GitHub
   */
  async generateMasterScript(config: K3sMasterConfig): Promise<string> {
    try {
      this.logger.log(
        `Generating bootstrap master script for cluster ${config.clusterName}`,
      );
      this.logger.debug(`Scripts URL: ${BOOTSTRAP_CONFIG.scriptsBaseUrl}`);

      if (config.deployObservabilityStack) {
        const missing: string[] = [];
        if (!config.jwtSecret) missing.push('jwtSecret');
        if (!config.postgresPassword) missing.push('postgresPassword');
        if (!config.redisPassword) missing.push('redisPassword');
        if (!config.grafanaPassword) missing.push('grafanaPassword');
        if (missing.length > 0) {
          throw new Error(
            `Cannot bootstrap control cluster ${config.clusterName}: missing required secrets [${missing.join(', ')}]. The caller must generate or provide them before invoking generateMasterScript.`,
          );
        }
      }

      // Log CA public key status
      if (config.caPublicKey) {
        const caPreview = config.caPublicKey.substring(0, 50) + '...';
        this.logger.log(
          `✅ CA public key will be included in cloud-init: ${caPreview}`,
        );
        this.logger.debug(
          `Full CA public key length: ${config.caPublicKey.length} chars`,
        );
      } else {
        this.logger.warn(
          '⚠️  CA public key is EMPTY - CA will NOT be installed on server!',
        );
      }

      // Log observability configuration
      this.logger.log(`📊 Observability Configuration:`);
      this.logger.log(
        `   - DEPLOY_OBSERVABILITY_STACK: ${config.deployObservabilityStack ? 'true' : 'false'}`,
      );
      this.logger.log(
        `   - OBSERVABILITY_CLUSTER_IP: ${config.controlClusterIp || '(empty - will use localhost)'}`,
      );
      this.logger.log(
        `   - DEPLOY_MONITORING_AGENT: ${config.deployMonitoringAgent ? 'true' : 'false'}`,
      );

      // Prometheus HTTP SD calls this endpoint to discover scrape targets.
      // Control cluster: Prometheus is in-cluster, use the K8s service URL directly.
      // Dev: fall back to WEBHOOK_BASE_URL (ngrok/tunnel).
      const rawFluiApiEndpoint = process.env.FLUI_API_ENDPOINT || '';
      const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(
        rawFluiApiEndpoint,
      );
      let fluiApiEndpoint: string;
      if (config.deployObservabilityStack) {
        fluiApiEndpoint = 'http://flui-api.flui-system.svc.cluster.local:3000';
      } else if (isLocalhost) {
        fluiApiEndpoint = process.env.WEBHOOK_BASE_URL || '';
      } else {
        fluiApiEndpoint =
          rawFluiApiEndpoint || process.env.WEBHOOK_BASE_URL || '';
      }
      if (config.deployObservabilityStack) {
        if (fluiApiEndpoint) {
          this.logger.log(`   - FLUI_API_ENDPOINT: ${fluiApiEndpoint}`);
        } else {
          this.logger.warn(
            `   ⚠️  control cluster but FLUI_API_ENDPOINT/WEBHOOK_BASE_URL is empty — Prometheus HTTP SD will fail to reach the API. Set one of these in the API environment.`,
          );
        }
        this.logger.log(
          `   ℹ️  This is an control cluster - will deploy Loki/Prometheus locally`,
        );
      } else if (config.controlClusterIp) {
        this.logger.log(
          `   ℹ️  This is a WORKLOAD cluster - will send logs to ${config.controlClusterIp}:30100`,
        );
      } else {
        this.logger.warn(
          `   ⚠️  This is a WORKLOAD cluster but NO control cluster IP provided - will use localhost (monitoring may not work)`,
        );
      }

      // Generate bootstrap script that downloads and executes k3s-master-init.sh from GitHub
      const script = this.generateBootstrapScript(
        'master',
        {
          SCRIPTS_BASE_URL: BOOTSTRAP_CONFIG.scriptsBaseUrl,
          MANIFESTS_BASE_URL: BOOTSTRAP_CONFIG.scriptsBaseUrl.replace(
            '/scripts',
            '/manifests',
          ),
          SERVER_ID: config.serverId || '', // Database node ID for observability
          INSTANCE_ID: config.instanceId,
          INSTANCE_NAME: config.instanceName,
          CLOUD_PROVIDER: config.provider,
          CLUSTER_ID: config.clusterId,
          CLUSTER_NAME: config.clusterName,
          K3S_TOKEN: config.k3sToken,
          K3S_VERSION: config.k3sVersion || K3S_DEFAULT_VERSION,
          DEPLOY_OBSERVABILITY_STACK: config.deployObservabilityStack
            ? 'true'
            : 'false',
          AUTH_MODE: config.authMode || 'local',
          JWT_SECRET: config.jwtSecret || '',
          POSTGRES_PASSWORD: config.postgresPassword ?? '',
          REDIS_PASSWORD: config.redisPassword ?? '',
          GRAFANA_PASSWORD: config.grafanaPassword ?? '',
          FLUI_CA_PUBLIC_KEY: config.caPublicKey || '',
          SSH_CA_PUBLIC_KEY: config.caPublicKey || '',
          SSH_CA_PRIVATE_KEY: config.caPrivateKey || '',
          // Multi-cluster observability
          OBSERVABILITY_CLUSTER_IP: config.controlClusterIp || '',
          DEPLOY_MONITORING_AGENT: config.deployMonitoringAgent
            ? 'true'
            : 'false',
          FLUI_API_ENDPOINT: fluiApiEndpoint,
          PRIVATE_IP: config.privateIp || '',
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
          // Flui shared storage (NFS+fscache architecture, see §14 of scaling doc)
          FLUI_SHARED_STORAGE_ENABLED: config.sharedStorage?.enabled
            ? 'true'
            : 'false',
          FLUI_SHARED_STORAGE_DEVICE:
            config.sharedStorage?.volumeDevicePath ?? '',
          FLUI_SHARED_STORAGE_VOLUME_GB: String(
            config.sharedStorage?.volumeSizeGb ?? 0,
          ),
        },
        config.bootstrapPublicKey,
      );

      this.logger.debug(`Bootstrap script generated: ${script.length} bytes`);

      // VALIDATION: Check script size is within limits
      const MAX_SIZE = 32000; // Hetzner limit: 32 KiB
      if (script.length > MAX_SIZE) {
        throw new Error(
          `Bootstrap script exceeds Hetzner limit: ${script.length} bytes > ${MAX_SIZE} bytes`,
        );
      }
      this.logger.debug(`Script size OK: ${script.length} / ${MAX_SIZE} bytes`);

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
    try {
      this.logger.log(
        `Generating bootstrap worker script for cluster ${config.clusterName}`,
      );
      this.logger.debug(`Scripts URL: ${BOOTSTRAP_CONFIG.scriptsBaseUrl}`);

      // Generate bootstrap script that downloads and executes k3s-worker-init.sh from GitHub
      const script = this.generateBootstrapScript(
        'worker',
        {
          SCRIPTS_BASE_URL: BOOTSTRAP_CONFIG.scriptsBaseUrl,
          SERVER_ID: config.serverId || '', // Database node ID for observability
          INSTANCE_ID: config.instanceId,
          INSTANCE_NAME: config.instanceName,
          CLOUD_PROVIDER: config.provider,
          CLUSTER_ID: config.clusterId,
          CLUSTER_NAME: config.clusterName,
          K3S_TOKEN: config.k3sToken,
          K3S_URL: `https://${config.masterIp}:6443`,
          K3S_VERSION: config.k3sVersion || K3S_DEFAULT_VERSION,
          MASTER_IP: config.masterIp,
          FLUI_CA_PUBLIC_KEY: config.caPublicKey || '',
          // Multi-cluster observability
          OBSERVABILITY_CLUSTER_IP: config.controlClusterIp || '',
          PRIVATE_IP: config.privateIp || '',
          // Flui shared storage (NFS+fscache, §14 of scaling doc)
          FLUI_SHARED_STORAGE_ENABLED: config.sharedStorage?.enabled
            ? 'true'
            : 'false',
          FLUI_SHARED_STORAGE_MASTER_IP:
            config.sharedStorage?.masterPrivateIp ?? '',
        },
        config.bootstrapPublicKey,
      );

      this.logger.debug(`Bootstrap script generated: ${script.length} bytes`);

      // VALIDATION: Check script size is within limits
      const MAX_SIZE = 32000; // Hetzner limit: 32 KiB
      if (script.length > MAX_SIZE) {
        throw new Error(
          `Bootstrap script exceeds Hetzner limit: ${script.length} bytes > ${MAX_SIZE} bytes`,
        );
      }
      this.logger.debug(`Script size OK: ${script.length} / ${MAX_SIZE} bytes`);

      return script;
    } catch (error) {
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
    bootstrapPublicKey?: string,
  ): string {
    const scriptName =
      type === 'master' ? 'k3s-master-init.sh' : 'k3s-worker-init.sh';

    // Log important observability variables
    if (vars.OBSERVABILITY_CLUSTER_IP) {
      this.logger.debug(
        `📝 Bootstrap script will export: OBSERVABILITY_CLUSTER_IP='${vars.OBSERVABILITY_CLUSTER_IP}'`,
      );
    } else {
      this.logger.debug(
        `📝 Bootstrap script will export: OBSERVABILITY_CLUSTER_IP='' (empty)`,
      );
    }

    this.logger.debug(
      `📝 Bootstrap script will export: DEPLOY_OBSERVABILITY_STACK='${vars.DEPLOY_OBSERVABILITY_STACK}'`,
    );

    // Export all variables. Coerce nullish to '' so a missing config field
    // doesn't blow up bootstrap script generation with a cryptic
    // "Cannot read properties of undefined (reading 'replaceAll')".
    const missingKeys: string[] = [];
    const exports = Object.entries(vars)
      .map(([key, value]) => {
        if (value === undefined || value === null) {
          missingKeys.push(key);
        }
        const safe = value == null ? '' : String(value);
        const escapedValue = safe.replaceAll("'", String.raw`'\''`);
        return `export ${key}='${escapedValue}'`;
      })
      .join('\n');
    if (missingKeys.length > 0) {
      this.logger.warn(
        `Bootstrap script vars were undefined/null: ${missingKeys.join(', ')} — exporting empty strings`,
      );
    }

    // Bootstrap SSH key injection. Appended to authorized_keys for every provider
    // so SSH access never depends solely on a provider key registry attaching it
    // at boot (append, so it never clobbers a registry-injected key).
    const escapedBootstrapKey = bootstrapPublicKey
      ? bootstrapPublicKey.replaceAll("'", String.raw`'\''`)
      : '';
    const sshKeyBlock = bootstrapPublicKey
      ? `
mkdir -p /root/.ssh
chmod 700 /root/.ssh
echo '${escapedBootstrapKey}' >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
`
      : '';

    return `#!/bin/bash
# Flui.cloud Bootstrap Script (${type})
# Downloads and executes ${scriptName} from GitHub
set -euo pipefail
${sshKeyBlock}
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
}
