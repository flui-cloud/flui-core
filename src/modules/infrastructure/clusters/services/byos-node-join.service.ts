import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes, createHash } from 'node:crypto';
import {
  ClusterEntity,
  isControlClusterType,
} from '../entities/cluster.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { CAManagerService } from '../../../access/services/ca-manager.service';
import { ClusterOperationsService } from './cluster-operations.service';
import { FirewallReconciliationService } from '../../firewalls/services/firewall-reconciliation.service';
import { getFirewallRulesForClusterType } from '../../firewalls/templates/firewall-rules.template';
import {
  renderFluiNftRuleset,
  DEFAULT_INTERNAL_CIDRS,
} from '../../../providers/core/firewall/nftables-ruleset';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { getScriptsBaseUrl } from '../../../../config/bootstrap.config';
import { buildSystemNipHostname } from '../../../dns/utils/nip-hostname.util';

const TOKEN_TTL_MS = 30 * 60 * 1000;
const RULESET_PATH = '/etc/flui/flui-firewall.nft';

interface JoinToken {
  hash: string;
  role: 'worker';
  serverName: string;
  nodeNetwork?: string;
  masterIp: string;
  acmeStaging: boolean;
  useLatest: boolean;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

export interface IssuedJoinToken {
  token: string;
  command: string;
  expiresAt: string;
  masterIp: string;
  nodeNetwork?: string;
  serverName: string;
}

@Injectable()
export class ByosNodeJoinService {
  private readonly logger = new Logger(ByosNodeJoinService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly encryptionService: EncryptionService,
    private readonly caManager: CAManagerService,
    private readonly clusterOperations: ClusterOperationsService,
    private readonly firewallReconciliation: FirewallReconciliationService,
  ) {}

  async issueToken(
    clusterId: string,
    input: { nodeNetwork?: string; masterIp?: string },
  ): Promise<IssuedJoinToken> {
    const cluster = await this.loadByosCluster(clusterId);

    const masterIp = input.masterIp || cluster.masterIpAddress;
    if (!masterIp) {
      throw new BadRequestException(
        'No master address available — pass masterIp (the address the new node uses to reach the master k3s API).',
      );
    }
    const nodeNetwork = input.nodeNetwork || this.toSlash24(masterIp);
    const serverName = this.allocateWorkerName(cluster);

    const raw = randomBytes(24).toString('base64url');
    const now = Date.now();
    const token: JoinToken = {
      hash: this.hash(raw),
      role: 'worker',
      serverName,
      nodeNetwork,
      masterIp,
      acmeStaging: !!(cluster.metadata as any)?.acmeStaging,
      useLatest: !!(cluster.metadata as any)?.useLatest,
      createdAt: now,
      expiresAt: now + TOKEN_TTL_MS,
    };

    const meta: Record<string, any> = cluster.metadata ?? {};
    const tokens: JoinToken[] = Array.isArray(meta.joinTokens)
      ? meta.joinTokens
      : [];
    const pruned = tokens.filter((t) => t.expiresAt > now && !t.usedAt);
    cluster.metadata = {
      ...meta,
      byos: { ...meta.byos, ...(nodeNetwork ? { nodeNetwork } : undefined) },
      joinTokens: [...pruned, token],
    };
    await this.clusterRepository.save(cluster);

    await this.tryReconcileFirewall(
      clusterId,
      'pre-join (master accepts node network)',
    );

    return {
      token: raw,
      command: this.buildOneLiner(cluster, raw, masterIp),
      expiresAt: new Date(token.expiresAt).toISOString(),
      masterIp,
      nodeNetwork,
      serverName,
    };
  }

