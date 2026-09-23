import { Injectable, Logger } from '@nestjs/common';
import { AlertEventsService } from '../../../observability/services/alert-events.service';
import { ScalingGroupEntity } from '../entities/scaling-group.entity';

/** An alarm as it was raised, kept so that resolving it does not erase the ask. */
interface Raised {
  startsAt: Date;
  description: string;
  asks: string;
}

/** The part of a decision an alarm carries: what was seen, what was asked for. */
export interface AlarmWorthyDecision {
  outcome?: string;
  saw?: string;
  did?: string;
  why?: string;
}

/**
 * Carries a scaling alarm out of the decision log.
 *
 * The engine has always written down that it wanted a node and could not have
 * one, and that row has always stayed where only someone already looking would
 * find it. An alarm nobody is told about is the same as no alarm, so each one
 * now goes onto the same rail as every other alert in the installation, and
 * clears itself the moment a later decision no longer asks for anything.
 */
@Injectable()
export class ScalingAlarmService {
  private readonly logger = new Logger(ScalingAlarmService.name);

  /**
   * One alarm per group: a repeat is the same alarm still unanswered, not a new
   * one. What it asked for is held with it, because a resolved alarm that no
   * longer says what it wanted cannot be read back afterwards.
   */
  private readonly firing = new Map<string, Raised>();

  constructor(private readonly alerts: AlertEventsService) {}

  async publish(
    group: ScalingGroupEntity,
    decision: AlarmWorthyDecision,
  ): Promise<void> {
    const fingerprint = `flui-scaling-${group.id}`;

    if (decision.outcome !== 'alerted') {
      await this.clear(fingerprint, group);
      return;
    }

    // Keeping the original start makes the repeat the same alarm: how long it
    // has gone unanswered is the part a reader acts on.
    const raised: Raised = {
      startsAt: this.firing.get(fingerprint)?.startsAt ?? new Date(),
      description: decision.saw ?? 'Scaling could not do what it wanted.',
      asks: decision.did ?? 'unstated',
    };
    this.firing.set(fingerprint, raised);

    await this.send(fingerprint, 'firing', group, raised);
  }

  private async clear(
    fingerprint: string,
    group: ScalingGroupEntity,
  ): Promise<void> {
    const raised = this.firing.get(fingerprint);
    if (!raised) return;
    this.firing.delete(fingerprint);
    // Resolved carries what it asked for, not a sentence about being over: an
    // alarm read after the fact is only useful if it still says what it wanted.
    await this.send(fingerprint, 'resolved', group, raised);
  }

  private async send(
    fingerprint: string,
    status: 'firing' | 'resolved',
    group: ScalingGroupEntity,
    raised: Raised,
  ): Promise<void> {
    try {
      await this.alerts.record([
        {
          fingerprint,
          status,
          startsAt: raised.startsAt,
          endsAt: status === 'resolved' ? new Date() : null,
          alertname: 'FluiScalingNeedsPerson',
          // Not critical: the cluster is short of room, which is a thing to
          // answer today rather than to be woken for.
          severity: 'warning',
          fluiKind: 'scaling',
          clusterId: group.clusterId,
          labels: {
            flui_kind: 'scaling',
            scaling_group: group.name,
            scaling_group_id: group.id,
            cluster_id: group.clusterId,
          },
          annotations: {
            summary: `Scaling on ${group.name} is waiting for a person`,
            description: raised.description,
            asks: raised.asks,
          },
        },
      ]);
    } catch (error) {
      // An alarm that cannot be delivered must not stop the loop that found it:
      // the decision is already written down, which is where it was before.
      this.logger.warn(
        `Scaling alarm for group ${group.id} could not be delivered: ${(error as Error).message}`,
      );
    }
  }
}
