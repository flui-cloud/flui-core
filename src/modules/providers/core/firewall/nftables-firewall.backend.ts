import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { CertificateSignerService } from 'src/modules/access/services/certificate-signer.service';
import { NativeSSHConnectionService } from 'src/modules/terminal/services/native-ssh-connection.service';
import {
  IFirewallProvider,
  CreateFirewallConfig,
  FirewallCreationResult,
  FirewallDetails,
  FirewallRule,
  FirewallFilters,
} from '../../interfaces/firewall-provider.interface';
import { CloudProvider } from '../../enums/cloud-provider.enum';
import {
  renderFluiNftRuleset,
  decodeRulesComment,
  DEFAULT_INTERNAL_CIDRS,
} from './nftables-ruleset';

interface SshTarget {
  host: string;
  port: number;
  user: string;
}

const FIREWALL_ID_PREFIX = 'nft-';
const RULESET_PATH = '/etc/flui/flui-firewall.nft';
const SSH_TIMEOUT_MS = 60_000;
const CERT_TTL_SECONDS = 300;

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const CIDR_RE = /^[0-9a-fA-F:.]+\/\d{1,3}$/;
const LOOPBACK_RE = /^(127\.|::1$|169\.254\.|fe80:)/;

@Injectable()
export class NftablesFirewallBackend implements IFirewallProvider {
  private readonly logger = new Logger(NftablesFirewallBackend.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly certificateSigner: CertificateSignerService,
    private readonly nativeSsh: NativeSSHConnectionService,
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
      this.deriveInternalCidrs(cluster),
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
      this.deriveInternalCidrs(cluster),
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
    if (cluster.provider === CloudProvider.BYOS) {
      return this.deriveByosTargets(cluster);
    }
    const targets = this.collectNodeHosts(cluster).map((host) => ({
      host,
      port: 22,
      user: 'root',
    }));
    if (targets.length === 0) {
      throw new BadRequestException(
        `No reachable SSH endpoint for cluster ${cluster.id}`,
      );
    }
    return targets;
  }

  private deriveByosTargets(cluster: ClusterEntity): SshTarget[] {
    const byos = (cluster.metadata as { byos?: Partial<SshTarget> } | undefined)
      ?.byos;
    const clusterPort = byos?.port ?? 22;
    const clusterUser = byos?.user ?? 'root';
    const seen = new Set<string>();
    const targets: SshTarget[] = [];
    for (const node of cluster.nodes ?? []) {
      const nb = (node.metadata as { byos?: Partial<SshTarget> } | undefined)
        ?.byos;
      const host = nb?.host || node.ipAddress || byos?.host;
      if (!host) continue;
      const target = {
        host,
        port: nb?.port ?? clusterPort,
        user: nb?.user ?? clusterUser,
      };
      const key = `${target.host}:${target.port}:${target.user}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push(target);
      }
    }
    if (targets.length > 0) return targets;
    const host = byos?.host || cluster.masterIpAddress;
    if (host) return [{ host, port: clusterPort, user: clusterUser }];
    throw new BadRequestException(
      `No reachable SSH endpoint for cluster ${cluster.id}`,
    );
  }

  private collectNodeHosts(cluster: ClusterEntity): string[] {
    const ips = new Set<string>();
    for (const node of cluster.nodes ?? []) {
      if (node.ipAddress) ips.add(node.ipAddress);
    }
    if (cluster.masterIpAddress) ips.add(cluster.masterIpAddress);
    return [...ips];
  }

  private deriveInternalCidrs(cluster: ClusterEntity): string[] {
    const cidrs = new Set<string>(DEFAULT_INTERNAL_CIDRS);

    const declared = (
      cluster.metadata as { byos?: { nodeNetwork?: string | string[] } }
    )?.byos?.nodeNetwork;
    const declaredList = Array.isArray(declared)
      ? declared
      : (declared ?? '').split(',');
    for (const raw of declaredList) {
      const cidr = raw.trim();
      if (cidr && CIDR_RE.test(cidr)) cidrs.add(cidr);
    }

    for (const node of cluster.nodes ?? []) {
      const ip = node.privateIp?.trim();
      if (ip && IPV4_RE.test(ip) && !LOOPBACK_RE.test(ip)) {
        cidrs.add(`${ip}/32`);
      }
    }

    return [...cidrs];
  }

  private async applyRuleset(
    clusterId: string,
    rules: FirewallRule[],
    targets: SshTarget[],
    internalCidrs?: string[],
  ): Promise<void> {
    const ruleset = renderFluiNftRuleset(rules, {
      supportsSshAllowlist: false,
      internalCidrs,
    });
    const b64 = Buffer.from(ruleset, 'utf-8').toString('base64');

    const script = [
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
    const cert = await this.certificateSigner.generateEphemeralCertificate(
      undefined,
      CERT_TTL_SECONDS,
    );
    try {
      return await this.nativeSsh.execCommand(
        target.host,
        target.user,
        cert.privateKey,
        command,
        SSH_TIMEOUT_MS,
        { certificate: cert.certificate, port: target.port },
      );
    } catch (error) {
      throw this.toReachabilityError(error, target);
    }
  }

  private toReachabilityError(error: unknown, target: SshTarget): Error {
    const msg = error instanceof Error ? error.message : String(error);
    const unreachable =
      /connection refused|connection timed out|timed out|no route to host|could not resolve|permission denied|host key verification|code 255/i.test(
        msg,
      );
    if (unreachable) {
      return new ServiceUnavailableException(
        `Cannot reach node ${target.host}:${target.port} over SSH — the host firewall is applied over SSH. ` +
          `Check the cluster's SSH connection settings (host, port, user). (${msg})`,
      );
    }
    return error instanceof Error ? error : new Error(msg);
  }
}
