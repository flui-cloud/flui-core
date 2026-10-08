import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ClusterEntity } from '../clusters/entities/cluster.entity';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { KubernetesService } from '../shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import {
  EGRESS_POLICY_NAME,
  EgressPolicy,
  EgressPort,
  buildEgressNetworkPolicy,
  SANDBOX_LABEL,
  clusterInternalCidrs,
  describeEgress,
  isSystemNamespace,
  normalizeEgressPorts,
} from './egress-policy.core';

export interface EgressReconcileResult {
  applied: string[];
  failed: Array<{ namespace: string; error: string }>;
}

export interface EgressView {
  open: boolean;
  ports: EgressPort[];
  summary: string;
}

function toView(policy: EgressPolicy | null): EgressView {
  return {
    open: !policy,
    ports: policy?.ports ?? [],
    summary: describeEgress(policy),
  };
}

/**
 * The cluster's rule for traffic leaving it, written into every namespace that
 * holds applications. Platform namespaces are never touched: the platform's
 * own mail, updates and overlay must not depend on what an administrator
 * allows applications to do.
 */
@Injectable()
export class EgressPolicyService {
  private readonly logger = new Logger(EgressPolicyService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    private readonly k8s: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async policyOf(clusterId: string): Promise<EgressPolicy | null> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      select: ['id', 'egressPolicy'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    return cluster.egressPolicy ?? null;
  }

  async view(clusterId: string): Promise<EgressView> {
    return toView(await this.policyOf(clusterId));
  }

  async viewForApplication(appId: string): Promise<EgressView> {
    const app = await this.applications.findOne({
      where: { id: appId },
      select: ['id', 'clusterId'],
    });
    if (!app?.clusterId) {
      throw new NotFoundException(`Application ${appId} not found`);
    }
    return this.view(app.clusterId);
  }

  async change(
    clusterId: string,
    ports: EgressPort[] | null,
  ): Promise<
    EgressView & { applied: number; failed: EgressReconcileResult['failed'] }
  > {
    const { policy, applied, failed } = await this.setPolicy(clusterId, ports);
    return { ...toView(policy), applied: applied.length, failed };
  }

  async setPolicy(
    clusterId: string,
    ports: EgressPort[] | null,
  ): Promise<{ policy: EgressPolicy | null } & EgressReconcileResult> {
    const policy = ports ? { ports: normalizeEgressPorts(ports) } : null;
    await this.policyOf(clusterId);
    await this.clusters.update(clusterId, { egressPolicy: policy });
    return { policy, ...(await this.reconcile(clusterId)) };
  }

  /**
   * Writes the rule into one namespace, or removes it where the rule is open.
   * Throws on failure: a deploy that went ahead without the fence would run
   * unrestricted under a rule that says otherwise.
   */
  async applyTo(
    kubeconfig: string,
    clusterId: string,
    namespace: string,
    isolated: boolean,
  ): Promise<void> {
    const manifest = buildEgressNetworkPolicy(
      namespace,
      await this.policyOf(clusterId),
      {
        isolated,
        internalCidrs: clusterInternalCidrs(process.env.FLUI_SUBNET_IP_RANGE),
      },
    );
    if (manifest) {
      await this.k8s.applyManifest(kubeconfig, manifest);
    } else {
      await this.k8s.deleteResource(
        kubeconfig,
        'NetworkPolicy',
        EGRESS_POLICY_NAME,
        namespace,
      );
    }
  }

  async reconcile(clusterId: string): Promise<EgressReconcileResult> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${clusterId} not found or kubeconfig missing`,
      );
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);

    const rows = await this.applications.find({
      where: { clusterId, systemProtected: Not(true), deletedAt: IsNull() },
      select: ['id', 'k8sNamespace'],
    });
    const areas = await this.k8s.listNamespaces(
      kubeconfig,
      `${SANDBOX_LABEL}=true`,
    );
    const namespaces = new Set<string>([
      ...rows.map((r) => r.k8sNamespace).filter(Boolean),
      ...areas.map((ns) => ns.metadata?.name).filter(Boolean),
    ]);

    const result: EgressReconcileResult = { applied: [], failed: [] };
    for (const namespace of [...namespaces].sort((a, b) =>
      a.localeCompare(b),
    )) {
      try {
        const ns = await this.k8s.getResource(
          kubeconfig,
          'Namespace',
          namespace,
        );
        if (!ns) continue;
        const labels: Record<string, string> = ns.metadata?.labels ?? {};
        if (isSystemNamespace(labels)) continue;
        await this.applyTo(
          kubeconfig,
          clusterId,
          namespace,
          labels[SANDBOX_LABEL] === 'true',
        );
        result.applied.push(namespace);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Egress rule not written in ${namespace}: ${message}`);
        result.failed.push({ namespace, error: message });
      }
    }
    return result;
  }
}
