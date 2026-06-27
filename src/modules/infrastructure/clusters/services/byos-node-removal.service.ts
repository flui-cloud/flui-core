import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeType } from '../entities/cluster-node.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { getOperationSteps } from '../../operations/helpers/operation-steps.helper';
import { CertificateSignerService } from '../../../access/services/certificate-signer.service';
import { NativeSSHConnectionService } from '../../../terminal/services/native-ssh-connection.service';
import { FirewallReconciliationService } from '../../firewalls/services/firewall-reconciliation.service';
import { ByosVNetService } from './byos-vnet.service';

interface SshTarget {
  host: string;
  port: number;
  user: string;
}

interface RemovalWarning {
  code: string;
  reason: string;
  details?: Record<string, unknown>;
}

const CERT_TTL_SECONDS = 300;
const RULESET_PATH = '/etc/flui/flui-firewall.nft';
const DRAIN_TIMEOUT_MS = 140_000;
const SSH_TIMEOUT_MS = 90_000;

@Injectable()
export class ByosNodeRemovalService {
  private readonly logger = new Logger(ByosNodeRemovalService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepository: Repository<ClusterNodeEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    private readonly certificateSigner: CertificateSignerService,
    private readonly nativeSsh: NativeSSHConnectionService,
    private readonly firewallReconciliation: FirewallReconciliationService,
    private readonly byosVNet: ByosVNetService,
  ) {}

