import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';
import { HostCommandService } from '../../../providers/core/host/host-command.service';
import {
  deriveHostTargets,
  HostTarget,
} from '../../../providers/core/host/host-targets';
import { WireGuardPeerService } from './wireguard-peer.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import {
  buildSanEnrolmentScript,
  buildSanReadScript,
  parseCertificateIps,
  SAN_APPLIED_MARKER,
  SAN_PRESENT_MARKER,
  SAN_ROLLED_BACK_MARKER,
  SAN_UNSUPPORTED_MARKER,
} from '../api-server-san';

export type SanEnrolmentOutcome =
  | 'already-present'
  | 'applied'
  | 'unsupported'
  | 'rolled-back';

export interface SanEnrolmentResult {
  outcome: SanEnrolmentOutcome;
  address: string;
  host: string;
  /** What the certificate covers now, read back from the master itself. */
  certificateIps: string[];
}

/**
 * Brings a cluster built before the overlay existed onto it.
 *
 * This restarts K3s on a live master, because K3s regenerates the API server's
 * serving certificate only when the file is gone — so a cluster whose
 * certificate predates its management address cannot be reached through the
 * tunnel until that certificate is rebuilt.
 *
 * Hence the shape: refuse unless the tunnel is already proven, prove the
 * certificate really was regenerated rather than trusting a readiness probe,
 * and roll the master back to exactly what it had if it does not come up.
 */
@Injectable()
export class ApiServerSanService {
  private readonly logger = new Logger(ApiServerSanService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectQueue('infrastructure') private readonly queue: Queue,
    private readonly peerService: WireGuardPeerService,
    private readonly hostCommand: HostCommandService,
  ) {}

  /**
   * Queues the enrolment as a tracked operation.
   *
   * The preconditions are checked here, synchronously, so an operator who asks
   * for something that cannot work is told immediately instead of watching an
   * operation fail. Only the part that restarts a master goes to the queue —
   * because it takes minutes, because it must survive the request that started
   * it, and because its failure belongs in the operation record rather than in
   * whoever happened to be holding the connection.
   */
  async enrolOverlayAddressAsync(
    clusterId: string,
  ): Promise<InfrastructureOperationEntity> {
    const { cluster, address } = await this.preflight(clusterId);

    const operation = await this.operations.save(
      this.operations.create({
        operationType: OperationType.ENROL_CLUSTER_OVERLAY,
        resourceType: 'cluster',
        resourceId: clusterId,
        status: OperationStatus.PENDING,
        progress: 0,
        currentStepIndex: 0,
        totalSteps: 0,
        metadata: {
          clusterName: cluster.name,
          managementAddress: address,
          estimatedDurationInSeconds: 180,
        },
      }),
    );

    await this.queue.add(
      'enrol-cluster-overlay',
      { operationId: operation.id, clusterId },
      {
        // Deliberately once. A retry would restart a live master a second time
        // after a failure whose cause nobody has looked at yet.
        attempts: 1,
        timeout: 600_000,
      },
    );
    this.logger.log(
      `[san] queued overlay enrolment for ${cluster.name} (${address})`,
    );
    return operation;
  }

  /**
   * Adds this cluster's management address to its API server certificate.
   *
   * Refuses on a peer that merely exists. A row is not a tunnel: enrolling a
   * certificate for an address nothing has ever handshaken on would restart a
   * live master to reach an endpoint that does not answer.
   */
  async enrolOverlayAddress(clusterId: string): Promise<SanEnrolmentResult> {
    const { cluster, master, address } = await this.preflight(clusterId);

    const target = this.targetFor(cluster, master);
    const out = await this.hostCommand.run(
      target,
      buildSanEnrolmentScript(address),
      // Longer than the script's own wait, or the transport would give up
      // mid-rollback and leave nobody watching the master come back.
      { timeoutMs: 420_000, certTtlSeconds: 600 },
    );

    const outcome = this.outcomeOf(out);
    if (outcome === 'rolled-back') {
      throw new BadRequestException(
        `${cluster.name}'s API server did not come back with the new address, ` +
          `so the master was restored to the certificate and configuration it ` +
          `had. Nothing was repointed at ${address}.`,
      );
    }

    const certificateIps = await this.readCertificateIps(target);
    this.logger.log(
      `[san] ${cluster.name}: ${outcome} for ${address} ` +
        `(certificate now covers ${certificateIps.join(', ')})`,
    );
    return { outcome, address, host: target.host, certificateIps };
  }

  /**
   * Everything that must be true before a live master is restarted.
   *
   * Shared by the queued path and the direct one so the two can never disagree
   * about what makes this safe.
   */
  private async preflight(clusterId: string): Promise<{
    cluster: ClusterEntity;
    master: ClusterNodeEntity;
    address: string;
  }> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    if (cluster.status !== ClusterStatus.READY) {
      throw new BadRequestException(
        `Cluster ${cluster.name} is ${cluster.status}. This restarts K3s on its ` +
          `master, which is only safe on a cluster that is otherwise healthy.`,
      );
    }

    const master = (cluster.nodes ?? []).find(
      (n) => n.nodeType === NodeType.MASTER,
    );
    if (!master) {
      throw new BadRequestException(
        `Cluster ${cluster.name} has no master node recorded`,
      );
    }

    const overlay = await this.peerService.nodeOverlayFor(master.id);
    if (!overlay) {
      throw new BadRequestException(
        `The management overlay is off, or ${cluster.name}'s master has no ` +
          `address reserved on it.`,
      );
    }
    if (!overlay.enrolled) {
      throw new BadRequestException(
        `${cluster.name}'s master has not handshaken on ${overlay.nodeAddress} ` +
          `yet. Restarting K3s to reach an address that has never carried a ` +
          `packet would risk the cluster for nothing — wait for the tunnel.`,
      );
    }
    return { cluster, master, address: overlay.nodeAddress };
  }

  /** What the master's certificate covers today — read from the master, not
   *  from what Flui believes it asked for. */
  async readCertificateIps(target: HostTarget): Promise<string[]> {
    const out = await this.hostCommand.run(target, buildSanReadScript());
    if (out.includes(SAN_UNSUPPORTED_MARKER)) return [];
    return parseCertificateIps(out);
  }

  private outcomeOf(output: string): SanEnrolmentOutcome {
    if (output.includes(SAN_ROLLED_BACK_MARKER)) return 'rolled-back';
    if (output.includes(SAN_APPLIED_MARKER)) return 'applied';
    if (output.includes(SAN_PRESENT_MARKER)) return 'already-present';
    if (output.includes(SAN_UNSUPPORTED_MARKER)) return 'unsupported';
    throw new Error(
      `The master answered without any outcome marker: ${output.trim().slice(-200)}`,
    );
  }

  /**
   * The SSH endpoint of this specific node.
   *
   * Matched on host rather than taken as "the first target": pushing a restart
   * of K3s to the wrong machine is not a mistake worth risking to save a lookup.
   */
  private targetFor(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): HostTarget {
    const targets = deriveHostTargets(cluster);
    const byosHost = (node.metadata as { byos?: { host?: string } } | undefined)
      ?.byos?.host;
    const target =
      (byosHost && targets.find((t) => t.host === byosHost)) ||
      (node.ipAddress && targets.find((t) => t.host === node.ipAddress));
    if (!target) {
      throw new BadRequestException(
        `No SSH endpoint for ${cluster.name}'s master among the cluster's own`,
      );
    }
    return target;
  }
}
