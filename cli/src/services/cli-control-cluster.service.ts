import { Injectable, Logger } from '@nestjs/common';
import {
  ClusterEntity,
  ClusterStatus,
} from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { CloudProvider } from 'src/modules/providers/enums/cloud-provider.enum';
import { CliClusterRepository } from '../lib/repositories/cli-cluster.repository';
import {
  RELEASE,
  resolveBootstrapRef,
  resolveImageTags,
} from '../config/release.config';
import { buildNipBaseDomain } from '../lib/nip-base-domain.util';
import { CliNodeRepository } from '../lib/repositories/cli-node.repository';
import { CliClustersService } from './cli-clusters.service';
import { CliOperationRepository } from '../lib/repositories/cli-operation.repository';
import { CliSshService } from './cli-ssh.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from 'src/modules/infrastructure/servers/entities/infrastructure-operations.entity';
import * as net from 'node:net';
import * as https from 'node:https';
import { TLSSocket } from 'node:tls';

/**
 * CLI Control Cluster Service
 *
 * Simplified version of ObservabilityClusterService for CLI usage.
 * Uses file-based repositories instead of TypeORM.
 */
@Injectable()
export class CliControlClusterService {
  private readonly logger = new Logger(CliControlClusterService.name);

  constructor(
    private readonly clusterRepository: CliClusterRepository,
    private readonly nodeRepository: CliNodeRepository,
    private readonly clustersService: CliClustersService,
    private readonly operationRepository: CliOperationRepository,
    private readonly sshService: CliSshService,
  ) {}

  /**
   * Get the control cluster
   */
  async getControlCluster(): Promise<ClusterEntity | null> {
    const cluster = await this.clusterRepository.findOne({
      where: {
        metadata: { isObservabilityCluster: true },
      },
    });

    if (!cluster) {
      return null;
    }

    // Manually load nodes from separate repository
    const nodes = await this.nodeRepository.find({
      where: { clusterId: cluster.id },
    });

    cluster.nodes = nodes;
    return cluster;
  }

  /**
   * Check if control cluster exists
   */
  async hasControlCluster(): Promise<boolean> {
    const cluster = await this.getControlCluster();
    return cluster !== null;
  }

