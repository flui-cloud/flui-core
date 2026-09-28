import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { VNetSubnetEntity } from 'src/modules/infrastructure/vnets/entities/vnet-subnet.entity';
import {
  IFirewallProvider,
  CreateFirewallConfig,
  FirewallCreationResult,
  FirewallDetails,
  FirewallRule,
  FirewallFilters,
} from '../../interfaces/firewall-provider.interface';
import { createHash } from 'node:crypto';
import { deriveHostTargets, HostTarget } from '../host/host-targets';
import {
  declaredNodeNetworks,
  readVnetSubnetRanges,
} from '../host/cluster-private-networks';
import {
  HostCommandService,
  toReachabilityError,
} from '../host/host-command.service';
import {
  renderFluiNftRuleset,
  decodeRulesComment,
  DEFAULT_INTERNAL_CIDRS,
} from './nftables-ruleset';
// The one place the overlay's interface name is decided, and it carries the
// reasoning for why it is not `wg0`. Duplicating the literal here would be a
// second truth about the same thing.
import { overlayRulesetOptions } from './overlay-ruleset-policy';

type SshTarget = HostTarget;

const FIREWALL_ID_PREFIX = 'nft-';
const RULESET_PATH = '/etc/flui/flui-firewall.nft';
const SSH_TIMEOUT_MS = 60_000;
const CERT_TTL_SECONDS = 300;

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const LOOPBACK_RE = /^(127\.|::1$|169\.254\.|fe80:)/;
const ANYWHERE_CIDRS = new Set(['0.0.0.0/0', '::/0']);

/**
 * The host firewall cannot go on yet, for a reason that is not a failure: it is
 * recorded and retried, never worked around by opening something.
 */
export class HostLayerBlockedError extends Error {}

@Injectable()
export class NftablesFirewallBackend implements IFirewallProvider {
  private readonly logger = new Logger(NftablesFirewallBackend.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(VNetSubnetEntity)
    private readonly subnetRepository: Repository<VNetSubnetEntity>,
    private readonly hostCommand: HostCommandService,
  ) {}

  async createFirewall(
    config: CreateFirewallConfig,
  ): Promise<FirewallCreationResult> {
    const clusterId = this.extractClusterId(config);
    const cluster = await this.loadClusterOrThrow(clusterId);
    const targets = this.deriveTargets(cluster);
    await this.applyRuleset(
      clusterId,
      config.rules,
      targets,
      await this.deriveInternalCidrs(cluster),
    );
    return {
      firewallId: this.makeFirewallId(clusterId),
      appliedToServerIds: targets.map((t) => t.host),
    };
  }

  async updateFirewallRules(
    firewallId: string,
    rules: FirewallRule[],
  ): Promise<void> {
    const clusterId = this.parseFirewallId(firewallId);
    const cluster = await this.loadClusterOrThrow(clusterId);
    const targets = this.deriveTargets(cluster);
    await this.applyRuleset(
      clusterId,
      rules,
      targets,
      await this.deriveInternalCidrs(cluster),
    );
  }

  async getFirewall(firewallId: string): Promise<FirewallDetails | null> {
    const clusterId = this.parseFirewallId(firewallId);
    const targets = await this.resolveTargets(clusterId).catch(() => []);
    if (targets.length === 0) return null;

    const raw = await this.sshExec(
      targets[0],
      `cat ${RULESET_PATH} 2>/dev/null || true`,
    ).catch(() => '');
    const rules = decodeRulesComment(raw) ?? [];

    return {
      id: this.makeFirewallId(clusterId),
      name: `flui-nftables-${clusterId}`,
      rules,
      labels: {
        'managed-by': 'flui-cloud',
        'flui-cluster-id': clusterId,
        'firewall-backend': 'host-nftables',
      },
      appliedTo: targets.map((t) => ({ serverId: t.host })),
    };
  }

  async listFirewalls(filters?: FirewallFilters): Promise<FirewallDetails[]> {
    if (!filters?.clusterId) return [];
    const details = await this.getFirewall(
      this.makeFirewallId(filters.clusterId),
    );
    return details ? [details] : [];
  }

