import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from '../entities/cluster.entity';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import { WireGuardPeerService } from '../../networking/services/wireguard-peer.service';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { dump as dumpYaml } from 'js-yaml';
import { deriveHostTargets } from '../../../providers/core/host/host-targets';

const VECTOR_CONFIG = '/etc/vector/vector.toml';
const OK = 'FLUI_TELEMETRY_OK';
const UPDATED = 'FLUI_TELEMETRY_UPDATED';
const ABSENT = 'FLUI_TELEMETRY_ABSENT';
const ROLLED_BACK = 'FLUI_TELEMETRY_ROLLBACK';
const DEFAULT_LOKI_NODEPORT = 30100;
const DEFAULT_METRICS_NODEPORT = 30428;
const METRICS_NAMESPACE = 'flui-monitoring';
const METRICS_DEPLOYMENT = 'vmagent';
/** vmagent's own flag. Matched on the flag, not on the old address, because the
 *  address is exactly what is unknown when a node was configured by someone else. */
const REMOTE_WRITE_FLAG = '-remoteWrite.url=';

/**
 * Rewrites vmagent's push target in its container arguments.
 *
 * Exported and pure so the rewriting can be tested without a cluster — the part
 * that is easy to get subtly wrong is the string surgery, not the API call.
 */
export function rewriteRemoteWriteArgs(
  args: string[],
  endpoint: string,
): { args: string[]; changed: boolean } {
  let changed = false;
  const next = args.map((arg) => {
    if (!arg.startsWith(REMOTE_WRITE_FLAG)) return arg;
    const current = arg.slice(REMOTE_WRITE_FLAG.length);
    // Keep whatever path the flag carried: vmagent wants /api/v1/write, and a
    // rewrite that dropped it would point at a URL that answers 404 forever.
    let path = '';
    try {
      path = new URL(current).pathname;
    } catch {
      path = '/api/v1/write';
    }
    const rewritten = `${REMOTE_WRITE_FLAG}http://${endpoint}${path}`;
    if (rewritten !== arg) changed = true;
    return rewritten;
  });
  return { args: next, changed };
}

export interface TelemetryReconcileResult {
  endpoint?: string;
  updated: number;
  unchanged: number;
  absent: number;
}

/**
 * Points a cluster's nodes at the right telemetry ingest address, after boot.
 *
 * `OBSERVABILITY_CLUSTER_IP` is injected once into cloud-init and never
 * revisited, so a node told the wrong address ships into the void for its
 * whole life. There is no agent on the node: the change is an idempotent
 * script over the same short SSH session the host firewall already uses.
 */
@Injectable()
export class TelemetryEndpointReconciler {
  private readonly logger = new Logger(TelemetryEndpointReconciler.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly managementAddress: ManagementAddressResolver,
    private readonly hostCommand: HostCommandService,
    private readonly wgPeers: WireGuardPeerService,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Where this cluster's nodes should push. A control cluster ingests its own
   * telemetry locally, so it resolves to its own master.
   */
  async desiredEndpoint(
    cluster: ClusterEntity,
    portOverride?: number,
  ): Promise<string | undefined> {
    const port = portOverride ?? this.ingestPort();
    if (isControlClusterType(cluster.clusterType)) {
      const own = cluster.masterPrivateIp ?? cluster.masterIpAddress;
      return own ? `${own}:${port}` : undefined;
    }
    const control = await this.resolveControl();
    if (!control) return undefined;
    // The overlay is offered, not imposed: the resolver keeps a shared private
    // network in preference to it, and ignores it entirely until a peer of this
    // cluster has actually handshaken.
    const overlay = await this.wgPeers.overlayFor(cluster.id);
    const endpoint = this.managementAddress.controlEndpointFor(
      cluster,
      control,
      overlay,
    );
    if (!endpoint) return undefined;
    this.logger.log(
      `[telemetry] ${cluster.name} → ${endpoint.address}:${port} ` +
        `(${endpoint.path}: ${endpoint.reason})`,
    );
    return `${endpoint.address}:${port}`;
  }

  async reconcile(clusterId: string): Promise<TelemetryReconcileResult> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);

    const endpoint = await this.desiredEndpoint(cluster);
    if (!endpoint) {
      this.logger.warn(
        `[telemetry] no ingest address resolvable for ${cluster.name} — leaving nodes as they are`,
      );
      return { updated: 0, unchanged: 0, absent: 0 };
    }

    const script = this.buildScript(endpoint);
    const result: TelemetryReconcileResult = {
      endpoint,
      updated: 0,
      unchanged: 0,
      absent: 0,
    };