  /**
   * Get observability service endpoints
   */
  async getObservabilityEndpoints(clusterId: string): Promise<{
    prometheus?: string;
    grafana?: string;
    loki?: string;
    postgres?: string;
    redis?: string;
    fluiApi?: string;
    fluiWeb?: string;
  }> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });

    if (!cluster?.masterIpAddress) {
      return {};
    }

    const ip = cluster.masterIpAddress;
    const baseDomain = buildNipBaseDomain(ip, cluster.nipHostnameToken);
    return {
      prometheus: `cluster-internal (kubectl port-forward -n flui-system svc/prometheus 9090)`,
      grafana: `cluster-internal (kubectl port-forward -n flui-system svc/grafana 3000)`,
      loki: `cluster-internal (kubectl port-forward -n flui-system svc/loki 3100)`,
      postgres: `cluster-internal (kubectl port-forward -n flui-system svc/postgres 5432)`,
      redis: `cluster-internal (kubectl port-forward -n flui-system svc/redis 6379)`,
      fluiApi: `https://api.${baseDomain}`,
      fluiWeb: `https://app.${baseDomain}`,
    };
  }

  /**
   * Create control cluster
   */
  async createControlCluster(
    provider: string,
    region: string,
    nodeSize: string,
    workerCount: number = 0,
    firewallId?: string,
    sourceCidrs?: string[],
    authMode: string = 'local',
    envVnet?: {
      vnetProviderResourceId: string;
      vnetIpRange: string;
      subnetProviderResourceId: string;
      subnetIpRange: string;
      subnetType: string;
      networkZone: string;
    },
    adminEmail?: string,
    acmeStaging?: boolean,
    diskSizeGb?: number,
    options?: {
      sharedStorageEnabled?: boolean;
      sharedStorageVolumeSizeGb?: number;
      useLatest?: boolean;
    },
  ): Promise<string> {
    // Pin the install to the CLI release (bootstrap ref + image tags), unless
    // --latest opted into mobile dev tags. Recorded on the cluster so the
    // installed version stays queryable after creation.
    const useLatest = options?.useLatest ?? false;
    const createDto = {
      name: 'control-cluster',
      provider: provider as CloudProvider,
      region,
      nodeSize,
      workerCount,
      image: 'ubuntu-24.04',
      diskSizeGb,
      sharedStorageEnabled: options?.sharedStorageEnabled,
      sharedStorageVolumeSizeGb: options?.sharedStorageVolumeSizeGb,
      metadata: {
        isObservabilityCluster: true,
        firewallId,
        sourceCidrs,
        authMode,
        envVnet,
        adminEmail,
        acmeStaging,
        useLatest,
        platformVersion: useLatest ? null : RELEASE.version,
        componentVersions: resolveImageTags(useLatest),
        bootstrapRef: resolveBootstrapRef(useLatest),
      },
    };

    const { cluster } = await this.clustersService.create(createDto);
    return cluster.id;
  }

  /**
   * Deploy observability stack (Prometheus, Grafana, Loki)
   */
  async deployObservabilityStack(clusterId: string): Promise<void> {
    // TODO: Implement observability stack deployment
    this.logger.warn(
      'Observability stack deployment not implemented in CLI mode',
    );
  }

  /**
   * Delete control cluster
   */
  async deleteControlCluster(): Promise<void> {
    // Local clusters.json can accumulate stale observability entries (e.g. a
    // previous destroy died mid-way, or a create crashed after persisting).
    // findOne would only catch one — so we iterate and purge all matches.
    const clusters = await this.clusterRepository.find({
      where: { metadata: { isObservabilityCluster: true } },
    });

    if (clusters.length === 0) {
      throw new Error('No control cluster found');
    }

    if (clusters.length > 1) {
      this.logger.warn(
        `Found ${clusters.length} control cluster records — removing all to clear stale state`,
      );
    }

    let lastError: unknown = null;
    for (const cluster of clusters) {
      try {
        await this.clustersService.remove(cluster.id);
      } catch (error) {
        lastError = error;
        this.logger.error(
          `Failed to remove cluster ${cluster.id} (${cluster.name}): ${(error as Error).message}`,
        );
      }
    }

    if (lastError) throw lastError;
  }

  /**
   * Get cluster operation by cluster ID
   */
  async getClusterOperation(
    clusterId: string,
  ): Promise<InfrastructureOperationEntity | null> {
    return this.operationRepository.findOne({
      where: {
        resourceId: clusterId,
        resourceType: 'cluster',
      },
      order: {
        createdAt: 'DESC',
      },
    });
  }

  /**
   * Wait for cluster to be ready by polling operation status
   * @param clusterId Cluster ID to wait for
   * @param timeoutMs Timeout in milliseconds (default: 10 minutes)
   * @param pollIntervalMs Polling interval in milliseconds (default: 10 seconds)
   * @returns Promise that resolves when cluster is ready
   * @throws Error if timeout is reached or operation fails
   */
  async waitForClusterReady(
    clusterId: string,
    timeoutMs: number = 600000,
    pollIntervalMs: number = 10000,
  ): Promise<void> {
    const startTime = Date.now();
    const maxAttempts = Math.ceil(timeoutMs / pollIntervalMs);

    this.logger.log(
      `Waiting for cluster ${clusterId} to be ready (timeout: ${timeoutMs}ms, poll interval: ${pollIntervalMs}ms)`,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const operation = await this.getClusterOperation(clusterId);

      if (!operation) {
        throw new Error(
          `No operation found for cluster ${clusterId}. Cluster may not exist.`,
        );
      }

      this.logger.debug(
        `Poll attempt ${attempt}/${maxAttempts}: Operation status = ${operation.status}, progress = ${operation.progress}%`,
      );

      // Check if operation completed successfully
      if (operation.status === OperationStatus.COMPLETED) {
        this.logger.log(
          `Cluster ${clusterId} is ready (took ${Date.now() - startTime}ms)`,
        );
        return;
      }

      // Check if operation failed
      if (operation.status === OperationStatus.FAILED) {
        const errorMsg =
          operation.metadata?.error || 'Unknown error during cluster creation';
        throw new Error(`Cluster creation failed: ${errorMsg}`);
      }

      // Check timeout
      if (Date.now() - startTime >= timeoutMs) {
        throw new Error(
          `Timeout waiting for cluster ${clusterId} to be ready after ${timeoutMs}ms. Current status: ${operation.status}, progress: ${operation.progress}%`,
        );
      }

      // Wait before next poll (unless it's the last attempt)
      if (attempt < maxAttempts) {
        await this.sleep(pollIntervalMs);
      }
    }

    throw new Error(
      `Failed to confirm cluster readiness after ${maxAttempts} attempts`,
    );
  }

  /**
   * Wait for master node IP address to become available
   * Polls the cluster repository until masterIpAddress is populated
   */
  async waitForMasterIp(
    clusterId: string,
    timeoutMs: number = 600000,
    pollIntervalMs: number = 5000,
  ): Promise<string> {
    const startTime = Date.now();

    this.logger.log(
      `Waiting for master IP of cluster ${clusterId} (timeout: ${timeoutMs}ms)`,
    );

    while (Date.now() - startTime < timeoutMs) {
      const cluster = await this.clusterRepository.findOne({
        where: { id: clusterId },
      });

      if (!cluster) {
        throw new Error(
          `Cluster ${clusterId} not found. It may have been deleted.`,
        );
      }

      if (cluster.status === ClusterStatus.ERROR) {
        throw new Error(
          'Cluster creation failed before master IP was assigned.',
        );
      }

      if (cluster.masterIpAddress) {
        this.logger.log(`Master IP available: ${cluster.masterIpAddress}`);
        return cluster.masterIpAddress;
      }

      await this.sleep(pollIntervalMs);
    }

    throw new Error(
      `Timeout waiting for master IP address after ${timeoutMs}ms`,
    );
  }

  /**
   * Wait for TCP port to become reachable on a host
   */
  async waitForPortReady(
    host: string,
    port: number = 22,
    timeoutMs: number = 600000,
    pollIntervalMs: number = 5000,
  ): Promise<void> {
    const startTime = Date.now();

    this.logger.log(
      `Waiting for port ${port} on ${host} (timeout: ${timeoutMs}ms)`,
    );

    while (Date.now() - startTime < timeoutMs) {
      const isReachable = await this.checkTcpPort(host, port);
      if (isReachable) {
        this.logger.log(`Port ${port} is reachable on ${host}`);
        return;
      }
      await this.sleep(pollIntervalMs);
    }

    throw new Error(
      `Timeout waiting for port ${port} on ${host} after ${timeoutMs}ms`,
    );
  }

  /**
   * Wait for SSH to be fully ready (CA enrolled + cert auth working)
   * Attempts an actual SSH command with retry until it succeeds.
   * This is needed because TCP port 22 can be open before cloud-init
   * has finished configuring the CA for certificate authentication.
   *
   * @param sshTestFn Function that attempts an SSH command and throws on failure
   */
  async waitForSshAuth(
    sshTestFn: () => Promise<void>,
    timeoutMs: number = 600000,
    pollIntervalMs: number = 10000,
  ): Promise<void> {
    const startTime = Date.now();

    this.logger.log(
      `Waiting for SSH authentication to be ready (timeout: ${timeoutMs}ms)`,
    );

    let lastError: Error | undefined;
    while (Date.now() - startTime < timeoutMs) {
      try {
        await sshTestFn();
        this.logger.log('SSH authentication is ready');
        return;
      } catch (error) {
        lastError = error;
      }
      await this.sleep(pollIntervalMs);
    }

    if (lastError) {
      this.logger.error(`SSH exec failed: ${lastError.message}`);
    }
    throw new Error(
      `Timeout waiting for SSH authentication after ${timeoutMs}ms`,
    );
  }

  /**
   * Poll operation status in background and call onReady when COMPLETED.
   * Returns a stop function and a done promise that resolves when the
   * poller finishes (after onReady/onFailed callback completes or stop() is called).
   */
  pollOperationUntilReady(
    clusterId: string,
    onReady: () => Promise<void>,
    onFailed?: (error: string) => void,
    pollIntervalMs: number = 10000,
  ): { stop: () => void; done: Promise<void> } {
    let stopped = false;

    const poll = async (): Promise<void> => {
      while (!stopped) {
        try {
          const operation = await this.getClusterOperation(clusterId);

          if (!operation) {
            this.logger.warn(
              `No operation found for cluster ${clusterId} during background poll`,
            );
            await this.sleep(pollIntervalMs);
            continue;
          }

          if (operation.status === OperationStatus.COMPLETED) {
            this.logger.log(`Background poll: cluster ${clusterId} is READY`);
            if (!stopped) {
              await onReady();
            }
            return;
          }

          if (operation.status === OperationStatus.FAILED) {
            const errorMsg =
              operation.metadata?.error ||
              'Unknown error during cluster creation';
            this.logger.error(
              `Background poll: cluster creation failed: ${errorMsg}`,
            );
            if (onFailed && !stopped) {
              onFailed(errorMsg);
            }
            return;
          }
        } catch (error) {
          this.logger.debug(`Background poll error: ${error.message}`);
        }

        await this.sleep(pollIntervalMs);
      }
    };

    const done = poll().catch((error) => {
      this.logger.error(`Background poller crashed: ${error.message}`);
    });

    return {
      stop: () => {
        stopped = true;
      },
      done,
    };
  }

  /**
   * Check observability services health via HTTP endpoints
   * @param masterIp Master node IP address
   * @returns Object with service health status
   */
  async checkObservabilityServices(
    masterIp: string,
    _nipHostnameToken?: string | null,
  ): Promise<{
    prometheus: 'healthy' | 'unreachable';
    grafana: 'healthy' | 'unreachable';
    loki: 'healthy' | 'unreachable';
    postgres: 'healthy' | 'unreachable';
    redis: 'healthy' | 'unreachable';
    fluiApi: 'healthy' | 'unreachable';
    fluiWeb: 'healthy' | 'unreachable';
  }> {
    // With the closed-firewall policy, services aren't reachable publicly and
    // the master node host can't resolve cluster DNS. Health = workload
    // readiness, queried with one combined kubectl call (sshExec is blocking,
    // Promise.all wouldn't actually parallelize separate ssh invocations).
    type Lookup = { ns: string; name: string; key: keyof Result };
    type Result = {
      prometheus: 'healthy' | 'unreachable';
      grafana: 'healthy' | 'unreachable';
      loki: 'healthy' | 'unreachable';
      postgres: 'healthy' | 'unreachable';
      redis: 'healthy' | 'unreachable';
      fluiApi: 'healthy' | 'unreachable';
      fluiWeb: 'healthy' | 'unreachable';
    };

    // Match by (unique) workload name only — the observability stack lives in
    // `flui-control` on new installs and `flui-observability` on legacy ones.
    const lookups: Lookup[] = [
      { ns: 'control', name: 'vmsingle', key: 'prometheus' },
      { ns: 'control', name: 'grafana', key: 'grafana' },
      { ns: 'control', name: 'loki', key: 'loki' },
      { ns: 'flui-system', name: 'postgres', key: 'postgres' },
      { ns: 'flui-system', name: 'redis', key: 'redis' },
      { ns: 'flui-system', name: 'flui-api', key: 'fluiApi' },
      { ns: 'flui-system', name: 'flui-web', key: 'fluiWeb' },
    ];

    const result: Result = {
      prometheus: 'unreachable',
      grafana: 'unreachable',
      loki: 'unreachable',
      postgres: 'unreachable',
      redis: 'unreachable',
      fluiApi: 'unreachable',
      fluiWeb: 'unreachable',
    };

    interface WorkloadItem {
      kind?: string;
      metadata?: { name?: string; namespace?: string };
      status?: { readyReplicas?: number; replicas?: number };
    }

    try {
      const combined =
        `(kubectl -n flui-control get deploy,statefulset -o json 2>/dev/null || echo '{"items":[]}') ; ` +
        `echo '---FLUI-SEP---' ; ` +
        `(kubectl -n flui-observability get deploy,statefulset -o json 2>/dev/null || echo '{"items":[]}') ; ` +
        `echo '---FLUI-SEP---' ; ` +
        `(kubectl -n flui-system get deploy,statefulset -o json 2>/dev/null || echo '{"items":[]}')`;
      const raw = await this.sshService.sshExec(masterIp, combined);
      const [controlRaw, legacyRaw, sysRaw] = raw.split('---FLUI-SEP---');

      const collect = (json: string): WorkloadItem[] => {
        try {
          const parsed = JSON.parse(json) as { items?: WorkloadItem[] };
          return parsed.items ?? [];
        } catch {
          return [];
        }
      };
      const items = [
        ...collect(controlRaw || ''),
        ...collect(legacyRaw || ''),
        ...collect(sysRaw || ''),
      ];

      for (const lookup of lookups) {
        const item = items.find((i) =>
          lookup.ns === 'control'
            ? i.metadata?.name === lookup.name
            : i.metadata?.name === lookup.name &&
              i.metadata?.namespace === lookup.ns,
        );
        const replicas = item?.status?.replicas ?? 0;
        const ready = item?.status?.readyReplicas ?? 0;
        result[lookup.key] =
          replicas > 0 && ready === replicas ? 'healthy' : 'unreachable';
      }
    } catch {
      // On SSH failure, leave defaults (all unreachable).
    }

    return result;
  }

  /**
   * Check if a TCP port is reachable on a host
   */
  private checkTcpPort(
    host: string,
    port: number,
    timeout: number = 5000,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();

      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeout);

      socket.on('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });

      socket.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitForValidTls(
    url: string,
    timeoutMs = 300_000,
    intervalMs = 15_000,
    acmeStaging = false,
  ): Promise<boolean> {
    // Production: rely on Node's default chain validation (LE prod root is in the OS trust store).
    // Staging: chain is signed by LE staging fake CA (not in OS trust store), so we connect with
    // rejectUnauthorized=false but then inspect the served cert issuer to ensure it's a real LE
    // cert and not Traefik's self-signed default.
    const agent = acmeStaging
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const valid = await new Promise<boolean>((resolve) => {
        const req = https.request(url, { method: 'HEAD', agent }, (res) => {
          if (!acmeStaging) {
            resolve(true);
            return;
          }
          const cert = (res.socket as TLSSocket).getPeerCertificate?.();
          const issuerO = cert?.issuer?.O ?? '';
          resolve(issuerO.includes("Let's Encrypt"));
        });
        req.on('error', () => resolve(false));
        req.setTimeout(10_000, () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
      if (valid) return true;
      await this.sleep(intervalMs);
    }
    return false;
  }

  async waitForOidcReady(
    apiBaseUrl: string,
    timeoutMs = 300_000,
    intervalMs = 10_000,
    acmeStaging = false,
  ): Promise<boolean> {
    const url = `${apiBaseUrl.replace(/\/$/, '')}/api/v1/health/oidc`;
    const agent = acmeStaging
      ? new https.Agent({ rejectUnauthorized: false })
      : undefined;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await new Promise<boolean>((resolve) => {
        const req = https.get(url, { timeout: 10_000, agent }, (res) => {
          if (acmeStaging) {
            const cert = (res.socket as TLSSocket).getPeerCertificate?.();
            const issuerO = cert?.issuer?.O ?? '';
            if (!issuerO.includes("Let's Encrypt")) {
              res.resume();
              resolve(false);
              return;
            }
          }
          if (res.statusCode !== 200) {
            res.resume();
            resolve(false);
            return;
          }
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            try {
              resolve(!!JSON.parse(body).ready);
            } catch {
              resolve(false);
            }
          });
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ready) return true;
      await this.sleep(intervalMs);
    }
    return false;
  }
}
