import { Injectable, Logger } from '@nestjs/common';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import { ClusterFirewallEntity } from '../entities/cluster-firewall.entity';
import { FirewallDesiredStateService } from './firewall-desired-state.service';
import { FirewallReconciliationService } from './firewall-reconciliation.service';

/** Marks the dynamic, cluster-topology-derived rules this service owns. */
const PEER_RULE_PREFIX = 'flui:xprovider:';
const API_SERVER_PORT = '6443';
/** Loki NodePort is confirmed 30100; the metrics remote_write NodePort is
 *  declared in the external bootstrap-scripts repo — append it via env once
 *  known (e.g. FLUI_OBS_INGEST_NODEPORTS="30100,30428"). */
const DEFAULT_OBS_INGEST_NODEPORTS = '30100';
const NODEPORT_MIN = 30000;
const NODEPORT_MAX = 32767;

/**
 * Same-provider clusters talk to the master over the shared VNet (subnet CIDR
 * rules the templates already carry). A workload on a *different* provider than
 * the master cannot — its traffic must cross the public interface. This service
 * derives, from live cluster state, the extra allow-rules that open exactly
 * those cross-provider channels, recomputed every reconcile because node public
 * IPs change on rescale/recreation.
 *
 * Two channels, deliberately treated differently by blast radius:
 *   - API server (6443): opened on a cross-provider workload to the master's
 *     public IP. Safe by default — K3s 6443 is native client-cert mTLS, so the
 *     open port grants no access without the cert.
 *   - Observability ingest (Loki/metrics NodePorts): the master's ingest is
 *     UNAUTHENTICATED plaintext today (auth lives in the external
 *     bootstrap-scripts repo and is not yet on the push path). Opening it
 *     publicly would make a source-IP allow-list the only control in front of a
 *     public write endpoint into the control plane's telemetry. So it is
 *     OFF by default and gated behind FLUI_OBS_INGEST_ENABLE_PUBLIC=true, which
 *     an operator should set only once the ingest path is token+TLS gated.
 *
 * Deployments with no cross-provider pair get nothing — a no-op for the common
 * same-provider case.
 */
@Injectable()
export class CrossProviderFirewallService {
  private readonly logger = new Logger(CrossProviderFirewallService.name);

  constructor(
    private readonly desiredState: FirewallDesiredStateService,
    private readonly reconciliation: FirewallReconciliationService,
  ) {}

