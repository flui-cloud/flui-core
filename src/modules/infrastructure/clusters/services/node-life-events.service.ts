import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ScalingGroupEntity } from '../../scaling/entities/scaling-group.entity';
import { ScalingDecisionEntity } from '../../scaling/entities/scaling-decision.entity';
import {
  NodeEventFacts,
  nodeEventText,
} from '../../scaling/services/node-events.core';
import { ScalingBellService } from './scaling-bell.service';

export interface NodeLifeEvent extends NodeEventFacts {
  clusterId: string;
  operationId?: string | null;
  hourlyPriceEur?: number | null;
}

/**
 * What happened to a machine, written beside the group's decisions so the log
 * shows a purchase from its order to the node taking work, and a removal to
 * the server gone at the provider — whether the group or a person asked.
 */
@Injectable()
export class NodeLifeEventsService {
  private readonly logger = new Logger(NodeLifeEventsService.name);

  constructor(
    @InjectRepository(ScalingGroupEntity)
    private readonly groups: Repository<ScalingGroupEntity>,
    @InjectRepository(ScalingDecisionEntity)
    private readonly decisions: Repository<ScalingDecisionEntity>,
    private readonly bell: ScalingBellService,
  ) {}

  /** Never throws: the log is a record of the operation, not a step of it. */
  async record(event: NodeLifeEvent): Promise<ScalingDecisionEntity | null> {
    try {
      const group = await this.groups.findOne({
        where: { clusterId: event.clusterId },
        order: { createdAt: 'ASC' },
      });
      if (!group) return null;
      const text = nodeEventText(event);
      const saved = await this.decisions.save(
        this.decisions.create({
          groupId: group.id,
          clusterId: event.clusterId,
          at: new Date(),
          force: 'fleet',
          outcome: event.event,
          saw: text.saw,
          did: text.did,
          why: text.why,
          asks: null,
          shape: event.shape ?? null,
          region: event.region ?? null,
          hourlyPriceEur: event.hourlyPriceEur ?? null,
          considered: [],
          pendingPods: null,
          drain: null,
          operationId: event.operationId ?? null,
        }),
      );
      await this.bell.ring(saved);
      return saved;
    } catch (err) {
      this.logger.warn(
        `[node-events] ${event.event} on cluster ${event.clusterId} not recorded: ${(err as Error).message}`,
      );
      return null;
    }
  }
}