  async deleteFirewall(firewallId: string): Promise<void> {
    const clusterId = this.parseFirewallId(firewallId);
    const targets = await this.resolveTargets(clusterId).catch(() => []);
    if (targets.length === 0) return;

    const script = [
      'set -e',
      'NFT=$(command -v nft || echo /usr/sbin/nft)',
      '"$NFT" delete table inet flui 2>/dev/null || true',
      `rm -f ${RULESET_PATH}`,
      'systemctl disable --now flui-firewall.service 2>/dev/null || true',
      'rm -f /etc/systemd/system/flui-firewall.service',
      'systemctl daemon-reload 2>/dev/null || true',
      'echo FLUI_NFT_DELETED',
    ].join('\n');

    for (const target of targets) {
      await this.sshExec(target, script);
      this.logger.log(
        `Removed Flui nftables firewall on ${target.host}:${target.port}`,
      );
    }
  }

  async applyToServers(
    _firewallId: string,
    _serverIds: string[],
  ): Promise<void> {
    this.logger.debug(
      'applyToServers is a no-op for host-nftables (ruleset applied during reconcile)',
    );
  }

  async removeFromServers(
    _firewallId: string,
    _serverIds: string[],
  ): Promise<void> {
    this.logger.debug(
      'removeFromServers is a no-op for host-nftables (use deleteFirewall)',
    );
  }

  /**
   * Why the ruleset cannot go onto a cluster whose nodes were never behind a
   * host firewall, or null when it can.
   *
   * Everything a node accepts from its siblings is admitted by source network,
   * so without the private network in hand the default-drop would cut the
   * cluster in pieces; failing safe means not applying, not applying wider.
   */
  async hostLayerBlocker(clusterId: string): Promise<string | null> {
    const cluster = await this.loadClusterOrThrow(clusterId);
    let targets: SshTarget[] = [];
    try {
      targets = this.deriveTargets(cluster);
    } catch {
      targets = [];
    }
    if (targets.length === 0) return 'The cluster has no reachable node yet.';

    const privateRanges = [
      ...this.declaredNodeNetworks(cluster),
      ...(await this.resolveVnetSubnetCidrs(cluster)),
    ].filter((cidr) => !ANYWHERE_CIDRS.has(cidr));
    if (privateRanges.length === 0) {
      return (
        'Flui does not know the private network of this cluster, so the host ' +
        'firewall would cut traffic between its nodes.'
      );
    }

    const nodes = cluster.nodes ?? [];
    const withoutPrivate = nodes.filter((n) => !n.privateIp?.trim());
    if (nodes.length > 1 && withoutPrivate.length > 0) {
      const names = withoutPrivate.map((n) => n.serverName || n.id).join(', ');
      return (
        `Node(s) ${names} have no private address, so their traffic to the ` +
        'other nodes would be refused.'
      );
    }
    return null;
  }

  hostLayerFingerprint(
    clusterId: string,
    rules: FirewallRule[],
  ): Promise<string | undefined> {
    return this.payloadFingerprint(this.makeFirewallId(clusterId), rules);
  }

  /**
   * Checks every node before touching any: a cluster where some nodes filter
   * and others do not is harder to reason about than one where none do, and
   * installing packages from the API is not this layer's job.
   */
  async applyHostLayer(
    clusterId: string,
    rules: FirewallRule[],
  ): Promise<number> {
    const blocker = await this.hostLayerBlocker(clusterId);
    if (blocker) throw new HostLayerBlockedError(blocker);

    const cluster = await this.loadClusterOrThrow(clusterId);
    const targets = this.deriveTargets(cluster);
    const withoutNft: string[] = [];
    for (const target of targets) {
      const out = await this.sshExec(
        target,
        'if command -v nft >/dev/null 2>&1 || [ -x /usr/sbin/nft ]; then echo FLUI_NFT_PRESENT; else echo FLUI_NFT_MISSING; fi',
      );
      if (!out.includes('FLUI_NFT_PRESENT')) withoutNft.push(target.host);
    }
    if (withoutNft.length > 0) {
      throw new HostLayerBlockedError(
        `nftables is not installed on ${withoutNft.join(', ')}; install it on ` +
          'the node(s) and the host firewall is applied on the next pass.',
      );
    }

    await this.applyRuleset(
      clusterId,
      rules,
      targets,
      await this.deriveInternalCidrs(cluster),
    );
    return targets.length;
  }