  async reconcileAllPeers(): Promise<void> {
    const firewalls = await this.desiredState.listFirewalls();
    const clusters = firewalls
      .map((f) => f.cluster)
      .filter((c): c is ClusterEntity => !!c);

    const control = this.pickControlCluster(clusters);
    if (!control) {
      this.logger.debug('[fw-xprovider] no control cluster — nothing to do');
      return;
    }

    const crossWorkloadNodeIps = this.collectCrossWorkloadNodeIps(
      clusters,
      control,
    );

    if (crossWorkloadNodeIps.length > 0 && this.publicObsIngestEnabled()) {
      this.logger.warn(
        '[fw-xprovider] FLUI_OBS_INGEST_ENABLE_PUBLIC is on — the control obs ingest ' +
          'ports will be opened to workload node IPs. Ensure Loki/vmsingle require a ' +
          'token over TLS; the source-IP allow-list is not sufficient alone.',
      );
    }

    for (const fw of firewalls) {
      if (!fw.cluster || fw.cluster.status === ClusterStatus.DELETED) continue;
      try {
        await this.reconcileFirewallPeers(fw, control, crossWorkloadNodeIps);
      } catch (err: any) {
        this.logger.error(
          `[fw-xprovider] firewall ${fw.id} (cluster ${fw.cluster?.id}) failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  /** Match getControlCluster()'s resolution: prefer a real CONTROL over a legacy
   *  OBSERVABILITY row, then the most recently created, so the firewall and the
   *  observability wiring never disagree on which master is the target. */
  private pickControlCluster(
    clusters: ClusterEntity[],
  ): ClusterEntity | undefined {
    const candidates = clusters.filter(
      (c) =>
        isControlClusterType(c.clusterType) &&
        c.status !== ClusterStatus.DELETED,
    );
    if (candidates.length <= 1) return candidates[0];
    const rank = (c: ClusterEntity) =>
      c.clusterType === ClusterType.CONTROL ? 0 : 1;
    return [...candidates].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0);
    })[0];
  }

  private collectCrossWorkloadNodeIps(
    clusters: ClusterEntity[],
    control: ClusterEntity,
  ): string[] {
    const ips = clusters
      .filter(
        (c) =>
          !isControlClusterType(c.clusterType) &&
          c.status === ClusterStatus.READY &&
          c.provider !== control.provider,
      )
      .flatMap((c) => (c.nodes ?? []).map((n) => n.ipAddress))
      .filter((ip): ip is string => !!ip);
    return [...new Set(ips)];
  }

  private async reconcileFirewallPeers(
    fw: ClusterFirewallEntity,
    control: ClusterEntity,
    crossWorkloadNodeIps: string[],
  ): Promise<void> {
    const cluster = fw.cluster;
    const peerRules = this.computePeerRules(
      cluster,
      control,
      crossWorkloadNodeIps,
    );
    const baseRules = (fw.desiredRules ?? []).filter(
      (r) => !this.isPeerRule(r),
    );
    const merged = [...baseRules, ...peerRules];
    // updateAndApplyRules is a no-op when the canonical hash is unchanged, so
    // this only touches the provider when a peer IP actually moved.
    await this.reconciliation.updateAndApplyRules(fw.id, merged);
  }

  private computePeerRules(
    cluster: ClusterEntity,
    control: ClusterEntity,
    crossWorkloadNodeIps: string[],
  ): FirewallRuleDto[] {
    if (isControlClusterType(cluster.clusterType)) {
      // Unauthenticated ingest stays vnet-only unless explicitly opted in.
      if (!this.publicObsIngestEnabled()) return [];
      if (crossWorkloadNodeIps.length === 0) return [];
      const ports = this.obsIngestNodePorts();
      if (ports.length === 0) return [];
      const sourceIps = crossWorkloadNodeIps.map((ip) => `${ip}/32`);
      return ports.map((port) => ({
        description: `${PEER_RULE_PREFIX}obs-ingest-${port}`,
        direction: 'in',
        protocol: 'tcp',
        port,
        sourceIps,
      }));
    }

    // Workload: only cross-provider workloads need a public 6443 allow-rule.
    if (control.provider === cluster.provider) return [];
    if (!control.masterIpAddress) return [];
    return [
      {
        description: `${PEER_RULE_PREFIX}apiserver`,
        direction: 'in',
        protocol: 'tcp',
        port: API_SERVER_PORT,
        sourceIps: [`${control.masterIpAddress}/32`],
      },
    ];
  }

  private isPeerRule(rule: FirewallRuleDto): boolean {
    return !!rule.description?.startsWith(PEER_RULE_PREFIX);
  }

  private publicObsIngestEnabled(): boolean {
    return process.env.FLUI_OBS_INGEST_ENABLE_PUBLIC === 'true';
  }

  /** Only well-formed NodePorts (30000–32767) — a typo must never open an
   *  arbitrary control-plane port (e.g. 22 / 6443 / 5432) publicly. */
  private obsIngestNodePorts(): string[] {
    const raw = (
      process.env.FLUI_OBS_INGEST_NODEPORTS || DEFAULT_OBS_INGEST_NODEPORTS
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const valid: string[] = [];
    for (const p of raw) {
      const n = Number(p);
      if (Number.isInteger(n) && n >= NODEPORT_MIN && n <= NODEPORT_MAX) {
        valid.push(String(n));
      } else {
        this.logger.warn(
          `[fw-xprovider] ignoring invalid ingest NodePort '${p}' (must be an integer ${NODEPORT_MIN}-${NODEPORT_MAX})`,
        );
      }
    }
    return valid;
  }
}