  async buildJoinScript(clusterId: string, rawToken: string): Promise<string> {
    const cluster = await this.loadByosCluster(clusterId);
    const { token, index } = this.findToken(cluster, rawToken);
    if (token.usedAt) {
      throw new UnauthorizedException('Join token already used');
    }
    if (token.expiresAt <= Date.now()) {
      throw new UnauthorizedException('Join token expired');
    }

    const meta: Record<string, any> = cluster.metadata;
    meta.joinTokens[index] = { ...token, usedAt: Date.now() };
    cluster.metadata = meta;
    await this.clusterRepository.save(cluster);

    const k3sToken = this.encryptionService.decrypt(cluster.k3sTokenEncrypted);
    const caPublicKey = await this.caManager.getCAPublicKey();
    const scriptsBaseUrl =
      process.env.BOOTSTRAP_SCRIPTS_URL || getScriptsBaseUrl(token.useLatest);

    const fwRules = getFirewallRulesForClusterType(
      isControlClusterType(cluster.clusterType) ? 'control' : 'workload',
      ['0.0.0.0/0', '::/0'],
    );
    const internalCidrs = [
      ...DEFAULT_INTERNAL_CIDRS,
      ...(token.nodeNetwork ? [token.nodeNetwork] : []),
    ];
    const ruleset = renderFluiNftRuleset(fwRules, {
      supportsSshAllowlist: false,
      internalCidrs,
    });
    const rulesetB64 = Buffer.from(ruleset, 'utf-8').toString('base64');

    const node = await this.clusterOperations.registerByosNode(clusterId, {
      serverName: token.serverName,
      nodeType: 'worker',
      status: 'joining',
    });

    return this.renderJoinScript({
      clusterId,
      clusterName: cluster.name,
      serverName: token.serverName,
      serverId: node.id,
      k3sToken,
      masterIp: token.masterIp,
      caPublicKey,
      scriptsBaseUrl,
      rulesetB64,
      completeUrl: this.joinUrl(cluster, token.masterIp, rawToken, 'complete'),
      curlInsecure: token.acmeStaging,
    });
  }

  async completeJoin(
    clusterId: string,
    rawToken: string,
    body: { serverName?: string; privateIp?: string },
  ): Promise<{ ok: true; nodeId: string }> {
    const cluster = await this.loadByosCluster(clusterId);
    const { token } = this.findToken(cluster, rawToken);
    if (token.expiresAt <= Date.now()) {
      throw new UnauthorizedException('Join token expired');
    }

    const node = await this.clusterOperations.registerByosNode(clusterId, {
      serverName: body.serverName || token.serverName,
      nodeType: 'worker',
      privateIp: body.privateIp,
      ipAddress: body.privateIp,
      byos: body.privateIp
        ? { host: body.privateIp, port: 22, user: 'root' }
        : undefined,
    });

    await this.tryReconcileFirewall(
      clusterId,
      'post-join (apply ruleset to worker)',
    );

    return { ok: true, nodeId: node.id };
  }

  private async loadByosCluster(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    if (cluster.provider !== CloudProvider.BYOS) {
      throw new BadRequestException(
        'Node-join tokens are only supported for BYOS clusters.',
      );
    }
    return cluster;
  }

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  private findToken(
    cluster: ClusterEntity,
    rawToken: string,
  ): { token: JoinToken; index: number } {
    const tokens: JoinToken[] = (cluster.metadata as any)?.joinTokens ?? [];
    const hash = this.hash(rawToken);
    const index = tokens.findIndex((t) => t.hash === hash);
    if (index < 0) throw new UnauthorizedException('Invalid join token');
    return { token: tokens[index], index };
  }

  private allocateWorkerName(cluster: ClusterEntity): string {
    const workers = (cluster.nodes ?? []).filter(
      (n) => n.nodeType === 'worker',
    ).length;
    const pending = ((cluster.metadata as any)?.joinTokens ?? []).filter(
      (t: JoinToken) => !t.usedAt && t.expiresAt > Date.now(),
    ).length;
    return `${cluster.name}-worker-${workers + pending + 1}`;
  }

  private toSlash24(ip: string): string | undefined {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip.trim());
    return m ? `${m[1]}.${m[2]}.${m[3]}.0/24` : undefined;
  }

  private async tryReconcileFirewall(
    clusterId: string,
    phase: string,
  ): Promise<void> {
    try {
      await this.firewallReconciliation.ensureClusterFirewall(clusterId);
      this.logger.log(`Host firewall reconciled: ${phase}`);
    } catch (e) {
      this.logger.warn(
        `Firewall reconcile skipped (${phase}): ${(e as Error).message}`,
      );
    }
  }