    for (const target of deriveHostTargets(cluster)) {
      const out = await this.hostCommand.apply(target, script, OK);
      if (out.includes(ABSENT)) result.absent += 1;
      else if (out.includes(UPDATED)) result.updated += 1;
      else result.unchanged += 1;
    }

    this.logger.log(
      `[telemetry] ${cluster.name}: ${result.updated} updated, ` +
        `${result.unchanged} already correct, ${result.absent} without Vector`,
    );
    return result;
  }

  /**
   * Rewrites both Loki sinks and restarts Vector, rolling the file back if the
   * restart fails.
   *
   * The rollback is what makes this safe to run unattended: a bad endpoint that
   * stops Vector from starting would otherwise cost the node's logs *and* the
   * ability to see why. Validation via `vector validate` is deliberately not
   * used — its flags vary by version, and a wrong guess would either block
   * every reconcile or wave through a broken config.
   */
  private buildScript(endpoint: string): string {
    const want = `http://${endpoint}`;
    return [
      'set -e',
      `CFG=${VECTOR_CONFIG}`,
      `if [ ! -f "$CFG" ]; then echo ${ABSENT}; echo ${OK}; exit 0; fi`,
      `WANT='endpoint = "${want}"'`,
      'TOTAL=$(grep -c \'^endpoint = "http://\' "$CFG" || true)',
      'MATCH=$(grep -cF "$WANT" "$CFG" || true)',
      `if [ "$TOTAL" = "0" ]; then echo ${ABSENT}; echo ${OK}; exit 0; fi`,
      `if [ "$TOTAL" = "$MATCH" ]; then echo ${OK}; exit 0; fi`,
      'cp "$CFG" "$CFG.flui-bak"',
      `sed -i 's|^endpoint = "http://.*"|endpoint = "${want}"|' "$CFG"`,
      'if ! systemctl restart vector; then',
      '  mv "$CFG.flui-bak" "$CFG"',
      '  systemctl restart vector || true',
      `  echo ${ROLLED_BACK}; exit 4`,
      'fi',
      'rm -f "$CFG.flui-bak"',
      `echo ${UPDATED}`,
      `echo ${OK}`,
    ].join('\n');
  }

  /**
   * Moves the metrics agent's push target, which does not live on the host.
   *
   * Logs are a line in `/etc/vector/vector.toml`; metrics are a flag on a
   * Kubernetes Deployment, so no file on any node mentions them.
   */
  async reconcileMetrics(clusterId: string): Promise<{
    endpoint?: string;
    changed: boolean;
    reason?: string;
  }> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);

    const endpoint = await this.desiredEndpoint(cluster, this.metricsPort());
    if (!endpoint) return { changed: false, reason: 'no ingest address' };

    if (!cluster.kubeconfigEncrypted) {
      return { endpoint, changed: false, reason: 'no kubeconfig stored' };
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

    const deployment = await this.kubernetes.getResource(
      kubeconfig,
      'Deployment',
      METRICS_DEPLOYMENT,
      METRICS_NAMESPACE,
    );
    const container = deployment?.spec?.template?.spec?.containers?.[0];
    if (!container) {
      return { endpoint, changed: false, reason: 'vmagent not deployed here' };
    }

    const { args, changed } = rewriteRemoteWriteArgs(
      container.args ?? [],
      endpoint,
    );
    if (!changed)
      return { endpoint, changed: false, reason: 'already correct' };

    container.args = args;
    await this.kubernetes.replaceManifest(kubeconfig, dumpYaml(deployment));
    this.logger.log(`[telemetry] ${cluster.name} metrics → ${endpoint}`);
    return { endpoint, changed: true };
  }

  private metricsPort(): number {
    const raw = Number(process.env.FLUI_METRICS_NODEPORT);
    return Number.isInteger(raw) && raw >= 30000 && raw <= 32767
      ? raw
      : DEFAULT_METRICS_NODEPORT;
  }

  private async resolveControl(): Promise<ClusterEntity | null> {
    const candidates = await this.clusterRepository.find({
      where: {
        clusterType: In([ClusterType.CONTROL, ClusterType.OBSERVABILITY]),
      },
      order: { createdAt: 'DESC' },
    });
    return candidates.find((c) => c.status !== ClusterStatus.DELETED) ?? null;
  }

  private ingestPort(): number {
    const raw = Number(process.env.FLUI_LOKI_NODEPORT);
    return Number.isInteger(raw) && raw >= 30000 && raw <= 32767
      ? raw
      : DEFAULT_LOKI_NODEPORT;
  }
}