  removeHostLayer(clusterId: string): Promise<void> {
    return this.deleteFirewall(this.makeFirewallId(clusterId));
  }

  private makeFirewallId(clusterId: string): string {
    return `${FIREWALL_ID_PREFIX}${clusterId}`;
  }

  private parseFirewallId(firewallId: string): string {
    if (firewallId?.startsWith(FIREWALL_ID_PREFIX)) {
      return firewallId.slice(FIREWALL_ID_PREFIX.length);
    }
    if (firewallId) return firewallId;
    throw new BadRequestException(
      'host-nftables firewall id must encode the cluster id',
    );
  }

  private extractClusterId(config: CreateFirewallConfig): string {
    const fromLabel = config.labels?.find(
      (l) => l.key === 'flui-cluster-id',
    )?.value;
    if (fromLabel) return fromLabel;

    const selector = config.applyToLabelSelector ?? '';
    const match = /flui-cluster-id=([^,\s]+)/.exec(selector);
    if (match) return match[1];

    throw new BadRequestException(
      'host-nftables firewall requires a flui-cluster-id label or selector',
    );
  }

  private async resolveTargets(clusterId: string): Promise<SshTarget[]> {
    const cluster = await this.loadClusterOrThrow(clusterId);
    return this.deriveTargets(cluster);
  }

