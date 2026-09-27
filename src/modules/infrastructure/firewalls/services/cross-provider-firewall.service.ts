import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import { NodeType } from '../../clusters/entities/cluster-node.entity';
import {
  WireGuardPeerRole,
  WireGuardPeerStatus,
} from '../../networking/entities/wireguard-peer.entity';
import { SSH_VIA_CONTROL_RULE } from '../../../providers/core/firewall/nftables-ruleset';
import { ClusterFirewallEntity } from '../entities/cluster-firewall.entity';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import { WireGuardPeerService } from '../../networking/services/wireguard-peer.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import {
  observabilityIngestPorts,
  NODEPORT_MIN,
  NODEPORT_MAX,
} from '../../networking/observability-ingest';
import { FirewallDesiredStateService } from './firewall-desired-state.service';
import { FirewallReconciliationService } from './firewall-reconciliation.service';
import { managementNetworkOn } from '../../networking/management-network.state';

/** Marks the dynamic, cluster-topology-derived rules this service owns. */
const PEER_RULE_PREFIX = 'flui:xprovider:';
/** The Flui overlay's listen port. Not WireGuard's 51820: k3s would claim that
 *  if flannel were ever switched to its wireguard-native backend. */
const DEFAULT_WG_PORT = 51821;
const API_SERVER_PORT = '6443';

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
    // hold the tunnel open, so only the control cluster has to listen — and
    // only to its members.
    const wgSources = await this.overlaySourcesOrNull();

    for (const fw of firewalls) {
      if (!fw.cluster || fw.cluster.status === ClusterStatus.DELETED) continue;
      const isControl = fw.cluster.id === control.id;
      // Unreadable members: the control keeps the rule it has rather than
      // closing the tunnel on everyone for one failed read.
      if (isControl && wgSources === null) continue;
      try {
        await this.reconcileFirewallPeers(
          fw,
          control,
          crossWorkloadNodeIps,
          wgSources ?? [],
        );
      } catch (err: any) {
        this.logger.error(
          `[fw-xprovider] firewall ${fw.id} (cluster ${fw.cluster?.id}) failed: ${err?.message ?? err}`,
        );
      }
    }
  }

  /**
   * Lets the nodes of `clusterId` through the control's tunnel port before they
   * dial in, and drops members that have left. Throws, so an enrolment can
   * record why a node could not reach the control.
   */
  async admitOverlayMembers(clusterId?: string): Promise<void> {
    if (!this.overlayEnabled()) return;
    const control = await this.resolveControlCluster();
    if (!control) return;
    const fw = (await this.desiredState.listFirewalls()).find(
      (f) => f.cluster?.id === control.id,
    );
    if (!fw) return;
    const sources = await this.overlaySources(clusterId ? [clusterId] : []);
    await this.reconcileFirewallPeers(fw, control, [], sources);
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
    const sshViaControl = await this.sshViaControlRule(cluster, control);
    if (sshViaControl) peerRules.push(sshViaControl);
    const baseRules = baseRulesOf(fw, Boolean(sshViaControl), (r) =>
      this.isPeerRule(r),
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
      const listen = this.wgListenRule(wgEgressIps);
      if (listen) rules.push(listen);
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

  /**
   * Only the members: the addresses they dialled in from and the addresses of
   * their nodes, which Flui knows before a node first dials in. That is what
   * breaks the circle of "known only after it has joined".
   */
  private wgListenRule(sources: string[]): FirewallRuleDto | null {
    if (!this.overlayEnabled() || !sources.length) return null;
    return {
      description: `${PEER_RULE_PREFIX}wg-listen`,
      direction: 'in',
      protocol: 'udp',
      port: String(this.wgPort()),
      sourceIps: sources,
    };
  }

  /**
   * A workload whose every node is up on the Flui network is reached through
   * the control, so its port 22 stops facing the internet: only the control's
   * address is let in (the tunnel itself never shows on a provider firewall,
   * and a host firewall admits it by interface). The moment any of its nodes
   * goes quiet this rule is not produced and the public rule comes back on the
   * same pass.
   */
  private async sshViaControlRule(
    cluster: ClusterEntity,
    control: ClusterEntity,
  ): Promise<FirewallRuleDto | null> {
    if (!this.overlayEnabled() || isControlClusterType(cluster.clusterType))
      return null;
    // Every control node: the API can run on any of them, so any is where the
    // SSH comes from.
    const controlIps = FirewallReconciliationService.controlEgressIps(control);
    if (!controlIps.length) return null;
    // Unreadable members prove nothing about the tunnel: the port stays as it was.
    const live = await this.wgPeers.livePeers().catch(() => null);
    if (!live) return null;
    const members = live.filter(
      (p) => p.role === WireGuardPeerRole.MEMBER && p.clusterId === cluster.id,
    );
    const nodes = (cluster.nodes ?? []).length;
    if (!members.length || members.length < nodes) return null;
    if (members.some((p) => p.status !== WireGuardPeerStatus.ACTIVE))
      return null;
    return {
      description: SSH_VIA_CONTROL_RULE,
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      sourceIps: controlIps.map((ip) =>
        ip.includes(':') ? `${ip}/128` : `${ip}/32`,
      ),
    };
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
   * Addresses the overlay's members may dial in from, or null when they could
   * not be read. A failure here must not take the whole firewall reconcile with
   * it: the public rules this service also owns keep existing clusters
   * manageable, and they are not the overlay's to break.
   */
  private async overlaySourcesOrNull(): Promise<string[] | null> {
    if (!this.overlayEnabled()) return [];
    try {
      return await this.overlaySources();
    } catch (err: any) {
      this.logger.warn(
        `[fw-xprovider] could not read overlay members (${err?.message ?? err}) — ` +
          `keeping the control's tunnel rule as it is this pass`,
      );
      return null;
    }
  }

  /**
   * Every live member's last endpoint, plus the public address of every node
   * of a cluster that has a member — reserved addresses included, so a node is
   * admitted before its first handshake. A cluster that left has no live peer
   * and drops out.
   */
  private async overlaySources(
    extraClusterIds: string[] = [],
  ): Promise<string[]> {
    const members = (await this.wgPeers.livePeers()).filter(
      (p) => p.role === WireGuardPeerRole.MEMBER,
    );
    const clusterIds = [
      ...new Set([...members.map((m) => m.clusterId), ...extraClusterIds]),
    ].filter(Boolean);
    const clusters = clusterIds.length
      ? await this.clusterRepository.find({
          where: { id: In(clusterIds) },
          relations: ['nodes'],
        })
      : [];
    const hosts = [
      ...members.map((m) => m.endpointHost),
      ...clusters
        .filter(
          (c) =>
            !isControlClusterType(c.clusterType) &&
            c.status !== ClusterStatus.DELETED,
        )
        .flatMap((c) => (c.nodes ?? []).map((n) => n.ipAddress)),
    ]
      .map((h) => this.trim(h))
      .filter((h): h is string => !!h);
    return [...new Set(hosts)]
      .sort()
      .map((h) => (h.includes(':') ? `${h}/128` : `${h}/32`));
  }

  private overlayEnabled(): boolean {
    return managementNetworkOn();
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
    const { ports, rejected } = observabilityIngestPorts();
    for (const bad of rejected) {
      this.logger.warn(
        `[fw-xprovider] ignoring invalid ingest NodePort '${bad}' (must be an integer ${NODEPORT_MIN}-${NODEPORT_MAX})`,
      );
    }
    return ports.map(String);
  }
}

/** A rule that opens port 22 to more than the control: the one that goes. */
function isPublicSsh(rule: FirewallRuleDto): boolean {
  return (
    rule.direction === 'in' && rule.protocol === 'tcp' && rule.port === '22'
  );
}

/** What the operator wrote, less what this service owns and, once SSH goes through the control, the public 22. */
function baseRulesOf(
  fw: ClusterFirewallEntity,
  sshThroughControl: boolean,
  isPeerRule: (rule: FirewallRuleDto) => boolean,
): FirewallRuleDto[] {
  return (fw.desiredRules ?? []).filter(
    (r) => !isPeerRule(r) && !(sshThroughControl && isPublicSsh(r)),
  );
}
