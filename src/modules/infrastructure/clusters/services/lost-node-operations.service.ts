import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Queue } from 'bull';
import { HostCommandService } from 'src/modules/providers/core/host/host-command.service';
import {
  InfrastructureOperationEntity,
  OperationStatus,
} from '../../servers/entities/infrastructure-operations.entity';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeStatus } from '../entities/cluster-node.entity';
import { lostOperations } from '../../../applications/utils/lost-operations.core';
import {
  NODE_OPERATIONS,
  Uncordon,
  lostNodeOperationMessage,
} from './lost-node-operations.core';

/**
 * Closes the node operations no job carries any more, once a minute on the
 * copy that runs the scheduled work, and puts the node of a lost removal back
 * in service.
 */
@Injectable()
export class LostNodeOperationsService {
  private readonly logger = new Logger(LostNodeOperationsService.name);
  private running = false;

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operations: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
    @InjectQueue('infrastructure') private readonly queue: Queue,
    private readonly hostCommand: HostCommandService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.closeLost();
    } catch (err) {
      this.logger.warn(`[lost-node-ops] ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Closes every node operation no job carries any more; returns how many. */
  async closeLost(now = new Date()): Promise<number> {
    const inFlight = await this.operations.find({
      where: {
        operationType: In(NODE_OPERATIONS),
        status: In([OperationStatus.PENDING, OperationStatus.IN_PROGRESS]),
      },
    });
    if (!inFlight.length) return 0;

    const jobs = await this.queue.getJobs([
      'waiting',
      'active',
      'delayed',
      'paused',
    ]);
    const live = new Set(
      jobs
        .map(
          (job) =>
            (job?.data as { operationId?: string } | undefined)?.operationId,
        )
        .filter((id): id is string => typeof id === 'string'),
    );

    const lost = new Set(
      lostOperations(inFlight, live, now).map((row) => row.id),
    );
    for (const op of inFlight.filter((row) => lost.has(row.id))) {
      await this.close(op);
    }
    if (lost.size) {
      this.logger.warn(
        `[lost-node-ops] closed ${lost.size} node operation(s) no job was running`,
      );
    }
    return lost.size;
  }

  private async close(op: InfrastructureOperationEntity): Promise<void> {
    const meta = (op.metadata ?? {}) as { nodeId?: string; nodeName?: string };
    const uncordon = meta.nodeId
      ? await this.putBack(op.resourceId, meta.nodeId)
      : 'not-attempted';
    const message = lostNodeOperationMessage(
      { operationType: op.operationType, nodeName: meta.nodeName ?? null },
      uncordon,
    );
    await this.operations.update(op.id, {
      status: OperationStatus.FAILED,
      errorMessage: message,
      completedAt: new Date(),
    });
  }

  /** A node Flui had not started deleting goes back to taking work. */
  private async putBack(
    clusterId: string | null | undefined,
    nodeId: string,
  ): Promise<Uncordon> {
    const node = await this.nodes.findOne({ where: { id: nodeId } });
    if (!node || node.status === NodeStatus.DELETING) return 'not-attempted';
    const cluster = clusterId
      ? await this.clusters.findOne({ where: { id: clusterId } })
      : null;
    if (!cluster?.masterIpAddress) return 'failed';
    try {
      await this.hostCommand.run(
        { host: cluster.masterIpAddress, port: 22, user: 'root' },
        `kubectl uncordon ${node.serverName}`,
        { timeoutMs: 30000 },
      );
      return 'done';
    } catch (err) {
      this.logger.warn(
        `[lost-node-ops] could not uncordon ${node.serverName}: ${(err as Error).message}`,
      );
      return 'failed';
    }
  }
}