  private async loadClusterOrThrow(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) {
      throw new BadRequestException(`Cluster ${clusterId} not found`);
    }
    return cluster;
  }

  private deriveTargets(cluster: ClusterEntity): SshTarget[] {
    return deriveHostTargets(cluster);
  }

  private async deriveInternalCidrs(cluster: ClusterEntity): Promise<string[]> {
    const cidrs = new Set<string>(DEFAULT_INTERNAL_CIDRS);

    for (const cidr of this.declaredNodeNetworks(cluster)) cidrs.add(cidr);

    for (const node of cluster.nodes ?? []) {
      const ip = node.privateIp?.trim();
      if (ip && IPV4_RE.test(ip) && !LOOPBACK_RE.test(ip)) {
        cidrs.add(`${ip}/32`);
      }
    }

    // Node /32s only ever cover this cluster's own nodes, and a node's own IP is
    // already reached over `lo`. The peers that actually need in — the control
    // cluster, sibling workload clusters — are siblings on the environment's
    // VNet subnet, so the subnet range is what makes them reachable.
    for (const cidr of await this.resolveVnetSubnetCidrs(cluster)) {
      cidrs.add(cidr);
    }

    return [...cidrs];
  }

  private declaredNodeNetworks(cluster: ClusterEntity): string[] {
    return declaredNodeNetworks(cluster);
  }

  private async resolveVnetSubnetCidrs(
    cluster: ClusterEntity,
  ): Promise<string[]> {
    const { ranges, referencedWithoutRange, error } =
      await readVnetSubnetRanges(cluster, this.subnetRepository);
    if (error) {
      this.logger.warn(
        `Could not resolve the VNet subnet of cluster ${cluster.id} (${error}) — ` +
          `host firewall falls back to pod/service CIDRs plus node /32s`,
      );
    } else if (referencedWithoutRange) {
      this.logger.warn(
        `Cluster ${cluster.id} references a VNet subnet with no usable IP range — ` +
          `host firewall falls back to pod/service CIDRs plus node /32s`,
      );
    }
    return ranges;
  }

  /**
   * Exactly what a host will be sent — the ruleset and the unit that reinstates
   * it at boot, as one script.
   *
   * Built here and nowhere else so that whatever decides a host needs this
   * again is looking at the same text the host receives. A ruleset improvement
   * that changed no rule used to reach nobody: the comparison was over the
   * rules, and the rules had not moved.
   */
  private buildApplyScript(
    rules: FirewallRule[],
    targets: SshTarget[],
    internalCidrs?: string[],
  ): string {
    const ruleset = renderFluiNftRuleset(rules, {
      supportsSshAllowlist: false,
      internalCidrs,
      // The anti-lockout rule has to name the port Flui actually reaches these
      // hosts on, or reconciling a custom-port host locks us out of it.
      sshPorts: targets.map((t) => t.port),
      // Naming the interface does two things no source-address rule can: the
      // API server stays reachable over the tunnel whatever address the control
      // dials from, and this host stops forwarding between overlay peers. A
      // rule that names an address cannot follow the control when the path
      // moves, and the policy here is drop — so the address form is the one
      // that silently closes 6443 against the path just chosen.
      // The API server, and the telemetry a workload pushes back. Both arrive
      // on the tunnel, and without naming them here both are dropped: the
      // ingest ports sit inside the NodePort range this ruleset refuses on
      // principle — right for a public address, wrong for a peer the tunnel has
      // already authenticated. Shared with the fingerprint that decides when a
      // host needs the ruleset again, so the two cannot disagree about what it
      // contains.
      ...overlayRulesetOptions(),
    });
    const b64 = Buffer.from(ruleset, 'utf-8').toString('base64');

    return [
      'set -e',
      'NFT=$(command -v nft || echo /usr/sbin/nft)',
      'if [ ! -x "$NFT" ]; then echo "nft not found" >&2; exit 3; fi',
      'mkdir -p /etc/flui',
      `echo '${b64}' | base64 -d > ${RULESET_PATH}`,
      `"$NFT" -c -f ${RULESET_PATH}`,
      `"$NFT" -f ${RULESET_PATH}`,
      "cat > /etc/systemd/system/flui-firewall.service <<'UNIT'",
      '[Unit]',
      'Description=Flui-managed host firewall (nftables)',
      'After=network-pre.target',
      'Wants=network-pre.target',
      '[Service]',
      'Type=oneshot',
      `ExecStart=/usr/sbin/nft -f ${RULESET_PATH}`,
      'RemainAfterExit=yes',
      '[Install]',
      'WantedBy=multi-user.target',
      'UNIT',
      'systemctl daemon-reload 2>/dev/null || true',
      'systemctl enable flui-firewall.service >/dev/null 2>&1 || true',
      'echo FLUI_NFT_APPLIED',
    ].join('\n');
  }

  /**
   * Hashes the whole script, not the ruleset alone: the systemd unit that
   * reinstates it at boot is part of what a host is given, and a fix to that
   * unit is exactly the kind of change no rule describes.
   */
  async payloadFingerprint(
    firewallId: string,
    rules: FirewallRule[],
  ): Promise<string | undefined> {
    try {
      const clusterId = this.parseFirewallId(firewallId);
      const cluster = await this.loadClusterOrThrow(clusterId);
      const targets = this.deriveTargets(cluster);
      if (targets.length === 0) return undefined;
      const script = this.buildApplyScript(
        rules,
        targets,
        await this.deriveInternalCidrs(cluster),
      );
      return createHash('sha256').update(script).digest('hex').slice(0, 32);
    } catch (err: any) {
      // Not knowing must not be read as "nothing changed": returning nothing
      // leaves the decision to the rules comparison, which is where it was
      // before this existed.
      this.logger.warn(
        `Could not fingerprint the ruleset for ${firewallId}: ${err?.message ?? err}`,
      );
      return undefined;
    }
  }

  private async applyRuleset(
    clusterId: string,
    rules: FirewallRule[],
    targets: SshTarget[],
    internalCidrs?: string[],
  ): Promise<void> {
    const script = this.buildApplyScript(rules, targets, internalCidrs);

    for (const target of targets) {
      this.logger.log(
        `Applying Flui nftables ruleset (${rules.length} rules) to ${target.host}:${target.port}`,
      );
      const out = await this.sshExec(target, script);
      if (!out.includes('FLUI_NFT_APPLIED')) {
        throw new Error(
          `nftables apply did not confirm on ${target.host}: ${out.trim().slice(-200)}`,
        );
      }
    }
    this.logger.log(
      `Flui nftables ruleset applied to ${targets.length} node(s) of cluster ${clusterId}`,
    );
  }

  private async sshExec(target: SshTarget, command: string): Promise<string> {
    return this.hostCommand.run(target, command, {
      timeoutMs: SSH_TIMEOUT_MS,
      certTtlSeconds: CERT_TTL_SECONDS,
    });
  }

  /** Kept as a thin seam so the backend's own tests can exercise the mapping. */
  private toReachabilityError(error: unknown, target: SshTarget): Error {
    return toReachabilityError(error, target);
  }
}