  private joinUrl(
    cluster: ClusterEntity,
    masterIp: string,
    rawToken: string,
    suffix: '' | 'complete',
  ): string {
    const override = process.env.FLUI_PUBLIC_JOIN_BASE_URL;
    const base =
      override?.replace(/\/$/, '') ||
      `https://${buildSystemNipHostname('api', masterIp, cluster.nipHostnameToken)}`;
    const path = `/api/v1/infrastructure/clusters/${cluster.id}/join/${rawToken}`;
    return suffix ? `${base}${path}/${suffix}` : `${base}${path}`;
  }

  private buildOneLiner(
    cluster: ClusterEntity,
    rawToken: string,
    masterIp: string,
  ): string {
    const url = this.joinUrl(cluster, masterIp, rawToken, '');
    const insecure = (cluster.metadata as any)?.acmeStaging ? '-k ' : '';
    const resolve = url.includes('.nip.io')
      ? `--resolve "${new URL(url).host}:443:${masterIp}" `
      : '';
    return `curl ${insecure}-fsSL ${resolve}"${url}" | sudo bash`;
  }

  private renderJoinScript(p: {
    clusterId: string;
    clusterName: string;
    serverName: string;
    serverId: string;
    k3sToken: string;
    masterIp: string;
    caPublicKey: string;
    scriptsBaseUrl: string;
    rulesetB64: string;
    completeUrl: string;
    curlInsecure: boolean;
  }): string {
    const esc = (s: string): string => s.replaceAll("'", String.raw`'\''`);
    const k = p.curlInsecure ? '-k ' : '';
    return `#!/bin/bash
# Flui.cloud BYOS worker join (token-issued). Run as root on the new host.
set -euo pipefail

export CLUSTER_ID='${esc(p.clusterId)}'
export CLUSTER_NAME='${esc(p.clusterName)}'
export SERVER_ID='${esc(p.serverId)}'
export INSTANCE_ID='${esc(p.serverName)}'
export INSTANCE_NAME='${esc(p.serverName)}'
export CLOUD_PROVIDER='byos'
export K3S_TOKEN='${esc(p.k3sToken)}'
export K3S_URL='https://${p.masterIp}:6443'
export MASTER_IP='${p.masterIp}'
export FLUI_CA_PUBLIC_KEY='${esc(p.caPublicKey)}'
export SSH_CA_PUBLIC_KEY='${esc(p.caPublicKey)}'
export SCRIPTS_BASE_URL='${esc(p.scriptsBaseUrl)}'

PRIVATE_IP=$(ip -4 -o addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -E '^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.)' | head -1 || true)
export PRIVATE_IP FLUI_BOOTSTRAP_NODE_PRIVATE_IP="\${PRIVATE_IP:-}"
echo "[Flui] Joining as worker '${p.serverName}' (private IP \${PRIVATE_IP:-unknown}) to ${p.masterIp}:6443"

echo "[Flui] Downloading k3s-worker-init.sh ..."
curl -fsSL "\${SCRIPTS_BASE_URL}/k3s-worker-init.sh" -o /tmp/k3s-worker-init.sh
chmod +x /tmp/k3s-worker-init.sh
/tmp/k3s-worker-init.sh

echo "[Flui] Applying host firewall ..."
mkdir -p /etc/flui
echo '${p.rulesetB64}' | base64 -d > ${RULESET_PATH}
NFT=$(command -v nft || echo /usr/sbin/nft)
if "$NFT" -c -f ${RULESET_PATH}; then
  "$NFT" -f ${RULESET_PATH}
  cat > /etc/systemd/system/flui-firewall.service <<'UNIT'
[Unit]
Description=Flui-managed host firewall (nftables)
After=network-pre.target
Wants=network-pre.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f ${RULESET_PATH}
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload 2>/dev/null || true
  systemctl enable flui-firewall.service >/dev/null 2>&1 || true
  echo "[Flui] Firewall applied."
else
  echo "[Flui] WARNING: firewall ruleset failed validation — skipped." >&2
fi

echo "[Flui] Registering node with the control plane ..."
curl ${k}-fsSL -X POST "${p.completeUrl}" \\
  -H 'Content-Type: application/json' \\
  -d "{\\"serverName\\":\\"${p.serverName}\\",\\"privateIp\\":\\"\${PRIVATE_IP:-}\\"}" || \\
  echo "[Flui] WARNING: registration callback failed (node still joined; add it from the dashboard)." >&2

echo "[Flui] FLUI_NODE_JOINED"
`;
  }
}
