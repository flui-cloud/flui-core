import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThan, Repository } from 'typeorm';
import { UserEntity } from '../../../auth/entities/user.entity';
import { UserEventsGateway } from '../../../auth/gateway/user-events.gateway';
import { ClusterEntity } from '../entities/cluster.entity';
import { ScalingDecisionEntity } from '../../scaling/entities/scaling-decision.entity';
import { scalingBellOf } from '../../scaling/services/scaling-bell.core';

/**
 * The scaling log's news, on the bell of the people who run the instance —
 * the same people a cluster alarm mails, since a fleet is nobody's
 * application.
 */
@Injectable()
export class ScalingBellService {
  private readonly logger = new Logger(ScalingBellService.name);

  constructor(
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ScalingDecisionEntity)
    private readonly decisions: Repository<ScalingDecisionEntity>,
    private readonly userEvents: UserEventsGateway,
  ) {}

  /** Never throws: a bell that cannot ring must not undo what it rings about. */
  async ring(row: ScalingDecisionEntity): Promise<void> {
    try {
      const previous =
        row.force === 'urgency' || row.force === 'opportunity'
          ? await this.decisions.findOne({
              where: {
                groupId: row.groupId,
                force: In(['urgency', 'opportunity']),
                at: LessThan(row.at),
              },
              order: { at: 'DESC' },
            })
          : null;
      const cluster = await this.clusters.findOne({
        where: { id: row.clusterId },
        select: { id: true, name: true },
      });
      const bell = scalingBellOf(row, previous, cluster?.name ?? 'Cluster');
      if (!bell) return;
      const admins = await this.users.find({
        where: { isAdmin: true },
        select: { id: true },
      });
      for (const admin of admins) this.userEvents.emitScaling(admin.id, bell);
    } catch (err) {
      this.logger.warn(
        `[scaling-bell] ${row.outcome} not announced: ${(err as Error).message}`,
      );
    }
  }
}
