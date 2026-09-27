import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import { ProviderFactory } from 'src/modules/providers';
import { AccessService } from 'src/modules/access/services/access.service';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import { NativeSSHConnectionService } from '../../../terminal/services/native-ssh-connection.service';
import { FirewallReconciliationService } from '../../firewalls/services/firewall-reconciliation.service';
import { FirewallRuleDto } from '../../../providers/dto/firewall.dto';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';

export const RECOVERY_RULE = 'flui:recover-access';
const RESCUE_USER = 'debian';
const DONE = 'FLUI_RECOVER_DONE';
const NO_DISK = 'FLUI_RECOVER_NO_DISK';

export interface RecoverNodeAccessJob {
  operationId: string;
  clusterId: string;
  nodeId: string;
  sourceIp: string | null;
}

interface OvhRescue {
  rescueForRecovery(
    serverId: string,
  ): Promise<{ region: string; image: string }>;
  unrescue(serverId: string, region: string): Promise<void>;
  rescueStatus(serverId: string, region: string): Promise<string | null>;
}

/**
 * On the node's own disk, from a rescue system: stop Flui's host firewall from
 * loading at the next boot. Found by label, never by device name, and refused
 * when the only disk with that label is the one the rescue booted from.
 */
export function buildRescueRepairScript(): string {
  return [
    'set -e',
    'DEV=$(sudo blkid -L cloudimg-rootfs 2>/dev/null || true)',
    'ROOT=$(findmnt -n -o SOURCE / || true)',
    `if [ -z "$DEV" ] || [ "$DEV" = "$ROOT" ]; then echo ${NO_DISK}; exit 0; fi`,
    'sudo mkdir -p /mnt/flui-root',
    'sudo mount "$DEV" /mnt/flui-root',
    'sudo rm -f /mnt/flui-root/etc/systemd/system/multi-user.target.wants/flui-firewall.service',
    'sudo umount /mnt/flui-root',
    `echo ${DONE}`,
    '',
  ].join('\n');
}

/**
 * The emergency way back into a node when SSH is closed, through the
 * provider's API rather than the node's network. Asynchronous and recorded:
 * a rescue reboots the node twice and takes minutes.
 */
@Injectable()
export class NodeAccessRecoveryService {
  private readonly logger = new Logger(NodeAccessRecoveryService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly queue: Queue,
    private readonly providers: ProviderFactory,
    private readonly access: AccessService,
    private readonly nativeSsh: NativeSSHConnectionService,
    private readonly firewall: FirewallReconciliationService,
  ) {}

  async start(
    clusterId: string,
    nodeRef: string,
    sourceIp: string | null,
    by: string,
  ): Promise<InfrastructureOperationEntity> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    const node = (cluster.nodes ?? []).find(
      (n) => n.id === nodeRef || n.serverName === nodeRef,
    );
    if (!node)
      throw new NotFoundException(
        `Node ${nodeRef} not found in ${cluster.name}`,
      );
    this.assertSupported(cluster, node, sourceIp);

