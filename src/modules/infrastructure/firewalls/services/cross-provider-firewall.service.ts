import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import { NodeType } from '../../clusters/entities/cluster-node.entity';
import { ClusterFirewallEntity } from '../entities/cluster-firewall.entity';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { WireGuardPeerService } from '../../networking/services/wireguard-peer.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { FirewallDesiredStateService } from './firewall-desired-state.service';
import { FirewallReconciliationService } from './firewall-reconciliation.service';

/** Marks the dynamic, cluster-topology-derived rules this service owns. */
const PEER_RULE_PREFIX = 'flui:xprovider:';
/** The Flui overlay's listen port. Not WireGuard's 51820: k3s would claim that
 *  if flannel were ever switched to its wireguard-native backend. */
const DEFAULT_WG_PORT = 51821;
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
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly managementAddress: ManagementAddressResolver,
    private readonly wgPeers: WireGuardPeerService,
    private readonly encryption: EncryptionService,
  ) {}

  async reconcileAllPeers(): Promise<void> {
    const firewalls = await this.desiredState.listFirewalls();
    const clusters = firewalls
      .map((f) => f.cluster)
      .filter((c): c is ClusterEntity => !!c);

    // Resolve the control authoritatively from cluster state, not from the
    // firewall set: a BYOS control is operator-wired and owns no cloud firewall,
    // so scraping it from firewalls would miss it and skip every peer rule.
    const control = await this.resolveControlCluster();
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

    // The one inbound rule the overlay needs anywhere: members dial out and
    // hold the tunnel open, so only the control cluster has to listen.
    const wgEgressIps = await this.overlayEgressIps();

    for (const fw of firewalls) {
      if (!fw.cluster || fw.cluster.status === ClusterStatus.DELETED) continue;
      try {
        await this.reconcileFirewallPeers(
          fw,
          control,
          crossWorkloadNodeIps,
          wgEgressIps,
        );
      } catch (err: any) {
        this.logger.error(
          `[fw-xprovider] firewall ${fw.id} (cluster ${fw.cluster?.id}) failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  /** Load control-type clusters (with nodes) straight from the repository so a
   *  firewall-less BYOS control is still resolved. */
  private async resolveControlCluster(): Promise<ClusterEntity | undefined> {
    const candidates = await this.clusterRepository.find({
      where: [
        { clusterType: ClusterType.CONTROL },
        { clusterType: ClusterType.OBSERVABILITY },
      ],
      relations: ['nodes'],
    });
    return this.pickControlCluster(candidates);
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
    // Derived from the very call that told those nodes where to push, so the
    // allow-list and the push target can never drift apart: a node sent to the
    // control's public address must be allowed in on it.
    const ips = clusters
      .filter(
        (c) =>
          !isControlClusterType(c.clusterType) &&
          c.status === ClusterStatus.READY &&
          this.managementAddress.controlEndpointFor(c, control)?.path ===
            'public',
      )
      .flatMap((c) => (c.nodes ?? []).map((n) => n.ipAddress))
      .filter((ip): ip is string => !!ip);
    return [...new Set(ips)];
  }

  private async reconcileFirewallPeers(
    fw: ClusterFirewallEntity,
    control: ClusterEntity,
    crossWorkloadNodeIps: string[],
    wgEgressIps: string[],
  ): Promise<void> {
    const cluster = fw.cluster;
    const master =
      (cluster.nodes ?? []).find((n) => n.nodeType === NodeType.MASTER) ??
      (cluster.nodes ?? [])[0];
    const nodeOverlay = master
      ? await this.wgPeers.nodeOverlayFor(master.id).catch(() => undefined)
      : undefined;
    const peerRules = this.computePeerRules(
      cluster,
      control,
      crossWorkloadNodeIps,
      wgEgressIps,
      nodeOverlay,
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
    wgEgressIps: string[],
    nodeOverlay?: { nodeAddress: string; enrolled: boolean },
  ): FirewallRuleDto[] {
    if (isControlClusterType(cluster.clusterType)) {
      const rules: FirewallRuleDto[] = [];
      if (this.overlayEnabled()) {
        rules.push({
          description: `${PEER_RULE_PREFIX}wg-listen`,
          direction: 'in',
          protocol: 'udp',
          port: String(this.wgPort()),
          // Open, deliberately. Scoping this to the egress addresses of peers
          // already known is circular: a member has to dial in before it can be
          // known, and cannot dial in until it is. Live consequence — a cluster
          // whose peer table had just been emptied left the port closed, and the
          // first new member waited out a firewall pass before it could join.
          // The same scoping also breaks WireGuard's roaming: a peer whose
          // public address changes stops being admitted under its old one.
          // Nothing is lost by opening it. WireGuard authenticates by public
          // key and answers an unknown peer with silence, so the address was
          // never the identity — it only narrowed who could be ignored.
          sourceIps: ['0.0.0.0/0', '::/0'],
        });
      }
      // Unauthenticated ingest stays vnet-only unless explicitly opted in.
      if (!this.publicObsIngestEnabled()) return rules;
      if (crossWorkloadNodeIps.length === 0) return rules;
      const ports = this.obsIngestNodePorts();
      if (ports.length === 0) return rules;
      const sourceIps = crossWorkloadNodeIps.map((ip) => `${ip}/32`);
      return [
        ...rules,
        ...ports.map((port) => ({
          description: `${PEER_RULE_PREFIX}obs-ingest-${port}`,
          direction: 'in' as const,
          protocol: 'tcp' as const,
          port,
          sourceIps,
        })),
      ];
    }

    // Workload: the rule follows the kubeconfig, never a parallel predicate,
    // so a public API-server endpoint can never exist without the rule that
    // opens 6443 to it.
    const master =
      (cluster.nodes ?? []).find((n) => n.nodeType === NodeType.MASTER) ??
      (cluster.nodes ?? [])[0];
    if (!master) return [];
    // This rule governs the public path and nothing else. The tunnel is admitted
    // on the host by interface (`iifname flui0`), which no source address can
    // express and which stays true however the control's address changes; on a
    // provider firewall the tunnel is invisible anyway, since it only ever sees
    // the outer UDP. So when the path stops being public there is nothing left
    // here to open.
    // Asked of the stored kubeconfig, which is where the choice is actually
    // written down — not re-derived from peer health. Two reasons, and the
    // second is the one that hurt: health flaps, so a rule derived from it
    // reopens the public port on every stale handshake; and worse, it withdrew
    // the rule the moment a peer enrolled, closing the old door before anything
    // had proved the new one open. Seen live — a workload whose certificate did
    // not yet name its overlay address was left reachable at neither.
    //
    // The rule now follows the address the control will actually dial. It goes
    // when the kubeconfig moves, and not one pass earlier.
    const addressed = this.addressedAt(cluster);
    const publicIp = this.trim(master.ipAddress);
    if (addressed) {
      if (!publicIp || addressed !== publicIp) return [];
    } else {
      // Before the first kubeconfig exists there is nothing to follow, so fall
      // back to the endpoint the creation path is about to choose.
      const endpoint = this.managementAddress.apiServerEndpointFor(
        cluster,
        master,
        control,
        nodeOverlay,
      );
      if (endpoint?.path !== 'public') return [];
    }

    const controlIp = this.managementAddress.publicAddressOf(control);
    if (!controlIp) return [];
    return [
      {
        description: `${PEER_RULE_PREFIX}apiserver`,
        direction: 'in',
        protocol: 'tcp',
        port: API_SERVER_PORT,
        sourceIps: [`${controlIp}/32`],
      },
    ];
  }

  /** The host the stored kubeconfig names, or nothing if there is none to read. */
  private addressedAt(cluster: ClusterEntity): string | undefined {
    if (!cluster.kubeconfigEncrypted) return undefined;
    try {
      return /\bserver:\s*https:\/\/([^\s:/]+|\[[^\]]+\])/.exec(
        this.encryption.decrypt(cluster.kubeconfigEncrypted),
      )?.[1];
    } catch {
      // Unreadable is not proof of anything.
      return undefined;
    }
  }

  private trim(value: string | null | undefined): string | undefined {
    const t = value?.trim();
    return t ? t : undefined;
  }

  private isPeerRule(rule: FirewallRuleDto): boolean {
    return !!rule.description?.startsWith(PEER_RULE_PREFIX);
  }

  /**
   * Addresses the overlay's peers dial in from, empty when the overlay is off.
   *
   * A failure here must not take the whole firewall reconcile with it: the
   * public rules this service also owns are what keep existing clusters
   * manageable, and they are not the overlay's to break.
   */
  private async overlayEgressIps(): Promise<string[]> {
    if (process.env.FLUI_WG_ENABLED !== 'true') return [];
    try {
      return await this.wgPeers.memberEgressIps();
    } catch (err: any) {
      this.logger.warn(
        `[fw-xprovider] could not read overlay peers (${err?.message ?? err}) — ` +
          `leaving the WireGuard port closed this pass`,
      );
      return [];
    }
  }

  private overlayEnabled(): boolean {
    return process.env.FLUI_WG_ENABLED === 'true';
  }

  private wgPort(): number {
    const raw = Number(process.env.FLUI_WG_PORT);
    return Number.isInteger(raw) && raw > 0 && raw < 65536
      ? raw
      : DEFAULT_WG_PORT;
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