  async removeWorker(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<InfrastructureOperationEntity> {
    const warnings: RemovalWarning[] = [];
    const nodeName = node.serverName;
    const masterTarget = this.resolveMasterTarget(cluster);
    const nodeTarget = this.resolveNodeTarget(cluster, node);

    this.logger.log(
      `BYOS remove worker "${nodeName}" (cluster ${cluster.id}) — ` +
        `master ${masterTarget?.host ?? 'unknown'}, node ${nodeTarget?.host ?? 'unknown'}`,
    );

    if (masterTarget) {
      await this.runOnMaster(
        masterTarget,
        this.withKubectl(`$KCTL cordon ${nodeName}`),
        SSH_TIMEOUT_MS,
        warnings,
        'CORDON_FAILED',
        nodeName,
      );
      await this.runOnMaster(
        masterTarget,
        this.withKubectl(
          `$KCTL drain ${nodeName} --ignore-daemonsets --delete-emptydir-data --force --timeout=120s`,
        ),
        DRAIN_TIMEOUT_MS,
        warnings,
        'DRAIN_FAILED',
        nodeName,
      );
    } else {
      warnings.push({
        code: 'DRAIN_SKIPPED',
        reason: 'No reachable master SSH endpoint to cordon/drain the node.',
      });
    }

    if (nodeTarget) {
      try {
        const out = await this.sshExec(
          nodeTarget,
          this.uninstallScript(),
          SSH_TIMEOUT_MS,
        );
        if (!out.includes('FLUI_AGENT_UNINSTALLED')) {
          warnings.push({
            code: 'UNINSTALL_UNCONFIRMED',
            reason: `k3s-agent uninstall did not confirm: ${out.trim().slice(-200)}`,
            details: { host: nodeTarget.host },
          });
        }
      } catch (e) {
        warnings.push({
          code: 'UNINSTALL_FAILED',
          reason: (e as Error).message,
          details: { host: nodeTarget.host, port: nodeTarget.port },
        });
        this.logger.warn(
          `k3s-agent uninstall failed on ${nodeTarget.host}: ${(e as Error).message} — continuing with deregistration`,
        );
      }
    } else {
      warnings.push({
        code: 'UNINSTALL_SKIPPED',
        reason:
          'No reachable SSH endpoint for the node — k3s may still be running on the host. ' +
          'Run `k3s-agent-uninstall.sh` on it manually.',
      });
    }

    if (masterTarget) {
      await this.runOnMaster(
        masterTarget,
        this.withKubectl(
          `$KCTL delete node ${nodeName} --ignore-not-found=true --timeout=60s && ` +
            `$KCTL delete secret -n kube-system ${nodeName}.node-password.k3s --ignore-not-found=true --timeout=30s`,
        ),
        SSH_TIMEOUT_MS,
        warnings,
        'K3S_NODE_DELETE_FAILED',
        nodeName,
      );
    } else {
      warnings.push({
        code: 'K3S_NODE_DELETE_SKIPPED',
        reason: 'No reachable master SSH endpoint to delete the node from k3s.',
      });
    }

    await this.nodeRepository.delete({ id: node.id });
    const total = await this.nodeRepository.count({
      where: { clusterId: cluster.id },
    });
    await this.clusterRepository.update(cluster.id, { nodeCount: total });

    try {
      await this.byosVNet.detachNode(cluster, node);
    } catch (e) {
      warnings.push({
        code: 'VNET_DETACH_FAILED',
        reason: (e as Error).message,
      });
      this.logger.warn(
        `VNet detach after removal failed for ${nodeName}: ${(e as Error).message}`,
      );
    }

    try {
      const fw =
        await this.firewallReconciliation.reconcileClusterFirewallIfExists(
          cluster.id,
        );
      if (fw) {
        this.logger.log(
          `Master firewall reconciled after removing ${nodeName} (dropped node from internal CIDRs)`,
        );
      }
    } catch (e) {
      warnings.push({
        code: 'FIREWALL_RECONCILE_FAILED',
        reason: (e as Error).message,
      });
      this.logger.warn(
        `Firewall reconcile after removal failed: ${(e as Error).message}`,
      );
    }

    return this.recordOperation(cluster, node, warnings);
  }

  private async runOnMaster(
    target: SshTarget,
    command: string,
    timeoutMs: number,
    warnings: RemovalWarning[],
    failCode: string,
    nodeName: string,
  ): Promise<void> {
    try {
      await this.sshExec(target, command, timeoutMs);
    } catch (e) {
      warnings.push({
        code: failCode,
        reason: (e as Error).message,
        details: { nodeName },
      });
      this.logger.warn(
        `${failCode} for ${nodeName}: ${(e as Error).message} — continuing`,
      );
    }
  }

  private withKubectl(command: string): string {
    return (
      'if command -v kubectl >/dev/null 2>&1; then KCTL=kubectl; ' +
      'else KCTL="k3s kubectl"; fi; ' +
      command
    );
  }

  private uninstallScript(): string {
    return [
      'set +e',
      'if [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then',
      '  /usr/local/bin/k3s-agent-uninstall.sh',
      'elif [ -x /usr/local/bin/k3s-uninstall.sh ]; then',
      '  /usr/local/bin/k3s-uninstall.sh',
      'else',
      '  echo "no k3s uninstall script found" >&2',
      'fi',
      'NFT=$(command -v nft || echo /usr/sbin/nft)',
      '"$NFT" delete table inet flui 2>/dev/null || true',
      `rm -f ${RULESET_PATH}`,
      'systemctl disable --now flui-firewall.service 2>/dev/null || true',
      'rm -f /etc/systemd/system/flui-firewall.service',
      'systemctl daemon-reload 2>/dev/null || true',
      'echo FLUI_AGENT_UNINSTALLED',
    ].join('\n');
  }

  private resolveMasterTarget(cluster: ClusterEntity): SshTarget | null {
    const master = (cluster.nodes ?? []).find(
      (n) => n.nodeType === NodeType.MASTER,
    );
    if (master) {
      const target = this.resolveNodeTarget(cluster, master);
      if (target) return target;
    }
    const byos = this.clusterByos(cluster);
    const host = byos?.host || cluster.masterIpAddress;
    if (!host) return null;
    return { host, port: byos?.port ?? 22, user: byos?.user ?? 'root' };
  }

  private resolveNodeTarget(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): SshTarget | null {
    const byos = this.clusterByos(cluster);
    const nb = (node.metadata as { byos?: Partial<SshTarget> } | undefined)
      ?.byos;
    const isMaster = node.nodeType === NodeType.MASTER;
    const host =
      nb?.host ||
      node.ipAddress ||
      node.privateIp ||
      (isMaster ? byos?.host || cluster.masterIpAddress : undefined);
    if (!host) return null;
    return {
      host,
      port: nb?.port ?? byos?.port ?? 22,
      user: nb?.user ?? byos?.user ?? 'root',
    };
  }

  private clusterByos(cluster: ClusterEntity): Partial<SshTarget> | undefined {
    return (cluster.metadata as { byos?: Partial<SshTarget> } | undefined)
      ?.byos;
  }

  private async sshExec(
    target: SshTarget,
    command: string,
    timeoutMs: number,
  ): Promise<string> {
    const cert = await this.certificateSigner.generateEphemeralCertificate(
      undefined,
      CERT_TTL_SECONDS,
    );
    return this.nativeSsh.execCommand(
      target.host,
      target.user,
      cert.privateKey,
      command,
      timeoutMs,
      { certificate: cert.certificate, port: target.port },
    );
  }

  private async recordOperation(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
    warnings: RemovalWarning[],
  ): Promise<InfrastructureOperationEntity> {
    const steps = getOperationSteps(OperationType.REMOVE_WORKER);
    const now = new Date();
    const operation = this.operationRepository.create({
      operationType: OperationType.REMOVE_WORKER,
      status: OperationStatus.COMPLETED,
      resourceType: 'cluster',
      resourceName: cluster.name,
      resourceId: cluster.id,
      provider: cluster.provider as InfrastructureOperationEntity['provider'],
      totalSteps: steps.length,
      currentStepIndex: Math.max(steps.length - 1, 0),
      currentStepProgress: 100,
      progress: 100,
      startedAt: now,
      completedAt: now,
      metadata: {
        clusterId: cluster.id,
        nodeId: node.id,
        nodeName: node.serverName,
        byos: true,
        operationSteps: steps,
        warnings,
        message:
          warnings.length > 0
            ? `Worker removed with ${warnings.length} warning(s)`
            : 'Worker removed cleanly',
      },
    });
    return this.operationRepository.save(operation);
  }
}