    const operation = await this.operations.save(
      this.operations.create({
        operationType: OperationType.RECOVER_NODE_ACCESS,
        resourceType: 'cluster',
        resourceId: cluster.id,
        resourceName: cluster.name,
        provider: cluster.provider as never,
        status: OperationStatus.PENDING,
        progress: 0,
        currentStepIndex: 0,
        totalSteps: 0,
        metadata: {
          nodeId: node.id,
          nodeName: node.serverName,
          initiatedBy: by,
          estimatedDurationInSeconds:
            cluster.provider === CloudProvider.OVH ? 600 : 30,
        },
      }),
    );
    const job: RecoverNodeAccessJob = {
      operationId: operation.id,
      clusterId: cluster.id,
      nodeId: node.id,
      sourceIp,
    };
    // Once: a second rescue on top of a half-finished one is how a node ends
    // up booted from the wrong disk.
    await this.queue.add('recover-node-access', job, {
      attempts: 1,
      timeout: 1_800_000,
    });
    return operation;
  }

  private assertSupported(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
    sourceIp: string | null,
  ): void {
    const provider = cluster.provider as CloudProvider;
    if (provider === CloudProvider.BYOS) {
      throw new BadRequestException(
        'This is a machine you brought: the way back into it is its own console or provider, which Flui does not hold.',
      );
    }
    if (provider === CloudProvider.OVH) {
      if (!node.providerResourceId) {
        throw new BadRequestException(
          `${node.serverName} has no server id at OVH to rescue.`,
        );
      }
      return;
    }
    if (
      provider === CloudProvider.HETZNER ||
      provider === CloudProvider.SCALEWAY
    ) {
      if (!sourceIp) {
        throw new BadRequestException(
          'Name the address to let in (your public address): the provider firewall is opened to it alone.',
        );
      }
      return;
    }
    throw new BadRequestException(
      `Flui has no emergency path for ${cluster.provider} yet.`,
    );
  }

  async run(job: RecoverNodeAccessJob): Promise<void> {
    const operation = await this.operations.findOne({
      where: { id: job.operationId },
    });
    if (!operation) throw new Error(`Operation ${job.operationId} not found`);
    await this.progress(operation, 5, 'Starting', OperationStatus.IN_PROGRESS);
    try {
      const cluster = await this.clusters.findOne({
        where: { id: job.clusterId },
        relations: ['nodes'],
      });
      const node = cluster?.nodes?.find((n) => n.id === job.nodeId);
      if (!cluster || !node) throw new Error('The cluster or the node is gone');

      const outcome =
        (cluster.provider as CloudProvider) === CloudProvider.OVH
          ? await this.viaRescue(cluster, node, operation)
          : await this.viaProviderFirewall(
              cluster,
              job.sourceIp as string,
              operation,
            );

      operation.status = OperationStatus.COMPLETED;
      operation.progress = 100;
      operation.completedAt = new Date();
      operation.metadata = { ...operation.metadata, outcome };
      await this.operations.save(operation);
    } catch (error) {
      operation.status = OperationStatus.FAILED;
      operation.completedAt = new Date();
      operation.metadata = {
        ...operation.metadata,
        error: (error as Error).message,
      };
      await this.operations.save(operation);
      this.logger.error(
        `[recover-access] ${job.clusterId}/${job.nodeId}: ${(error as Error).message}`,
      );
    }
  }

  /** Hetzner, Scaleway: port 22 opened on the provider firewall to one address. */
  private async viaProviderFirewall(
    cluster: ClusterEntity,
    sourceIp: string,
    operation: InfrastructureOperationEntity,
  ): Promise<string> {
    const fw = await this.firewall.ensureClusterFirewall(cluster.id);
    const cidr = sourceIp.includes(':') ? `${sourceIp}/128` : `${sourceIp}/32`;
    const rule: FirewallRuleDto = {
      description: RECOVERY_RULE,
      direction: 'in',
      protocol: 'tcp',
      port: '22',
      sourceIps: [cidr],
    };
    const kept = (fw.desiredRules ?? []).filter(
      (r) => r.description !== RECOVERY_RULE,
    );
    await this.progress(
      operation,
      50,
      `Opening port 22 to ${cidr} on the provider firewall`,
    );
    await this.firewall.updateAndApplyRules(fw.id, [...kept, rule]);
    return `Port 22 is open to ${cidr} on ${cluster.name}'s provider firewall. Remove it once you are back in (\`flui env update-firewall\`).`;
  }

  /** OVH: rescue from Debian, stop Flui's host firewall on the node's disk, boot it again, re-apply the firewall. */
  private async viaRescue(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
    operation: InfrastructureOperationEntity,
  ): Promise<string> {
    const ovh = this.providers.getProvider(
      CloudProvider.OVH,
    ) as unknown as OvhRescue;
    const key = await this.access.getBootstrapKeyMaterialForCluster(cluster.id);
    if (!key) {
      throw new Error(
        `${cluster.name} has no bootstrap key left, which is the only key the rescue system accepts. Use the provider console instead.`,
      );
    }
    const serverId = node.providerResourceId as string;
    const host = node.ipAddress as string;

    await this.progress(
      operation,
      10,
      'Booting the node from a Debian rescue image',
    );
    const { region, image } = await ovh.rescueForRecovery(serverId);
    await this.waitForStatus(ovh, serverId, region, 'RESCUE');

    try {
      await this.progress(
        operation,
        40,
        `Repairing the node's disk from ${image}`,
      );
      const out = await this.retry(() =>
        this.nativeSsh.execCommand(
          host,
          RESCUE_USER,
          key.privateKey,
          buildRescueRepairScript(),
          120_000,
        ),
      );
      if (out.includes(NO_DISK)) {
        throw new Error(
          "The node's own disk could not be told apart from the rescue disk; nothing was changed",
        );
      }
      if (!out.includes(DONE)) throw new Error('The repair did not finish');
    } finally {
      await this.progress(
        operation,
        70,
        'Booting the node from its own disk again',
      );
      await ovh.unrescue(serverId, region);
      await this.waitForStatus(ovh, serverId, region, 'ACTIVE');
    }

    await this.progress(operation, 85, 'Applying the host firewall again');
    await this.retry(() => this.firewall.ensureClusterFirewall(cluster.id));
    return `${node.serverName} was rescued from ${image}, its host firewall was reset and applied again.`;
  }

  private async waitForStatus(
    ovh: OvhRescue,
    serverId: string,
    region: string,
    wanted: string,
  ): Promise<void> {
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      const status = await ovh.rescueStatus(serverId, region).catch(() => null);
      if (status === wanted) return;
      if (status === 'ERROR')
        throw new Error(`The node went to ERROR instead of ${wanted}`);
      await sleep(10_000);
    }
    throw new Error(`The node did not reach ${wanted} within 10 minutes`);
  }

  /** The rescue boots before sshd answers; a few refusals are expected. */
  private async retry<T>(call: () => Promise<T>, attempts = 12): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await call();
      } catch (error) {
        last = error;
        await sleep(10_000);
      }
    }
    throw last instanceof Error ? last : new Error('The node did not answer');
  }

  private async progress(
    operation: InfrastructureOperationEntity,
    progress: number,
    message: string,
    status?: OperationStatus,
  ): Promise<void> {
    operation.progress = progress;
    if (status) operation.status = status;
    if (status === OperationStatus.IN_PROGRESS)
      operation.startedAt = new Date();
    operation.metadata = { ...operation.metadata, message };
    await this.operations.save(operation);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
